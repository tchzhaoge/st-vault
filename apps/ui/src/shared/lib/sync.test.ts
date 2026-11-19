import { afterEach, expect, it, vi } from 'vitest';
import type * as React from 'react';
import { usePageSync, useSyncRefresh, syncReadFailure, type SyncReadResult } from './sync';
import { request } from './api';
const effects = vi.hoisted(() => [] as (() => void | (() => void))[]);
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
  useRef: (value: unknown) => ({ current: value }),
}));
const cleanups: (() => void)[] = [];
class Stream extends EventTarget {
  static current: Stream;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    super();
    Stream.current = this;
  }
  close(): void {
    this.onopen = null;
    this.onerror = null;
  }
  clock(): void {
    this.dispatchEvent(
      new MessageEvent('clock', { data: JSON.stringify({ atMs: Date.now(), intervalMs: 5000 }) }),
    );
  }
}
function environment(): void {
  vi.useFakeTimers();
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval }),
  );
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('EventSource', Stream);
}
function mount(): void {
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  effects.length = 0;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('starts a new scope without the background notification delay', async () => {
  environment();
  const read = vi.fn(() => Promise.resolve());
  useSyncRefresh(['timeline'], read, true, 'next-page');
  mount();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
});
it('cancels an obsolete scope before starting its replacement immediately', async () => {
  environment();
  const signals: AbortSignal[] = [];
  const read = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return Promise.resolve();
  });
  useSyncRefresh(['timeline'], read, true, 'old');
  mount();
  await Promise.resolve();
  cleanups.pop()!();
  useSyncRefresh(['timeline'], read, true, 'new');
  mount();
  await Promise.resolve();
  expect(signals).toHaveLength(2);
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
});
it('retains a business invalidation received during the foreground read', async () => {
  environment();
  let finish!: () => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  useSyncRefresh(['timeline'], read);
  mount();
  await Promise.resolve();
  window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] }));
  await vi.advanceTimersByTimeAsync(80);
  expect(read).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(80);
  expect(read).toHaveBeenCalledTimes(2);
});
it('compensates a connection established after the initial read without losing later changes', async () => {
  environment();
  const read = vi.fn(() => Promise.resolve());
  usePageSync(true);
  useSyncRefresh(['timeline'], read);
  mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  Stream.current.onopen?.();
  await vi.advanceTimersByTimeAsync(79);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 10; i++)
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] }));
  await vi.advanceTimersByTimeAsync(80);
  expect(read).toHaveBeenCalledTimes(3);
});
it('uses business changes rather than every clock to refresh stable data, with reconnect compensation', async () => {
  environment();
  const read = vi.fn(() => Promise.resolve());
  usePageSync(true);
  useSyncRefresh(['keys'], read);
  mount();
  Stream.current.onopen?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  Stream.current.clock();
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  Stream.current.onerror?.();
  await vi.advanceTimersByTimeAsync(2000);
  Stream.current.onopen?.();
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
});
it('keeps explicit progress reads and disconnected fallback on the shared clock', async () => {
  environment();
  const progress = vi.fn(() => Promise.resolve()),
    stable = vi.fn(() => Promise.resolve());
  usePageSync(true);
  useSyncRefresh(['system'], progress, true, '', true);
  useSyncRefresh(['keys'], stable);
  mount();
  Stream.current.onopen?.();
  await vi.advanceTimersByTimeAsync(100);
  Stream.current.clock();
  await vi.advanceTimersByTimeAsync(100);
  expect(progress).toHaveBeenCalledTimes(2);
  expect(stable).toHaveBeenCalledTimes(1);
  Stream.current.onerror?.();
  await vi.advanceTimersByTimeAsync(6000);
  expect(stable.mock.calls.length).toBeGreaterThan(1);
});
it('retries failed static subscriptions on clock only until a successful read', async () => {
  environment();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ status: 'retry', notBeforeMs: 0 })
    .mockResolvedValue(undefined);
  const stable = vi.fn(() => Promise.resolve());
  usePageSync(true);
  useSyncRefresh(['personal'], read);
  useSyncRefresh(['keys'], stable);
  mount();
  Stream.current.onopen?.();
  await vi.advanceTimersByTimeAsync(100);
  Stream.current.clock();
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
  expect(stable).toHaveBeenCalledTimes(1);
  Stream.current.clock();
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
  expect(stable).toHaveBeenCalledTimes(1);
});

it('recovers an exhausted safe read on the next healthy SSE clock without polling successful subscriptions', async () => {
  environment();
  let calls = 0;
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      ++calls <= 3
        ? new Response(JSON.stringify({ error: 'archive_busy' }), { status: 503 })
        : new Response(JSON.stringify({ ready: true })),
    ),
  );
  const read = vi.fn(async (signal: AbortSignal): Promise<SyncReadResult> => {
    try {
      await request('/api/static', { signal });
    } catch (error) {
      return syncReadFailure(error, signal);
    }
  });
  const stable = vi.fn(() => Promise.resolve());
  usePageSync(true);
  useSyncRefresh(['personal'], read);
  useSyncRefresh(['keys'], stable);
  mount();
  Stream.current.onopen?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toBe(3);
  expect(read).toHaveBeenCalledTimes(1);
  Stream.current.clock();
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toBe(4);
  expect(read).toHaveBeenCalledTimes(2);
  expect(stable).toHaveBeenCalledTimes(1);
  Stream.current.clock();
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toBe(4);
  expect(read).toHaveBeenCalledTimes(2);
});
it.each([503, 429])(
  'keeps Retry-After status %s across exhausted reads, queued changes and healthy clocks',
  async (status) => {
    environment();
    let calls = 0;
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        ++calls === 1
          ? new Response(
              JSON.stringify({ error: status === 503 ? 'archive_busy' : 'rate_limited' }),
              {
                status,
                headers: { 'retry-after': '60' },
              },
            )
          : new Response(JSON.stringify({ ready: true })),
      ),
    );
    const read = vi.fn(async (signal: AbortSignal): Promise<SyncReadResult> => {
      try {
        await request('/api/static', { signal });
      } catch (error) {
        return syncReadFailure(error, signal);
      }
    });
    usePageSync(true);
    useSyncRefresh(['personal'], read);
    mount();
    Stream.current.onopen?.();
    for (let tick = 1; tick <= 4; tick++) {
      await vi.advanceTimersByTimeAsync(5000);
      Stream.current.clock();
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['personal'] }));
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    for (let tick = 5; tick <= 13; tick++) {
      await vi.advanceTimersByTimeAsync(5000);
      Stream.current.clock();
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
  },
);
it('does not retry a definitive authorization response whose body hits the deadline', async () => {
  environment();
  const fetcher = vi.fn((_path: string, options: RequestInit) =>
    Promise.resolve({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: () =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => {
            const reason: unknown = options.signal!.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }),
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const read = vi.fn(async (signal: AbortSignal): Promise<SyncReadResult> => {
    try {
      await request('/api/static', { signal });
    } catch (error) {
      return syncReadFailure(error, signal);
    }
  });
  usePageSync(true);
  useSyncRefresh(['personal'], read);
  mount();
  Stream.current.onopen?.();
  for (let tick = 1; tick <= 4; tick++) {
    await vi.advanceTimersByTimeAsync(5000);
    Stream.current.clock();
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
