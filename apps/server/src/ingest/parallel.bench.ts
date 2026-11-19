/** Isolated synthetic HLS transport/CDN/durable-file benchmark. No account,
 * application archive, production data directory or network service is used. */
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Segment, Subject } from '@st-vault/api-schema';
import { createIngressHub } from './index.js';
import { ByteLedger } from './byte-ledger.js';
import { StatusEvidence } from '../provider/status-evidence.js';

const realtime = process.env.STV_BENCH_REALTIME !== '0';
const observationMs = Number(process.env.STV_BENCH_OBSERVATION_MS ?? 30000);
const payloadBytes = realtime ? 512 * 1024 : 16 * 1024;
const subjectCases = (process.env.STV_BENCH_SUBJECTS ?? '8,32,64').split(',').map(Number);
if (!Number.isSafeInteger(observationMs) || observationMs < 1000)
  throw Error('INVALID_BENCHMARK_WINDOW');
if (subjectCases.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 128))
  throw Error('INVALID_BENCHMARK_CAPACITY');

const percentile = (values: number[], percent: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)] ?? 0;
};
function ledgerCost(subjects: number) {
  const ledger = new ByteLedger();
  const owners = Array.from({ length: subjects }, () =>
    Array.from({ length: 16 }, () => new Uint8Array(1024)),
  );
  const scan = () => {
    const buffers = new Set<Uint8Array>();
    for (const owner of owners) for (const bytes of owner) buffers.add(bytes);
    return [...buffers].reduce((total, bytes) => total + bytes.byteLength, 0);
  };
  owners.forEach((owner) => owner.forEach((bytes) => ledger.retain(bytes)));
  let total = 0;
  const start = performance.now();
  for (let i = 0; i < 1000; i++) total += scan();
  const scanMs = performance.now() - start,
    next = performance.now();
  let incremental = 0;
  for (let i = 0; i < 1000; i++) incremental += ledger.bytes;
  if (incremental !== total) throw Error('BYTE_LEDGER_MISMATCH');
  return { reads: 1000, scanMs, ledgerMs: performance.now() - next };
}
async function run(subjects: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-ingress-bench-'));
  const controller = new AbortController();
  const provider = { status: () => Promise.resolve('PUBLIC' as const) };
  const evidence = new StatusEvidence({ provider, publicConcurrency: 64, monitorConcurrency: 32 });
  const started = performance.now();
  let preference = 'old.invalid',
    switchAt = 0,
    peakRetained = 0,
    peakMedia = 0,
    activeMedia = 0;
  const first = new Map<number, number>(),
    selected = new Map<number, number>();
  const counts = new Map<number, number>(),
    highest = new Map<number, number>();
  const previous = new Map<number, number>(),
    lastCommit = new Map<number, number>();
  const gaps: number[] = [],
    failures: string[] = [],
    violations: string[] = [];
  const mediaActive = new Map<number, number>(),
    overlap = new Set<number>();
  const payload = new Uint8Array(payloadBytes);
  const hub = createIngressHub({
    provider,
    evidence,
    maxBytes: 2 * 1024 ** 3,
    ringSegments: 4,
    recordingQueueSegments: 128,
    recordingQueueBytes: 32 * 1024 ** 2,
    reloadMs: realtime ? 500 : 2,
    publicCheckMs: 5000,
    preferredCdn: () => preference,
    hlsEdges: ['old.invalid', 'new.invalid'],
    allowedMediaHosts: ['old.invalid', 'new.invalid'],
    onCdnSelected: (id, host) => {
      if (host === 'new.invalid' && !selected.has(id))
        selected.set(id, performance.now() - switchAt);
    },
    fetch: async (input, request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const id = Number(/\/(\d+)(?:_auto|\/)/.exec(url.pathname)?.[1]);
      if (!id) throw Error('INVALID_BENCHMARK_REQUEST');
      if (url.pathname.includes('_auto.m3u8')) {
        await delay(url.hostname === 'new.invalid' ? 8 : 1, undefined, {
          signal: request?.signal ?? undefined,
        });
        return new Response(
          `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n/hls/${id}/main.m3u8\n`,
        );
      }
      if (url.pathname.endsWith('.m3u8')) {
        const cursor = realtime
          ? Math.floor((performance.now() - started) / 2000) + 1
          : (highest.get(id) ?? 0);
        const from = Math.max(1, cursor - 4),
          to = realtime ? cursor : cursor + 12;
        return new Response(
          `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${from}\n#EXT-X-PROGRAM-DATE-TIME:${new Date(1700000000000 + from * 2000).toISOString()}\n` +
            Array.from(
              { length: to - from + 1 },
              (_, index) => `#EXTINF:2,\nsegment-${from + index}.mp4\n`,
            ).join(''),
        );
      }
      const sequence = Number(/segment-(\d+)\.mp4/.exec(url.pathname)?.[1]);
      if (!sequence) throw Error('INVALID_BENCHMARK_SEGMENT');
      activeMedia++;
      peakMedia = Math.max(peakMedia, activeMedia);
      const active = (mediaActive.get(id) ?? 0) + 1;
      mediaActive.set(id, active);
      if (active > 1) overlap.add(id);
      try {
        await delay(url.hostname === 'new.invalid' ? 20 : 100, undefined, {
          signal: request?.signal ?? undefined,
        });
        highest.set(id, Math.max(highest.get(id) ?? 0, sequence));
        return new Response(payload, { headers: { 'content-type': 'video/mp4' } });
      } finally {
        activeMedia--;
        mediaActive.set(id, (mediaActive.get(id) ?? 1) - 1);
      }
    },
  });
  const captures: Promise<void>[] = [];
  try {
    for (let id = 1; id <= subjects; id++) {
      await mkdir(path.join(root, String(id)));
      const subject: Subject = {
        id: `stripchat:${id}`,
        providerId: id,
        handle: 'synthetic',
        monitorEnabled: true,
        autoRecord: true,
        providerStatus: 'PUBLIC',
        observedAtMs: 0,
      };
      captures.push(
        hub
          .capture(
            subject,
            {
              commit: async (input) => {
                const sequence = Number(input.sourceSequence),
                  prev = previous.get(id);
                if (prev !== undefined && sequence !== prev + 1) violations.push(`${id}:sequence`);
                previous.set(id, sequence);
                const file = await open(path.join(root, String(id), `${sequence}.m4s`), 'w');
                try {
                  await file.writeFile(input.bytes);
                  await file.sync();
                } finally {
                  await file.close();
                }
                const now = performance.now();
                if (!first.has(id)) first.set(id, now - started);
                if (lastCommit.has(id)) gaps.push(now - lastCommit.get(id)!);
                lastCommit.set(id, now);
                counts.set(id, (counts.get(id) ?? 0) + 1);
                return {
                  ...input,
                  id: String(sequence),
                  mediaObjectId: String(sequence),
                  initObjectId: null,
                  wallEndMs: input.wallStartMs! + input.durationSeconds * 1000,
                } satisfies Segment;
              },
            },
            controller.signal,
          )
          .catch((error: unknown) => {
            if (!controller.signal.aborted)
              failures.push(error instanceof Error ? error.message : 'unknown');
          }),
      );
    }
    const until = async (test: () => boolean, timeoutMs = 15000) => {
      const deadline = performance.now() + timeoutMs;
      while (!test()) {
        if (failures.length) throw Error('BENCHMARK_CAPTURE_FAILED_' + failures.join(','));
        if (performance.now() > deadline) throw Error('BENCHMARK_DEADLINE');
        peakRetained = Math.max(peakRetained, hub.stats().retainedBytes);
        await delay(5);
      }
    };
    await until(
      () => counts.size === subjects && [...counts.values()].every((count) => count >= 2),
    );
    switchAt = performance.now();
    preference = 'new.invalid';
    hub.changeCdn();
    if (realtime)
      await until(() => performance.now() - switchAt >= observationMs, observationMs + 1000);
    else
      await until(
        () => selected.size === subjects && [...counts.values()].every((count) => count >= 20),
      );
    return {
      mode: realtime ? 'two-second-publication' : 'accelerated-pressure',
      payloadBytes,
      segmentIntervalMs: realtime ? 2000 : null,
      observationMs: realtime ? observationMs : null,
      subjects,
      switchesCompleted: selected.size,
      firstCommitP95Ms: percentile([...first.values()], 0.95),
      switchP95Ms: percentile([...selected.values()], 0.95),
      commitGapP95Ms: percentile(gaps, 0.95),
      commitGapMaxMs: Math.max(...gaps),
      commits: [...counts.values()].reduce((a, b) => a + b, 0),
      sourceSequenceViolations: violations.length,
      dualRouteSubjects: overlap.size,
      peakMediaRequests: peakMedia,
      peakRetainedBytes: peakRetained,
      byteAdmission: ledgerCost(subjects),
      elapsedMs: performance.now() - started,
    };
  } finally {
    controller.abort();
    await hub.close();
    await Promise.all(captures);
    await evidence.close();
    if (hub.stats().retainedBytes !== 0) throw Error('BENCHMARK_BUFFER_LEAK');
    await rm(root, { recursive: true, force: true });
  }
}
for (const subjects of subjectCases)
  console.log(JSON.stringify({ event: 'parallel_ingress_benchmark', ...(await run(subjects)) }));
