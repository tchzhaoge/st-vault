import { expect, it, vi } from 'vitest';
import { SyncClock } from './sync-clock.js';
it('uses one clock for every job and applies the shared interval without overlapping slow work', async () => {
  vi.useFakeTimers();
  let interval = 1000,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const clock = new SyncClock({ intervalMs: () => interval }),
    fast = vi.fn(),
    slow = vi.fn(() => gate);
  clock.subscribe('fast', fast);
  clock.subscribe('slow', slow);
  try {
    await vi.advanceTimersByTimeAsync(3000);
    expect(fast).toHaveBeenCalledTimes(3);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    interval = 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fast).toHaveBeenCalledTimes(4);
  } finally {
    release();
    await clock.close();
    vi.useRealTimers();
  }
});
it('cancels detached jobs and retains only the clock timer', async () => {
  vi.useFakeTimers();
  const clock = new SyncClock({ intervalMs: () => 1000 }),
    work = vi.fn();
  const detach = clock.subscribe('job', work);
  try {
    expect(vi.getTimerCount()).toBe(1);
    detach();
    await vi.advanceTimersByTimeAsync(2000);
    expect(work).not.toHaveBeenCalled();
  } finally {
    await clock.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
it('observes slow execution, failure and recovery without altering job admission', async () => {
  vi.useFakeTimers();
  const clock = new SyncClock({ intervalMs: () => 1000 });
  let reject!: () => void;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const detach = clock.subscribe(
    'observed',
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = () => fail(Error('not exposed'));
      }),
  );
  try {
    expect(clock.status()[0]).toMatchObject({
      running: false,
      lastStartedAtMs: null,
      failed: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.status()[0]).toMatchObject({ running: true, lastStartedAtMs: Date.now() });
    const before = clock.status()[0];
    before.name = 'mutated';
    expect(clock.status()[0].name).toBe('observed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(clock.status()[0].lastStartedAtMs).toBe(before.lastStartedAtMs);
    reject();
    await vi.advanceTimersByTimeAsync(0);
    expect(clock.status()[0]).toMatchObject({ running: false, failed: true });
    expect(clock.status()[0]).not.toHaveProperty('error');
    detach();
    clock.subscribe('recovered', () => undefined, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(clock.status()[0]).toMatchObject({ name: 'recovered', failed: false, running: false });
  } finally {
    detach();
    await clock.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});
