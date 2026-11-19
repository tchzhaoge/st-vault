import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constants, getPriority } from 'node:os';
import { afterEach, describe, it, expect } from 'vitest';
import { createFfmpegDecoder, decoderArgs, verifyJpeg } from './ffmpeg.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function files(): Promise<string[]> {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-frame-pipe-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic-input.mp4');
  await writeFile(file, Buffer.from('synthetic-pipe-test'));
  return [file];
}
describe('owned bounded snapshot child process', () => {
  it('fully decodes generated JPEGs before accepting them and rejects empty/corrupt output', async () => {
    for (const size of [256, 0]) {
      const launch = (): ChildProcessWithoutNullStreams =>
        spawn(
          process.execPath,
          [
            '-e',
            `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(${size})));`,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        );
      const operation = verifyJpeg(
        Buffer.from([255, 216, 255, 217]),
        new AbortController().signal,
        { launch },
      );
      if (size === 256) await expect(operation).resolves.toBeUndefined();
      else await expect(operation).rejects.toMatchObject({ code: 'failed' });
    }
  });
  it('runs the decoder at below-normal process priority', async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const decoder = createFfmpegDecoder({
      launch: () => {
        child = spawn(
          process.execPath,
          [
            '-e',
            "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(Buffer.from([255,216,255,217])),500));",
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        );
        return child;
      },
    });
    const input = await files(),
      result = decoder({
        paths: input,
        offsetSeconds: 0,
        endSeconds: 0.5,
        signal: new AbortController().signal,
      });
    expect(child?.pid).toBeDefined();
    expect(getPriority(child?.pid)).toBe(constants.priority.PRIORITY_BELOW_NORMAL);
    await expect(result).resolves.toEqual(Buffer.from([255, 216, 255, 217]));
  });
  it('uses a single bounded software decoder and one-frame CPU scaling', () => {
    const args = decoderArgs(0, 1);
    expect(args.filter((arg) => arg === '-threads')).toHaveLength(2);
    expect(args[args.indexOf('-threads') + 1]).toBe('1');
    expect(args[args.indexOf('-filter_threads') + 1]).toBe('1');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'trim=start=0.000000:end=1.000000,scale=320:180:force_original_aspect_ratio=decrease',
    );
  });
  it('streams only local input with fixed pipe protocols and bounded exact-time trim', async () => {
    const args = decoderArgs(1.25, 1.75);
    expect(args).toContain('pipe:0');
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('pipe');
    expect(args[args.indexOf('-vf') + 1]).toContain('trim=start=1.250000:end=1.750000');
    expect(args.join(' ')).not.toContain('STARTPTS');
    const decoder = createFfmpegDecoder({
      launch: () =>
        spawn(
          process.execPath,
          [
            '-e',
            "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from([255,216,255,217])));",
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        ),
    });
    expect([
      ...(await decoder({
        paths: await files(),
        offsetSeconds: 1.25,
        endSeconds: 1.75,
        signal: new AbortController().signal,
      })),
    ]).toEqual([255, 216, 255, 217]);
  });
  it('kills and drains its own child on cancellation', async () => {
    let child: ChildProcessWithoutNullStreams | undefined, started: (() => void) | undefined;
    const launching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const decoder = createFfmpegDecoder({
        launch: () => {
          child = spawn(
            process.execPath,
            ['-e', 'process.stdin.resume();setInterval(()=>{},1000);'],
            { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
          );
          child.once('spawn', () => started?.());
          return child;
        },
      }),
      controller = new AbortController();
    const decoding = decoder({
      paths: await files(),
      offsetSeconds: 0,
      endSeconds: 0.5,
      signal: controller.signal,
    });
    const rejected = expect(decoding).rejects.toThrow('SNAPSHOT_DECODE_FAILED');
    await launching;
    controller.abort();
    await rejected;
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  });
  it('rejects oversized output and an unavailable executable without leaking decoder diagnostics', async () => {
    const paths = await files(),
      input = { paths, offsetSeconds: 0, endSeconds: 0.5, signal: new AbortController().signal };
    const decoder = createFfmpegDecoder({
      launch: () =>
        spawn(
          process.execPath,
          ['-e', 'process.stdin.resume();process.stdout.write(Buffer.alloc(600000,255));'],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        ),
    });
    await expect(decoder(input)).rejects.toMatchObject({ code: 'failed' });
    await expect(
      createFfmpegDecoder({ ffmpegPath: 'synthetic-missing-ffmpeg-binary' })(input),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('distinguishes a successful empty frame window from input errors and process failures', async () => {
    const launch =
      (script: string): (() => ChildProcessWithoutNullStreams) =>
      () =>
        spawn(process.execPath, ['-e', script], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
    const input = {
      paths: await files(),
      offsetSeconds: 0,
      endSeconds: 0.5,
      signal: new AbortController().signal,
    };
    const empty = createFfmpegDecoder({
      launch: launch("process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"),
    });
    await expect(empty(input)).rejects.toMatchObject({ code: 'no_frame' });
    const failed = createFfmpegDecoder({
      launch: launch("process.stdin.resume();process.stdin.on('end',()=>process.exit(2));"),
    });
    await expect(failed(input)).rejects.toMatchObject({ code: 'failed' });
    await expect(empty({ ...input, paths: ['synthetic-missing-media'] })).rejects.toMatchObject({
      code: 'failed',
    });
  });
});
