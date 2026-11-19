import { libraryIndexPath } from '../library/paths.js';
import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTestDatabase } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { expect, it, vi } from 'vitest';
import { openArchive } from './index.js';
import { orphanCandidates } from './orphan-candidates.js';
import type { CommitInput } from '../ports.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it('opens the recovered archive before orphan inspection and persists an interrupted sweep', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-startup-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inspecting = false;
  const a = await openArchive({
    root,
    fault: (point) => {
      if (point === 'after-object-rename') throw Error('INJECTED_ORPHAN');
    },
  });
  await a.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'fixture' }]);
  await expect(
    a.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'e',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 1000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    }),
  ).rejects.toThrow('INJECTED_ORPHAN');
  await a.close();
  const b = await openArchive({
    root,
    fault: async (point) => {
      if (point === 'before-orphan-batch') {
        inspecting = true;
        await gate;
      }
    },
  });
  try {
    await vi.waitFor(() => expect(inspecting).toBe(true));
    expect((await b.timeline('stripchat:1', 0, 10000)).segments).toEqual([]);
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      expect(
        await db
          .prepare("SELECT value FROM settings WHERE key='archive.orphan-scan-pending'")
          .get(),
      ).toEqual({ value: '1' });
    } finally {
      await db.close();
    }
    // Closing cancels the rest of the sweep; the next clean start must retry it.
    const closing = b.close();
    release();
    await closing;
    const c = await openArchive({ root });
    try {
      await vi.waitFor(async () =>
        expect(
          await readdir(path.join(root, 'media/subjects/stripchat-1/recordings/.orphaned')),
        ).toHaveLength(1),
      );
    } finally {
      await c.close();
    }
  } finally {
    release();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('never quarantines an in-flight rename before its journal and index commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-startup-race-'));
  const input: CommitInput = {
    subjectId: 'stripchat:1',
    sourceEpoch: 'e',
    sourceSequence: '1',
    init: null,
    bytes: new Uint8Array([1]),
    durationSeconds: 1,
    wallStartMs: 1000,
    timeBasis: 'source-pdt',
    uncertaintyMs: null,
    discontinuity: false,
  };
  const a = await openArchive({ root });
  await a.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'fixture' }]);
  await a.commit(input);
  await a.close();
  const db = await openTestDatabase(libraryIndexPath(root));
  await db.exec("UPDATE settings SET value='0' WHERE key='archive.clean'");
  await db.close();
  let releaseScan!: () => void, releaseWrite!: () => void;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let scanning = false,
    writing = false;
  const b = await openArchive({
    root,
    fault: async (point) => {
      if (point === 'before-orphan-batch') {
        scanning = true;
        await scanGate;
      }
      if (point === 'before-journal-write') {
        writing = true;
        await writeGate;
      }
    },
  });
  let pending: ReturnType<typeof b.commit> | undefined;
  try {
    await vi.waitFor(() => expect(scanning).toBe(true));
    pending = b.commit({ ...input, sourceSequence: '2', wallStartMs: 3000 });
    await vi.waitFor(() => expect(writing).toBe(true));
    releaseScan();
    expect((await b.timeline('stripchat:1', 0, 10000)).segments).toHaveLength(1);
    releaseWrite();
    const committed = await pending;
    await vi.waitFor(async () =>
      expect(await b.getSetting('archive.orphan-scan-pending')).toBe('0'),
    );
    expect(await b.media(committed.mediaObjectId)).not.toBeNull();
    await expect(
      readdir(path.join(root, 'media/subjects/stripchat-1/recordings/.orphaned')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    releaseScan();
    releaseWrite();
    await pending;
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('streams orphan candidates in batches of at most 128 and ignores unrelated directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-orphan-batch-'));
  try {
    const dir = path.join(root, '2026-11-12', '00');
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < 129; index++)
      await writeFile(path.join(dir, `seg-${randomUUID()}.m4s`), 'x');
    await mkdir(path.join(root, '.orphaned'));
    await writeFile(path.join(root, '.orphaned', `seg-${randomUUID()}.m4s`), 'x');
    const batches: number[] = [];
    for await (const batch of orphanCandidates(root)) batches.push(batch.length);
    expect(batches).toEqual([128, 1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
