/** Controlled scheduling benchmark; no real network, SQL, browser paint or decoding.
 * Run in parallel-qa with current UI source, baseline source and result directory mounted.
 * node --import /work/node_modules/tsx/dist/loader.mjs tests/performance/client-scheduling.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const baselineRoot = process.env.STV_CLIENT_BASELINE ?? '/work/.local/parallel-baseline';
const currentRoot = process.env.STV_CLIENT_CURRENT ?? '/work';
const output =
  process.env.STV_CLIENT_OUTPUT ?? '/work/.local/parallel-audit/client-scheduling.json';
const samples = Number(process.env.STV_CLIENT_SAMPLES ?? 7);
assert(Number.isInteger(samples) && samples > 0);
const load = (root, file) => import(pathToFileURL(resolve(root, 'apps/ui/src', file)).href);
const [baselineTracks, currentTracks, baselineImages, currentImages, admission] = await Promise.all(
  [
    load(baselineRoot, 'features/timeline/track-loader.ts'),
    load(currentRoot, 'features/timeline/track-loader.ts'),
    load(baselineRoot, 'shared/lib/image-loader.ts'),
    load(currentRoot, 'shared/lib/image-loader.ts'),
    load(currentRoot, 'shared/lib/image-admission.ts'),
  ],
);

const plan = (ids) => ({
  ids,
  visible: ids,
  prefetch: [],
  fromMs: 1,
  toMs: 1000,
  buckets: 50,
  revision: 1,
});
const round = (value) => Math.round(value * 1000) / 1000;

async function tracks(TrackLoader, count, scroll) {
  let target = Array.from({ length: count }, (_, i) => `old-${i}`);
  let started = performance.now(),
    first,
    firstFresh,
    maxRequests = 0,
    active = 0,
    requests = 0,
    maxLiveRequests = 0;
  const signals = new Set();
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const fetchRows = async (ids, requested, signal) => {
    active++;
    requests++;
    maxRequests = Math.max(maxRequests, active);
    signals.add(signal);
    maxLiveRequests = Math.max(
      maxLiveRequests,
      [...signals].filter((item) => !item.aborted).length,
    );
    let next = 0;
    // Match a bounded row pool inside each atomic HTTP response, not a global SQL pool.
    const rows = [];
    try {
      await Promise.all(
        Array.from({ length: Math.min(3, ids.length) }, async () => {
          while (next < ids.length) {
            const id = ids[next++];
            await delay(20, undefined, { signal });
            rows.push({
              subjectId: id,
              data: { coverage: { subjectId: id, fromMs: requested.fromMs, toMs: requested.toMs } },
            });
          }
        }),
      );
      return rows;
    } finally {
      active--;
      signals.delete(signal);
    }
  };
  const loader = new TrackLoader(fetchRows, () => {
    const available = target.filter((id) => loader.get(id, 1, 1000));
    const elapsed = performance.now() - started;
    if (available.length && first === undefined) first = elapsed;
    if (available.some((id) => id.startsWith('new-')) && firstFresh === undefined)
      firstFresh = elapsed;
    if (available.length === target.length) finish(elapsed);
  });
  try {
    loader.update(plan(target));
    if (scroll) {
      await delay(5);
      // Preserve one useful row: baseline keeps its whole 24-row atomic response.
      target = ['old-0', ...Array.from({ length: count - 1 }, (_, i) => `new-${i}`)];
      started = performance.now();
      loader.update(plan(target));
    }
    const all = await done;
    assert.equal(target.filter((id) => loader.get(id, 1, 1000)).length, count);
    return {
      firstUsableMs: round(first),
      ...(scroll ? { firstNewViewportRowMs: round(firstFresh) } : {}),
      allUsableMs: round(all),
      requests,
      maxLiveRequests,
      maxUnsettledRequests: maxRequests,
    };
  } finally {
    loader.close();
  }
}

async function images(ImageLoader, shared) {
  let active = 0,
    maxActive = 0,
    hoverStarted;
  const started = performance.now();
  const fetch = async (url, init) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (url === '/hover') hoverStarted = performance.now();
    try {
      await delay(25, undefined, { signal: init.signal });
      return new Response(new Blob(['simulated-image'], { type: 'image/jpeg' }));
    } finally {
      active--;
    }
  };
  const loader = new ImageLoader({
    fetch,
    ...(shared ? { admission: new admission.ImageAdmission(6) } : {}),
  });
  try {
    let first;
    const grid = Array.from({ length: 30 }, (_, i) =>
      loader.load(`/image-${i}`).then(() => {
        first ??= performance.now() - started;
      }),
    );
    await delay(5);
    const hoverRequested = performance.now();
    const hover = loader.load('/hover', undefined, shared ? 'interactive' : 'visible');
    await hover;
    const hoverReady = performance.now();
    await Promise.all(grid);
    return {
      firstGridImageMs: round(first),
      allImagesMs: round(performance.now() - started),
      hoverQueueMs: round(hoverStarted - hoverRequested),
      hoverReadyMs: round(hoverReady - hoverRequested),
      maxConcurrentTransfers: maxActive,
    };
  } finally {
    loader.clear();
  }
}

function summarize(runs) {
  return Object.fromEntries(
    Object.keys(runs[0]).map((key) => {
      const values = runs.map((run) => run[key]).sort((a, b) => a - b);
      return [
        key,
        { median: values[Math.floor(values.length / 2)], min: values[0], max: values.at(-1) },
      ];
    }),
  );
}

const results = [];
for (const count of [12, 24]) {
  for (const scroll of [false, true]) {
    for (const [variant, implementation] of [
      ['baseline', baselineTracks],
      ['current', currentTracks],
    ]) {
      const run = () => tracks(implementation.TrackLoader, count, scroll);
      await run(); // Exclude import/JIT warmup from measured samples.
      const runs = [];
      for (let i = 0; i < samples; i++) runs.push(await run());
      results.push({
        scenario: scroll ? 'overlapping-viewport-scroll' : 'visible-rows',
        rows: count,
        variant,
        summary: summarize(runs),
        runs,
      });
    }
  }
}
for (const [variant, implementation, shared] of [
  ['baseline', baselineImages, false],
  ['current', currentImages, true],
]) {
  const run = () => images(implementation.ImageLoader, shared);
  await run();
  const runs = [];
  for (let i = 0; i < samples; i++) runs.push(await run());
  results.push({
    scenario: '30-grid-images-and-urgent-hover',
    variant,
    summary: summarize(runs),
    runs,
  });
}
const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    kind: 'controlled simulated network/SQL scheduling, real production client classes; not measured browser latency',
    samples,
    warmupsPerCase: 1,
    rowDelayMs: 20,
    rowWorkersPerRequest: 3,
    response:
      'atomic per request; no global SQL limit simulated; current two requests can use six row workers',
    scrollAfterMs: 5,
    overlapRows: 1,
    imageDelayMs: 25,
    imageCount: 30,
    requestCounts:
      'live excludes aborted signals; unsettled includes aborted transports until rejection finally settles',
    hover:
      'same screenshot loader; baseline visible FIFO vs current interactive priority; running transfers not preempted',
    limitations:
      'No HTTP RTT/bandwidth competition, PostgreSQL query cost, DOM rendering, decoding, cache hits or server overload. Scheduling isolation only.',
  },
  results,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    results.map(({ scenario, rows, variant, summary }) => ({ scenario, rows, variant, summary })),
    null,
    2,
  ),
);
