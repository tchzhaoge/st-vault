import { ApiError, ReadRetryError } from '../../shared/lib/api';
import { expect, it, vi } from 'vitest';
import type { TrackData } from './TimelineBands';
import { TrackLoader, type TrackPlan } from './track-loader';
const plan = (ids: string[], visible = ids, fromMs = 0, toMs = 1000): TrackPlan => ({
  ids,
  visible,
  prefetch: [],
  fromMs,
  toMs,
  buckets: 60,
  revision: 1,
});
const row = (id: string, fromMs = 0, toMs = 1000): TrackData => ({
  coverage: {
    subjectId: id,
    fromMs,
    toMs,
    revision: 1,
    unlocatedCount: 0,
    buckets: [],
  },
  bands: [],
});
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
it.each([
  ['success', 2],
  ['success', 3],
  ['failure', 2],
  ['failure', 3],
] as const)(
  'keeps retry ownership when an older parallel %s arrives during revision %s',
  async (outcome, revision) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let finishOld: (() => void) | undefined;
    const fetch = vi.fn(async (ids: string[], p: TrackPlan) => {
      if (p.revision === 1) {
        await new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        if (outcome === 'failure') throw new ApiError('old_failure', 503);
      } else if (fetch.mock.calls.length === 2) {
        throw new ApiError('new_failure', 503, undefined, 60000);
      }
      return ids.map((id) => ({ subjectId: id, data: row(id) }));
    });
    const loader = new TrackLoader(fetch, vi.fn());
    try {
      loader.update(plan(['a']));
      await tick();
      loader.update({ ...plan(['a']), revision: 2 });
      await tick();
      expect(loader.failed('a')).toBe(true);
      if (revision === 3) loader.update({ ...plan(['a']), revision });
      finishOld!();
      await tick();
      expect(loader.failed('a')).toBe(revision === 2);
      await vi.advanceTimersByTimeAsync(59999);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2][1].revision).toBe(revision);
      expect(loader.failed('a')).toBe(false);
    } finally {
      loader.close();
      warning.mockRestore();
      vi.useRealTimers();
    }
  },
);
it('loads newly visible rows while a still useful old batch is waiting', async () => {
  let finish: (() => void) | undefined;
  const queries: string[][] = [],
    signals: AbortSignal[] = [];
  const loader = new TrackLoader(async (ids, p, signal) => {
    queries.push(ids);
    signals.push(signal);
    if (ids.includes('a'))
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }));
  }, vi.fn());
  loader.update(plan(['a']));
  await tick();
  loader.update(plan(['a', 'b', 'c'], ['b', 'c']));
  await tick();
  expect(loader.get('b', 0, 1000)).toBeDefined();
  expect(signals[0].aborted).toBe(false);
  finish!();
  await tick();
  loader.close();
});
it('publishes small visible batches independently instead of waiting for a whole viewport', async () => {
  const release: (() => void)[] = [],
    queries: string[][] = [];
  const loader = new TrackLoader(async (ids, p) => {
    queries.push(ids);
    await new Promise<void>((resolve) => release.push(resolve));
    return ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }));
  }, vi.fn());
  loader.update(plan(Array.from({ length: 20 }, (_, i) => String(i))));
  expect(queries).toHaveLength(2);
  expect(queries.every((ids) => ids.length <= 6)).toBe(true);
  release[1]();
  await tick();
  expect(loader.get(queries[1][0], 0, 1000)).toBeDefined();
  expect(loader.get(queries[0][0], 0, 1000)).toBeUndefined();
  loader.close();
  for (const done of release) done();
  await tick();
});
it('fills two independent server execution waves before scheduling further visible rows', async () => {
  const release: (() => void)[] = [],
    queries: string[][] = [];
  const loader = new TrackLoader(async (ids) => {
    queries.push(ids);
    await new Promise<void>((resolve) => release.push(resolve));
    return ids.map((id) => ({ subjectId: id, data: row(id) }));
  }, vi.fn());
  try {
    loader.update(plan(['a', 'b', 'c', 'd', 'e', 'f', 'g']));
    expect(queries).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
    release[1]();
    await tick();
    expect(loader.get('d', 0, 1000)).toBeDefined();
    expect(loader.get('a', 0, 1000)).toBeUndefined();
    expect(queries[2]).toEqual(['g']);
  } finally {
    loader.close();
    for (const done of release) done();
    await tick();
  }
});
it('does not let render-only cache reads change eviction ownership', async () => {
  const loader = new TrackLoader(
    (ids, p) =>
      Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
    vi.fn(),
    2,
  );
  try {
    loader.update(plan(['a', 'b']));
    await tick();
    for (let i = 0; i < 20; i++) expect(loader.get('a', 0, 1000)).toBeDefined();
    loader.update(plan(['c']));
    await tick();
    expect(loader.get('a', 0, 1000)).toBeUndefined();
    expect(loader.get('b', 0, 1000)).toBeDefined();
    expect(loader.get('c', 0, 1000)).toBeDefined();
  } finally {
    loader.close();
  }
});
it('never overwrites a fresh revision with an older parallel response', async () => {
  let oldDone: (() => void) | undefined;
  const loader = new TrackLoader(async (ids, p) => {
    if (p.revision === 1)
      await new Promise<void>((resolve) => {
        oldDone = resolve;
      });
    return ids.map((id) => ({
      subjectId: id,
      data: { ...row(id), coverage: { ...row(id).coverage, revision: p.revision } },
    }));
  }, vi.fn());
  loader.update(plan(['a']));
  await tick();
  loader.update({ ...plan(['a']), revision: 2 });
  await tick();
  expect(loader.get('a', 0, 1000)?.coverage.revision).toBe(2);
  oldDone!();
  await tick();
  expect(loader.get('a', 0, 1000)?.coverage.revision).toBe(2);
  loader.close();
});
it('returns visible rows before waiting for overscan and prefetch rows', async () => {
  const queries: string[][] = [],
    release: (() => void)[] = [];
  const loader = new TrackLoader(async (ids, p) => {
    queries.push(ids);
    await new Promise<void>((resolve) => release.push(resolve));
    return ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }));
  }, vi.fn());
  loader.update({ ...plan(['a', 'b', 'c'], ['b']), prefetch: ['d'] });
  expect(queries).toEqual([['b']]);
  release.shift()!();
  await tick();
  expect(loader.get('b', 0, 1000)).toBeDefined();
  expect(queries[1]).toEqual(['a', 'c', 'd']);
  release.shift()!();
  await tick();
  loader.close();
});
it('retains bounded independent windows for immediate back navigation', async () => {
  const fetch = vi.fn((ids: string[], p: TrackPlan) =>
    Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
  );
  const loader = new TrackLoader(fetch, vi.fn());
  loader.update(plan(['a']));
  await tick();
  loader.update(plan(['a'], ['a'], 1000, 2000));
  await tick();
  expect(loader.get('a', 0, 1000)?.coverage.fromMs).toBe(0);
  loader.update(plan(['a']));
  await tick();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(loader.get('a', 0, 1000)?.coverage.toMs).toBe(1000);
  loader.close();
});
it('cancels entirely offscreen batches so the latest viewport can load next', async () => {
  const signals: AbortSignal[] = [],
    queries: string[][] = [];
  const loader = new TrackLoader(async (ids, p, signal) => {
    signals.push(signal);
    queries.push(ids);
    if (queries.length === 1)
      await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        }),
      );
    return ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }));
  }, vi.fn());
  loader.update(plan(['a']));
  await tick();
  loader.update(plan(['z']));
  await tick();
  expect(signals[0].aborted).toBe(true);
  expect(queries).toEqual([['a'], ['z']]);
  expect(loader.get('z', 0, 1000)).toBeDefined();
  expect(loader.failed('a')).toBe(false);
  loader.close();
});
it('bounds row-window retention and never cycles over prefetch beyond its capacity', async () => {
  const fetch = vi.fn((ids: string[], p: TrackPlan) =>
    Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
  );
  const loader = new TrackLoader(fetch, vi.fn(), 2);
  for (let i = 0; i < 3; i++) {
    loader.update(plan(['a'], ['a'], i * 1000, (i + 1) * 1000));
    await tick();
  }
  expect(loader.get('a', 0, 1000)).toBeUndefined();
  expect(loader.get('a', 1000, 2000)).toBeDefined();
  loader.update(plan(['a', 'b', 'c'], ['a'], 3000, 4000));
  await tick();
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(loader.get('b', 3000, 4000)).toBeDefined();
  expect(loader.get('c', 3000, 4000)).toBeUndefined();
  loader.close();
});
it('keeps the useful in-flight batch while starting newly visible rows in a free slot', async () => {
  const release: (() => void)[] = [],
    queries: string[][] = [];
  const loader = new TrackLoader(async (ids, p) => {
    queries.push(ids);
    await new Promise<void>((resolve) => release.push(resolve));
    return ids.map((id) => ({
      subjectId: id,
      data: row(id, p.fromMs, p.toMs),
    }));
  }, vi.fn());
  loader.update(plan(['a']));
  await tick();
  expect(queries).toEqual([['a']]);
  loader.update(plan(['a', 'b', 'c'], ['b', 'c']));
  await tick();
  expect(queries).toEqual([['a'], ['b', 'c']]);
  release.shift()!();
  await tick();
  expect(queries[1]).toEqual(['b', 'c']);
  expect(loader.get('a', 0, 1000)).toBeDefined();
  release.shift()!();
  await tick();
  expect(loader.get('b', 0, 1000)).toBeDefined();
  loader.close();
});
it('reuses cached rows on return, refreshes overlapping data without clearing it, and hides disjoint stale data', async () => {
  const fetch = vi.fn((ids: string[], p: TrackPlan) =>
      Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
    ),
    loader = new TrackLoader(fetch, vi.fn());
  loader.update(plan(['a']));
  await tick();
  loader.update(plan(['b']));
  await tick();
  loader.update(plan(['a']));
  await tick();
  expect(fetch).toHaveBeenCalledTimes(2);
  loader.update({ ...plan(['a']), revision: 2 });
  expect(loader.get('a', 100, 1100)).toBeDefined();
  expect(loader.get('a', 1000, 2000)).toBeUndefined();
  await tick();
  expect(fetch).toHaveBeenCalledTimes(3);
  loader.close();
});
it('aborts obsolete time windows and bounds the cache and batch size', async () => {
  const signals: AbortSignal[] = [],
    release: (() => void)[] = [],
    loader = new TrackLoader(
      async (ids, p, signal) => {
        signals.push(signal);
        await new Promise<void>((resolve) => release.push(resolve));
        return ids.map((id) => ({
          subjectId: id,
          data: row(id, p.fromMs, p.toMs),
        }));
      },
      vi.fn(),
      2,
    );
  loader.update(plan(['a']));
  await tick();
  loader.update(plan(['b'], ['b'], 1000, 2000));
  expect(signals[0].aborted).toBe(true);
  release.shift()!();
  await tick();
  release.shift()!();
  await tick();
  expect(loader.get('a', 0, 1000)).toBeUndefined();
  expect(loader.get('b', 1000, 2000)).toBeDefined();
  loader.close();
});

