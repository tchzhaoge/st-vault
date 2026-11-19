import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, drainServices } from './lifecycle.js';
afterEach(() => vi.useRealTimers());
describe('shutdown ownership', () => {
  it('starts every service drain even if one fails, and waits for all before rejecting', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    let rejected = false;
    const done = drainServices([
      () => {
        started.push('failed');
        throw new Error('failed-close');
      },
      () => {
        started.push('slow');
        return slow;
      },
    ]).catch((error) => {
      rejected = true;
      throw error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['failed', 'slow']);
    expect(rejected).toBe(false);
    release();
    await expect(done).rejects.toThrow(AggregateError);
  });
  it('drains producers before closing metadata and shares repeated shutdowns', async () => {
    const steps: string[] = [];
    const forceExit = vi.fn();
    vi.useFakeTimers();
    const stop = createShutdown({
      closeProducers: () => {
        steps.push('writers');
        return Promise.resolve();
      },
      closeArchive: () => {
        steps.push('archive');
        return Promise.resolve();
      },
      forceExit,
      deadlineMs: 10,
    });
    const first = stop();
    expect(stop()).toBe(first);
    await first;
    await vi.advanceTimersByTimeAsync(20);
    expect(steps).toEqual(['writers', 'archive']);
    expect(forceExit).not.toHaveBeenCalled();
  });
  it('keeps the exit deadline after failed drain without closing under possible writers', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const closeArchive = vi.fn(() => Promise.resolve());
    const stop = createShutdown({
      closeProducers: () => Promise.reject(new Error('drain failed')),
      closeArchive,
      forceExit,
      deadlineMs: 10,
    });
    await expect(stop()).rejects.toThrow('drain failed');
    expect(closeArchive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11);
    expect(forceExit).toHaveBeenCalledTimes(1);
  });
});
