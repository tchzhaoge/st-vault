import { expect, it } from 'vitest';
import { MemoryAdmission } from './memory-admission.js';
it('admits FIFO reservations, shrinks actual payloads and cancels waiters', async () => {
  const memory: MemoryAdmission = new MemoryAdmission((bytes) => memory.reserved + bytes <= 100);
  const first = await memory.acquire(80, new AbortController().signal);
  const cancel = new AbortController();
  const canceled = expect(memory.acquire(80, cancel.signal)).rejects.toThrow('cancelled');
  let granted = false;
  const next = memory.acquire(40, new AbortController().signal).then((token) => {
    granted = true;
    return token;
  });
  expect(granted).toBe(false);
  cancel.abort();
  await canceled;
  first.resize(60);
  const second = await next;
  expect(memory.reserved).toBe(100);
  first.release();
  first.release();
  second.release();
  expect(memory.reserved).toBe(0);
});
it('hands a payload from reservation to retained ownership before waking waiters', async () => {
  let retained = 0;
  const memory: MemoryAdmission = new MemoryAdmission(
    (bytes) => retained + memory.reserved + bytes <= 100,
  );
  const first = await memory.acquire(100, new AbortController().signal);
  let granted = false;
  const next = memory.acquire(100, new AbortController().signal).then((token) => {
    granted = true;
    return token;
  });
  first.release();
  retained = 100;
  await Promise.resolve();
  expect(granted).toBe(false);
  retained = 0;
  memory.changed();
  (await next).release();
});