it('retries a transient failure without needing a clock refresh and cancels retries on close', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fetch = vi.fn((ids: string[], p: TrackPlan) =>
    Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
  );
  fetch.mockRejectedValueOnce(new TypeError('network interrupted'));
  const loader = new TrackLoader(fetch, vi.fn());
  try {
    loader.update(plan(['a']));
    await tick();
    expect(loader.failed('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(loader.get('a', 0, 1000)).toBeDefined();
    expect(loader.failed('a')).toBe(false);
    fetch.mockRejectedValueOnce(new TypeError('network interrupted'));
    loader.update({ ...plan(['a']), revision: 2 });
    await tick();
    loader.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    loader.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it.each([400, 401, 403])('does not timer-retry permanent HTTP %s errors', async (status) => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fetch = vi.fn(() => Promise.reject(new ApiError('invalid request', status)));
  const loader = new TrackLoader(fetch, vi.fn());
  try {
    loader.update(plan(['a']));
    await tick();
    expect(loader.failed('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    loader.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});
it('drops a pending retry when navigating to a different window', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fetch = vi.fn((ids: string[], p: TrackPlan) =>
    Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
  );
  fetch.mockRejectedValueOnce(new ApiError('busy', 429));
  const loader = new TrackLoader(fetch, vi.fn());
  try {
    loader.update(plan(['a']));
    await tick();
    loader.update(plan(['b'], ['b'], 1000, 2000));
    await tick();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(loader.get('b', 1000, 2000)).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    loader.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it.each(['http', 'read-budget'] as const)(
  'honors %s retry eligibility across content revisions and retries the latest plan at the deadline',
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn((ids: string[], p: TrackPlan) =>
      Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
    );
    fetch.mockImplementationOnce(async () => {
      if (kind === 'read-budget') {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        throw new ReadRetryError(new DOMException('Read timed out', 'TimeoutError'), 60000);
      }
      throw new ApiError('archive_busy', 503, undefined, 60000);
    });
    const loader = new TrackLoader(fetch, vi.fn());
    try {
      loader.update(plan(['a']));
      await vi.advanceTimersByTimeAsync(kind === 'read-budget' ? 15000 : 0);
      expect(loader.failed('a')).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetch).toHaveBeenCalledTimes(1);
      // A changed content version is not permission to ignore transport backoff.
      loader.update({ ...plan(['a']), revision: 2 });
      await tick();
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60000 - Date.now() - 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][1].revision).toBe(2);
      expect(loader.get('a', 0, 1000)).toBeDefined();
      expect(loader.failed('a')).toBe(false);
    } finally {
      loader.close();
      warning.mockRestore();
      vi.useRealTimers();
    }
  },
);

it('keeps local network backoff through revisions and time-window changes for the same subject', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fetch = vi.fn((ids: string[], p: TrackPlan) =>
    Promise.resolve(ids.map((id) => ({ subjectId: id, data: row(id, p.fromMs, p.toMs) }))),
  );
  fetch.mockRejectedValueOnce(new TypeError('network interrupted'));
  const loader = new TrackLoader(fetch, vi.fn());
  try {
    loader.update(plan(['a']));
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    loader.update({ ...plan(['a'], ['a'], 1000, 2000), revision: 2 });
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(loader.get('a', 1000, 2000)).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    loader.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});
