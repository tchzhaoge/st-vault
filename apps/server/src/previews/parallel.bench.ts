/** Isolated real decoder/validator/queue/publish benchmark. No production paths. */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { ScreenshotJobs } from './jobs.js';
import { createFfmpegDecoder, verifyJpeg } from './ffmpeg.js';
import type { SnapshotItem } from '@st-vault/api-schema';

const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ] ?? 0;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cpuMicros = async () =>
  Number(/^usage_usec (\d+)$/m.exec(await readFile('/sys/fs/cgroup/cpu.stat', 'utf8'))?.[1] ?? 0);
const run = async (args: string[]) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error(`FIXTURE_ENCODER_FAILED:${stderr.slice(0, 1000)}`)),
    );
  });
};
const root = await mkdtemp(path.join(tmpdir(), 'stv-parallel-previews-'));
try {
  const source = path.join(root, 'source.mp4');
  await run([
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-g',
    '30',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    source,
  ]);
  const decode = createFfmpegDecoder();
  await verifyJpeg(
    await decode({
      paths: [source],
      offsetSeconds: 0,
      endSeconds: 1,
      signal: AbortSignal.timeout(30000),
    }),
    AbortSignal.timeout(30000),
  );
  const matrix = (process.env.STV_BENCH_CONCURRENCY ?? '1,2,4,8').split(',').map(Number);
  if (matrix.some((value) => !Number.isInteger(value) || value < 1 || value > 64))
    throw Error('INVALID_BENCHMARK_CONCURRENCY');
  const summaries = [];
  let iteration = 0;
  for (const concurrency of matrix) {
    console.log(JSON.stringify({ event: 'parallel_preview_case_started', concurrency, iteration }));
    const current = path.join(root, 'c' + concurrency + '-' + iteration++),
      mediaRoot = path.join(current, 'media');
    await mkdir(path.join(mediaRoot, 'subjects'), { recursive: true });
    const units = new Map<string, SnapshotItem>();
    let allowed = false,
      active = 0,
      maximum = 0;
    const waits: number[] = [],
      renderTimes: number[] = [],
      httpTimes: number[] = [];
    const queue = await ScreenshotJobs.open({
      root: path.join(current, 'jobs'),
      mediaRoot,
      concurrency,
      pollMs: 10,
      auditMs: 60000,
      canGenerate: () => allowed,
      archive: {
        listSubjects: () => Promise.resolve([]),
        locate: () => Promise.resolve(null),
        snapshotUnit: (_subject, _at, unit) => Promise.resolve(units.get(unit ?? '') ?? null),
        hasMedia: () => Promise.resolve(true),
      },
      render: async (job, signal) => {
        active++;
        maximum = Math.max(maximum, active);
        waits.push(Math.max(0, Date.now() - job.created));
        const started = performance.now();
        try {
          return {
            bytes: await decode({ paths: [source], offsetSeconds: 0, endSeconds: 1, signal }),
            throughMs: job.end,
            mediaIds: ['synthetic-media'],
          };
        } finally {
          renderTimes.push(performance.now() - started);
          active--;
        }
      },
      validate: (bytes, signal) => verifyJpeg(bytes, signal),
    });
    const http = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(queue.status()));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw Error('BENCHMARK_SERVER_ADDRESS');
    let sampling = true,
      memoryPeakBytes = 0,
      samples = 0;
    const samplingWork = (async () => {
      while (sampling) {
        const before = performance.now();
        await fetch(`http://127.0.0.1:${address.port}`).then((response) => response.arrayBuffer());
        httpTimes.push(performance.now() - before);
        if (++samples % 10 === 0)
          memoryPeakBytes = Math.max(
            memoryPeakBytes,
            Number(await readFile('/sys/fs/cgroup/memory.current', 'utf8')),
          );
        await delay(10);
      }
    })();
    const enqueue = async (index: number, priority = 0) => {
      const item: SnapshotItem = {
        unitId: 'synthetic-' + index,
        atMs: 60000 + index * 1000,
        slotFromMs: 60000 + index * 1000,
        slotToMs: 60500 + index * 1000,
        url: '/synthetic',
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        open: false,
      };
      units.set(item.unitId, item);
      await queue.enqueue(`stripchat:${42 + (index % 12)}`, item, priority);
      return item;
    };
    try {
      for (let i = 0; i < 48; i++) await enqueue(i);
      const cpuBefore = await cpuMicros(),
        started = performance.now();
      allowed = true;
      await queue.enqueue('stripchat:42', units.get('synthetic-0')!);
      while (!queue.status().active) await delay(5);
      const urgentStarted = performance.now();
      const urgent = await enqueue(48, 60);
      while (!(await queue.hasCompleted('stripchat:42', urgent.atMs, urgent.unitId))) {
        if (performance.now() - started > 120000) throw Error('BENCHMARK_URGENT_TIMEOUT');
        await delay(10);
      }
      const urgentMs = performance.now() - urgentStarted;
      while (queue.status().completed < 49) {
        if (performance.now() - started > 120000) throw Error('BENCHMARK_TIMEOUT');
        await delay(10);
      }
      const result = {
        concurrency,
        completed: queue.status().completed,
        maximumActive: maximum,
        elapsedMs: performance.now() - started,
        urgentMs,
        queueP95Ms: percentile(waits, 0.95),
        renderP95Ms: percentile(renderTimes, 0.95),
        httpP95Ms: percentile(httpTimes, 0.95),
        httpP99Ms: percentile(httpTimes, 0.99),
        samples: httpTimes.length,
        cpuSeconds: ((await cpuMicros()) - cpuBefore) / 1000000,
        memoryPeakBytes,
      };
      summaries.push(result);
      console.log(JSON.stringify({ event: 'parallel_preview_case_completed', ...result }));
    } finally {
      sampling = false;
      await samplingWork;
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await queue.close();
    }
  }
  const result = {
    format: 1,
    synthetic: true,
    threadpool: process.env.UV_THREADPOOL_SIZE ?? 'node-default',
    scope:
      'PostgreSQL jobs + 720p CPU FFmpeg decode + real JPEG validation + JPEG/sidecar fsync publication; in-process status HTTP, no upstream or archive SQL; cgroup memory includes page cache',
    summaries,
  };
  console.log(JSON.stringify({ event: 'parallel_preview_benchmark', ...result }));
  if (process.env.STV_BENCH_REPORT)
    await writeFile(process.env.STV_BENCH_REPORT, JSON.stringify(result, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
