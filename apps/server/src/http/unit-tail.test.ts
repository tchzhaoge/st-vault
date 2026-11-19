import { expect, it, vi } from 'vitest';
import { waitUnitTail } from './unit-tail.js';
import type { ArchivePort, MediaChange } from '../ports.js';
import { SyncClock } from '../runtime/sync-clock.js';
it('wakes on committed media and detaches subscriptions after the same unit grows', async () => {
  const clock = new SyncClock({ intervalMs: () => 300000 });
  let listener: ((change: MediaChange) => void) | undefined;
  let end = 100;
  const detach = vi.fn();
  const archive = {
    unitRange: vi.fn(() => Promise.resolve({ fromMs: 0, toMs: end, open: true })),
    subscribeMedia: (cb: typeof listener) => {
      listener = cb;
      return detach;
    },
  } as unknown as ArchivePort;
  try {
    const work = waitUnitTail(
      archive,
      clock,
      'stripchat:1',
      'unit',
      100,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(archive.unitRange).toHaveBeenCalledTimes(1));
    end = 200;
    listener!({ kind: 'commit', segment: { subjectId: 'stripchat:1' } } as MediaChange);
    expect(await work).toEqual({ fromMs: 0, toMs: 200, open: true });
    expect(detach).toHaveBeenCalledOnce();
  } finally {
    await clock.close();
  }
});
it('stops waiting when the selected unit closes and never follows its successor', async () => {
  const clock = new SyncClock({ intervalMs: () => 300000 });
  const archive = {
    unitRange: () => Promise.resolve({ fromMs: 0, toMs: 100, open: false }),
  } as unknown as ArchivePort;
  try {
    expect(await waitUnitTail(archive, clock, 's', 'u', 100, new AbortController().signal)).toEqual(
      { fromMs: 0, toMs: 100, open: false },
    );
  } finally {
    await clock.close();
  }
});
it('releases a cancelled live continuation without a leaked waiter', async () => {
  const clock = new SyncClock({ intervalMs: () => 300000 }),
    abort = new AbortController(),
    detach = vi.fn();
  const archive = {
    unitRange: () => Promise.resolve({ fromMs: 0, toMs: 100, open: true }),
    subscribeMedia: () => detach,
  } as unknown as ArchivePort;
  try {
    const work = waitUnitTail(archive, clock, 's', 'u', 100, abort.signal);
    await Promise.resolve();
    abort.abort();
    await expect(work).rejects.toThrow();
    expect(detach).toHaveBeenCalledOnce();
  } finally {
    await clock.close();
  }
});
