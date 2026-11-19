import { expect, it, vi } from 'vitest';
import { TaskPool, TaskWakeup } from './task-pool.js';

it('keeps the I/O limit while releasing failed work to the next waiter', async () => {
  const pool = new TaskPool(2);
  let active = 0,
    maximum = 0,
    started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = (fail: boolean) =>
    pool.run(async () => {
      started++;
      active++;
      maximum = Math.max(maximum, active);
      try {
        await gate;
        if (fail) throw Error('EXPECTED_IO_FAILURE');
      } finally {
        active--;
      }
    });
  const tasks = [task(true), task(false), task(false)];
  expect(started).toBe(2);
  release();
  const results = await Promise.allSettled(tasks);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(maximum).toBe(2);
  expect(started).toBe(3);
});
it('retains enqueue notifications and disposes old waits', async () => {
  const signal = new TaskWakeup(),
    epoch = signal.epoch;
  signal.notify();
  await signal.next(epoch).promise;
  const old = signal.next(signal.epoch);
  old.dispose();
  const next = signal.next(signal.epoch),
    observed = vi.fn();
  void next.promise.then(observed);
  signal.notify();
  await next.promise;
  expect(observed).toHaveBeenCalledOnce();
  next.dispose();
});
