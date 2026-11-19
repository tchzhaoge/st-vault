import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackResponse, Segment } from '@st-vault/api-schema';
import { archiveMediaEnd, shouldPrepareNext, Preparation } from './playback-continuation';
import { ApiError } from '../../shared/lib/api';

const segment = (start: number, duration: number): Segment => ({
  id: String(start),
  subjectId: 's',
  sourceEpoch: 'e',
  sourceSequence: '1',
  mediaObjectId: 'm',
  initObjectId: null,
  durationSeconds: duration,
  wallStartMs: start,
  wallEndMs: start + duration * 1000,
  timeBasis: 'source-pdt',
  uncertaintyMs: 0,
  discontinuity: false,
});
const playback = {
  segments: [segment(0, 20), segment(100000, 20)],
  rangeToMs: 115000,
  nextAtMs: 115000,
} as PlaybackResponse;

describe('prebuffered archive continuation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('prepares from remaining media duration, excluding wall-clock holes and the clipped tail', () => {
    expect(archiveMediaEnd(playback)).toBe(35);
    expect(shouldPrepareNext(playback, 19)).toBe(false);
    expect(shouldPrepareNext(playback, 20)).toBe(true);
    expect(shouldPrepareNext(playback, 5)).toBe(false);
    expect(shouldPrepareNext({ ...playback, nextAtMs: null }, 34)).toBe(false);
  });
  it('does not include an island beyond the range boundary', () => {
    expect(archiveMediaEnd({ ...playback, rangeToMs: 50000 })).toBe(20);
    expect(archiveMediaEnd({ ...playback, rangeToMs: undefined })).toBe(40);
  });
  it('runs only once per active source, and disposes a late response after manual selection', async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((done) => {
          resolve = done;
          signal.addEventListener('abort', () => undefined);
        }),
    );
    const release = vi.fn();
    const preparation = new Preparation<string>(release);
    const first = preparation.run(load);
    expect(await preparation.run(load)).toBeNull();
    preparation.cancel();
    resolve('old-session');
    expect(await first).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0].aborted).toBe(true);
    expect(release).toHaveBeenCalledWith('old-session');
  });
  it('returns the prepared source exactly once and allows a new active window', async () => {
    const preparation = new Preparation<string>(vi.fn());
    expect(await preparation.run(() => Promise.resolve('next'))).toBe('next');
    expect(await preparation.run(() => Promise.resolve('duplicate'))).toBeNull();
    preparation.cancel();
    expect(await preparation.run(() => Promise.resolve('later'))).toBe('later');
  });
  it('recovers from a transient failure after backoff without waiting for another progress event', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('unavailable', 503))
      .mockResolvedValue('next');
    const preparation = new Preparation<string>(vi.fn());
    const result = preparation.run(load);
    const expected = expect(result).resolves.toBe('next');
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    expect(preparation.pending).toBe(true);
    expect(await preparation.run(load)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expected;
    expect(preparation.pending).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await preparation.run(load)).toBeNull();
  });
  it('caps retries and ignores frequent progress calls during and after failure', async () => {
    vi.useFakeTimers();
    const failure = new ApiError('unavailable', 503),
      load = vi.fn().mockRejectedValue(failure);
    const preparation = new Preparation<string>(vi.fn());
    const result = preparation.run(load),
      expected = expect(result).rejects.toBe(failure);
    for (let elapsed = 0; elapsed < 7100; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      expect(await preparation.run(load)).toBeNull();
    }
    await expected;
    expect(load).toHaveBeenCalledTimes(4);
    expect(preparation.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it('cancels cooldown immediately and keeps the next source request independent', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new ApiError('unavailable', 503));
    const preparation = new Preparation<string>(vi.fn());
    const result = preparation.run(load),
      expected = expect(result).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    preparation.cancel();
    await expected;
    expect(preparation.pending).toBe(false);
    expect(await preparation.run(() => Promise.resolve('new'))).toBe('new');
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not retry a permanent HTTP failure', async () => {
    vi.useFakeTimers();
    const failure = new ApiError('forbidden', 403),
      load = vi.fn().mockRejectedValue(failure);
    const preparation = new Preparation<string>(vi.fn());
    await expect(preparation.run(load)).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('does not let a canceled late response finish the new source preparation', async () => {
    let resolveOld!: (value: string) => void, resolveNew!: (value: string) => void;
    const release = vi.fn(),
      preparation = new Preparation<string>(release);
    const old = preparation.run(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        }),
    );
    preparation.cancel();
    const next = preparation.run(
      () =>
        new Promise<string>((resolve) => {
          resolveNew = resolve;
        }),
    );
    resolveOld('old');
    expect(await old).toBeNull();
    expect(release).toHaveBeenCalledWith('old');
    expect(preparation.pending).toBe(true);
    resolveNew('new');
    expect(await next).toBe('new');
    expect(preparation.pending).toBe(false);
  });
});
it.each(['network', 'server'])(
  'preserves real request errors for bounded %s playback preparation retries',
  async (failure) => {
    vi.useFakeTimers();
    const { request } = await import('../../shared/lib/api');
    const fetcher = vi.fn();
    if (failure === 'network') fetcher.mockRejectedValueOnce(new TypeError('offline'));
    else
      fetcher.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 }),
      );
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify('next-session')));
    vi.stubGlobal('fetch', fetcher);
    try {
      const preparation = new Preparation<string>(vi.fn());
      const pending = preparation.run((signal) =>
        request<string>('/api/playback', { method: 'POST', operation: 'session', signal }),
      );
      const expected = expect(pending).resolves.toBe('next-session');
      await vi.advanceTimersByTimeAsync(1100);
      await expected;
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0][1]).not.toHaveProperty('operation');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  },
);
