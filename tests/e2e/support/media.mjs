import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const outputRoot = path.join(projectRoot, '.local', 'qa');
const execute = promisify(execFile);

/** Docker is a one-shot fallback, never a fixture service or production container. */
export async function ffmpegRuntime() {
  const executable = process.env.STV_QA_FFMPEG ?? 'ffmpeg';
  const probe =
    executable === 'docker'
      ? { status: 1 }
      : spawnSync(executable, ['-version'], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10000,
        });
  if (probe.status === 0)
    return {
      description: executable,
      run: (args, cwd) =>
        execute(executable, args, {
          cwd,
          windowsHide: true,
          timeout: 120000,
          maxBuffer: 8 * 1024 ** 2,
        }),
      launch: (args) =>
        spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      close: async () => {},
    };
  if (process.env.STV_QA_FFMPEG && executable !== 'docker')
    throw new Error(`Configured FFmpeg is unavailable: ${executable}`);
  const image = process.env.STV_QA_IMAGE ?? 'st-vault:local';
  try {
    await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(
      `Install FFmpeg or build Docker image ${image} before browser QA. ${error.message}`,
      { cause: error },
    );
  }
  const uid = process.getuid?.() || 1000,
    gid = process.getgid?.() || 1000;
  const removals = new Set(),
    active = new Map();
  const common = [
    'run',
    '--rm',
    '-i',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    `${uid}:${gid}`,
    '--pids-limit',
    '128',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--entrypoint',
    'ffmpeg',
  ];
  const remove = async (name) => {
    try {
      await execute('docker', ['rm', '--force', name], { windowsHide: true, timeout: 15000 });
    } catch (error) {
      if (!String(error.stderr).includes('No such container')) throw error;
    }
  };
  const trackRemoval = (name) => {
    const task = remove(name);
    removals.add(task);
    void task.then(
      () => removals.delete(task),
      (error) => {
        console.error(`[qa] Docker cleanup failed for ${name}: ${error.message}`);
      },
    );
  };
  return {
    description: `docker:${image}`,
    run: async (args, cwd) => {
      const name = `stv-qa-media-${randomUUID()}`;
      try {
        return await execute(
          'docker',
          [
            ...common,
            '--name',
            name,
            '--volume',
            `${cwd}:/media`,
            '--workdir',
            '/media',
            image,
            ...args,
          ],
          { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 ** 2 },
        );
      } finally {
        await remove(name);
      }
    },
    launch: (args) => {
      const name = `stv-qa-decode-${randomUUID()}`;
      const child = spawn('docker', [...common, '--name', name, image, ...args], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      active.set(name, child);
      child.once('close', () => {
        active.delete(name);
        trackRemoval(name);
      });
      return child;
    },
    close: async () => {
      await Promise.all([...active.keys()].map(remove));
      await Promise.all([...removals]);
    },
  };
}

export async function generateMedia(runtime) {
  const directory = path.join(outputRoot, 'media');
  await mkdir(directory, { recursive: true });
  const base = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-threads',
    '1',
    '-filter_threads',
    '1',
  ];
  await runtime.run(
    [
      ...base,
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24',
      '-t',
      '10',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '48',
      '-keyint_min',
      '48',
      '-sc_threshold',
      '0',
      '-threads',
      '1',
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-hls_segment_filename',
      'seg%d.m4s',
      'stream.m3u8',
    ],
    directory,
  );
  for (const [name, size] of [
    ['landscape', '640x360'],
    ['portrait', '360x640'],
  ]) {
    await runtime.run(
      [
        ...base,
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=1`,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-update',
        '1',
        `${name}.jpg`,
      ],
      directory,
    );
  }
  const playlist = await readFile(path.join(directory, 'stream.m3u8'), 'utf8');
  const segments = [...playlist.matchAll(/#EXTINF:([\d.]+),\r?\n(seg\d+\.m4s)/g)].map((match) => ({
    name: match[2],
    durationSeconds: Number(match[1]),
  }));
  const durationSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  assert(segments.length >= 4 && segments.length <= 6, 'Synthetic HLS must contain 4–6 fragments');
  assert(durationSeconds >= 8 && durationSeconds <= 12, 'Synthetic HLS must span 8–12 seconds');
  const files = new Map();
  for (const name of [
    'init.mp4',
    'landscape.jpg',
    'portrait.jpg',
    ...segments.map((segment) => segment.name),
  ])
    files.set(name, await readFile(path.join(directory, name)));
  const manifest = {
    synthetic: true,
    generator: 'ffmpeg testsrc2',
    runtime: runtime.description,
    durationSeconds,
    segments,
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `[qa] Generated ${durationSeconds}s synthetic fMP4 HLS (${segments.length} fragments), landscape/portrait JPEG via ${runtime.description}`,
  );
  return { directory, files, segments, durationSeconds };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let runtime;
  try {
    runtime = await ffmpegRuntime();
    await generateMedia(runtime);
  } catch (error) {
    console.error(`[qa] Media generation failed: ${error.stack ?? error}`);
    process.exitCode = 1;
  } finally {
    await runtime?.close();
  }
}
