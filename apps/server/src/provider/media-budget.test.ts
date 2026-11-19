import { expect, it } from 'vitest';
import { MediaBudget } from './media-budget.js';

it('accepts the execution plan capacity while preserving FIFO cancellation and accounting', async () => {
  const budget = new MediaBudget(64);
  const signal = new AbortController().signal;
  const releases = await Promise.all(Array.from({ length: 64 }, () => budget.acquire(signal)));
  const cancel = new AbortController();
  const cancelled = expect(budget.acquire(cancel.signal)).rejects.toThrow('cancelled');
  let admitted = false;
  const queued = budget.acquire(signal).then((release) => {
    admitted = true;
    return release;
  });
  expect(budget.stats()).toEqual({ active: 64, waiting: 2, limit: 64 });
  cancel.abort();
  await cancelled;
  expect(admitted).toBe(false);
  releases.pop()!();
  const release = await queued;
  expect(budget.stats()).toEqual({ active: 64, waiting: 0, limit: 64 });
  release();
  release();
  releases.forEach((done) => done());
  expect(budget.stats()).toEqual({ active: 0, waiting: 0, limit: 64 });
  expect(() => new MediaBudget(1025)).toThrow('invalid-media-concurrency');
});
