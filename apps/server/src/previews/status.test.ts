import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPreviews } from './index.js';
import { ScreenshotJobs } from './jobs.js';
import type { SyncClock } from '../runtime/sync-clock.js';

const archive = {
  listSubjects: () => Promise.resolve([]),
  getSubject: () => Promise.resolve(null),
  hasMedia: () => Promise.resolve(false),
  locate: vi.fn(),
  timeline: vi.fn(),
  media: vi.fn(),
  snapshotUnit: vi.fn(),
};
it('shares one canonical lookup for a completed image read and still rejects deleted source media', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-canonical-read-'));
  const unitId = '00000000-0000-4000-8000-000000000042';
  const canonical = {
    unitId,
    open: false,
    atMs: 1000,
    slotFromMs: 1000,
    slotToMs: 2000,
    url: '/unit.jpg',
    timeBasis: 'source-pdt' as const,
    uncertaintyMs: null,
  };
  const snapshotUnit = vi.fn(() => Promise.resolve(canonical));
  const unitSource = vi.fn(() =>
    Promise.resolve({
      id: unitId,
      subjectId: 'stripchat:42',
      sourceEpoch: 'e',
      sourceSequence: '1',
      mediaObjectId: unitId,
      initObjectId: null,
      durationSeconds: 1,
      wallStartMs: 1000,
      wallEndMs: 2000,
      timeBasis: 'source-pdt' as const,
      uncertaintyMs: null,
      discontinuity: false,
    }),
  );
  const hasMedia = vi.fn(() => Promise.resolve(true));
  const image = new Uint8Array([255, 216, 255, 217]);
  const read = vi.fn(() => Promise.resolve(image));
  const open = vi
    .spyOn(ScreenshotJobs, 'open')
    .mockResolvedValue({ read, close: () => Promise.resolve() } as unknown as ScreenshotJobs);
  const previews = createPreviews({
    archive: { ...archive, snapshotUnit, unitSource, hasMedia },
    cacheRoot: root,
  });
  try {
    expect(await previews.snapshot('stripchat:42', 1000, undefined, 2000, unitId)).toBe(image);
    expect(snapshotUnit).toHaveBeenCalledOnce();
    expect(unitSource).toHaveBeenCalledOnce();
    expect(hasMedia).toHaveBeenCalledWith([unitId]);
    hasMedia.mockResolvedValue(false);
    await expect(
      previews.snapshot('stripchat:42', 1000, undefined, 2000, unitId),
    ).rejects.toMatchObject({ code: 'preview_not_found' });
    expect(snapshotUnit).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    await previews.close();
    open.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
it('propagates page request cancellation into the archive layout builder', async () => {
  const snapshotPages = vi.fn(
    (...args: unknown[]) =>
      new Promise<never>((_resolve, reject) => {
        const signal = args[6] as AbortSignal;
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })),
          { once: true },
        );
      }),
  );
  const previews = createPreviews({ archive: { ...archive, snapshotPages } });
  const controller = new AbortController();
  try {
    const read = previews.snapshotPages!('stripchat:42', 1, 1, 30, controller.signal, {
      fromMs: 0,
      toMs: 60000,
    });
    const rejected = expect(read).rejects.toMatchObject({ code: 'preview_cancelled' });
    await vi.waitFor(() => expect(snapshotPages).toHaveBeenCalledOnce());
    const inner = snapshotPages.mock.calls[0][6] as AbortSignal;
    expect(inner.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(inner.aborted).toBe(true);
  } finally {
    controller.abort();
    await previews.close();
  }
});
function opening() {
  let resolve!: (jobs: ScreenshotJobs) => void;
  const promise = new Promise<ScreenshotJobs>((done) => {
    resolve = done;
  });
  const ready = {
    status: () => ({ mode: 'realtime', pending: 0, failed: 0, completed: 0, averageMs: 0 }),
    maintenanceStatus: () => ({ id: 'snapshot-maintenance', group: 'processing', state: 'idle' }),
    close: () => Promise.resolve(),
  } as unknown as ScreenshotJobs;
  return { promise, release: () => resolve(ready) };
}
it('reads initial screenshot status without awaiting storage opening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-status-opening-'));
  const gate = opening();
  const open = vi.spyOn(ScreenshotJobs, 'open').mockReturnValue(gate.promise);
  const previews = createPreviews({ archive, cacheRoot: root });
  try {
    const jobs = await Promise.race([
      previews.jobs!(),
      new Promise<null>((done) => setTimeout(() => done(null), 30)),
    ]);
    expect(jobs).toMatchObject({ mode: 'initializing' });
    const tasks = await Promise.race([
      previews.backgroundTasks!(),
      new Promise<null>((done) => setTimeout(() => done(null), 30)),
    ]);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'snapshot-maintenance', state: 'waiting', error: null }),
      ]),
    );
    expect(open).toHaveBeenCalledOnce();
  } finally {
    gate.release();
    await previews.close();
    open.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
it('leaves retries to the heartbeat while exposing failure, recovery and ready snapshots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-status-recovery-'));
  const gate = opening();
  const open = vi
    .spyOn(ScreenshotJobs, 'open')
    .mockRejectedValueOnce(new Error('synthetic storage failure'))
    .mockReturnValue(gate.promise);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let time = 0;
  const callbacks = new Map<string, () => void>();
  const clock = {
    subscribe: (name: string, callback: () => void) => {
      callbacks.set(name, callback);
      return () => callbacks.delete(name);
    },
  } as unknown as SyncClock;
  const previews = createPreviews({ archive, cacheRoot: root, clock, now: () => time });
  try {
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(await previews.jobs!()).toMatchObject({ mode: 'unavailable' });
    time = 30000;
    await previews.jobs!();
    const tasks = await previews.backgroundTasks!();
    expect(open).toHaveBeenCalledOnce();
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'snapshot-maintenance',
          state: 'retrying',
          nextRunAtMs: 30000,
        }),
      ]),
    );
    callbacks.get('screenshot-storage-recovery')!();
    expect(open).toHaveBeenCalledTimes(2);
    expect(await previews.jobs!()).toMatchObject({ mode: 'initializing' });
    gate.release();
    await vi.waitFor(async () =>
      expect(await previews.jobs!()).toMatchObject({ mode: 'realtime' }),
    );
  } finally {
    gate.release();
    await previews.close();
    open.mockRestore();
    log.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
