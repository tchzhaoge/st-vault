import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { openArchive } from '../archive/index.js';
import { createPreviews } from './index.js';
import { ScreenshotJobs } from './jobs.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { SqlDatabase } from '../database/sql.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});
const image = new Uint8Array([255, 216, 255, 217]);
it('promotes an interactive cache miss above live and repair work without adding decoder workers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-snapshot-foreground-'));
  const archive = await openArchive({ root: path.join(root, 'archive') });
  const previews = createPreviews({
    archive,
    cacheRoot: path.join(root, 'previews'),
    canGenerate: () => false,
  });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'synthetic' }]);
    await previews.jobs?.();
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'e',
      sourceSequence: '0',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 120001,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    await expect(
      previews.snapshot('stripchat:42', 120001, undefined, 180001),
    ).rejects.toMatchObject({ code: 'preview_pending' });
    const db = await SqlDatabase.open(path.join(root, 'previews', 'screenshots', 'jobs'));
    try {
      expect(
        (await db
          .prepare('SELECT priority FROM jobs WHERE subject=? AND at=?')
          .get<{ priority: number }>('stripchat:42', 120001))!.priority,
      ).toBeGreaterThan(50);
    } finally {
      await db.close();
    }
  } finally {
    await previews.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('retries a transient screenshot storage initialization failure after cooldown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-snapshot-reopen-'));
  const archive = await openArchive({ root: path.join(root, 'archive') });
  const open = vi
    .spyOn(ScreenshotJobs, 'open')
    .mockRejectedValueOnce(new Error('temporary storage error'));
  let now = 1000;
  const callbacks = new Map<string, () => void>();
  const clock = {
    subscribe: (name: string, callback: () => void) => {
      callbacks.set(name, callback);
      return () => callbacks.delete(name);
    },
  } as unknown as SyncClock;
  const previews = createPreviews({
    archive,
    clock,
    cacheRoot: path.join(root, 'previews'),
    now: () => now,
    fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
  });
  try {
    await vi.waitFor(async () => expect((await previews.jobs?.())?.mode).toBe('unavailable'));
    now += 29999;
    callbacks.get('screenshot-storage-recovery')!();
    expect((await previews.jobs?.())?.mode).toBe('unavailable');
    expect(open).toHaveBeenCalledTimes(1);
    now++;
    expect((await previews.jobs?.())?.mode).toBe('unavailable');
    expect(open).toHaveBeenCalledTimes(1);
    callbacks.get('screenshot-storage-recovery')!();
    expect(open).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await previews.jobs?.())?.mode).toBe('realtime'));
  } finally {
    await previews.close();
    open.mockRestore();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('generates on recorded commits before requests, then serves persistent images across reopen and repairs corruption', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-precomputed-')),
    archive = await openArchive({ root: path.join(root, 'archive') });
  const decoder = vi.fn(() => Promise.resolve(image)),
    validate = vi.fn(() => Promise.resolve()),
    options = {
      archive,
      cacheRoot: path.join(root, 'previews'),
      decoder,
      validateSnapshot: validate,
      fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    };
  let previews = createPreviews(options);
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'synthetic' }]);
    await previews.jobs?.();
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'e',
      sourceSequence: '0',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 120001,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    await vi.waitFor(
      async () => expect((await previews.jobs?.())?.completed).toBeGreaterThanOrEqual(1),
      { timeout: 5000 },
    );
    expect(decoder).toHaveBeenCalled();
    expect(validate).toHaveBeenCalled();
    const before = decoder.mock.calls.length;
    expect([...(await previews.snapshot('stripchat:42', 120001, undefined, 180001))]).toEqual([
      ...image,
    ]);
    expect(decoder).toHaveBeenCalledTimes(before);
    await previews.close();
    previews = createPreviews(options);
    await previews.jobs?.();
    expect([...(await previews.snapshot('stripchat:42', 120001, undefined, 180001))]).toEqual([
      ...image,
    ]);
    expect(decoder).toHaveBeenCalledTimes(before);
    const dir = path.join(root, 'previews', 'screenshots', '42'),
      file = (await readdir(dir)).find((name) => name.endsWith('.jpg'))!;
    await writeFile(path.join(dir, file), 'broken');
    await vi.waitFor(
      async () => {
        expect([...(await previews.snapshot('stripchat:42', 120001, undefined, 180001))]).toEqual([
          ...image,
        ]);
        expect(decoder.mock.calls.length).toBeGreaterThan(before);
      },
      { timeout: 5000 },
    );
    await archive.deleteRange('stripchat:42', 120001, 122001);
    await expect(
      previews.snapshot('stripchat:42', 120001, undefined, 180001),
    ).rejects.toMatchObject({ code: 'preview_not_found' });
  } finally {
    await previews.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('does not recycle an unvalidated encoded image when full JPEG validation rejects it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-validation-retry-')),
    archive = await openArchive({ root: path.join(root, 'archive') });
  const decoder = vi
    .fn(() => Promise.resolve(image))
    .mockResolvedValueOnce(new Uint8Array([255, 216, 255, 1, 255, 217]));
  const validate = vi.fn((bytes: Uint8Array) =>
    bytes.length === 4 ? Promise.resolve() : Promise.reject(Error('invalid-jpeg')),
  );
  const previews = createPreviews({
    archive,
    cacheRoot: path.join(root, 'previews'),
    decoder,
    validateSnapshot: validate,
    fetch: () => Promise.resolve(new Response(null, { status: 404 })),
  });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'synthetic' }]);
    await previews.jobs?.();
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'e',
      sourceSequence: '0',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 120001,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    await vi.waitFor(
      async () => {
        expect((await previews.jobs?.())?.completed).toBeGreaterThanOrEqual(1);
        expect(decoder.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect((await previews.jobs?.())?.failed).toBe(0);
        expect(validate.mock.calls.length).toBe(decoder.mock.calls.length);
      },
      { timeout: 4300 },
    );
  } finally {
    await previews.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
