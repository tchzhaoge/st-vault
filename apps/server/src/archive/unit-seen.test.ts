import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
import { SqlDatabase } from '../database/sql.js';
import { LibraryStorage } from '../library/storage.js';

it('persists idempotent seen evidence by unit without changing favorites or unknown units', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-seen-'));
  let a = await openArchive({ root });
  const id = 'stripchat:1';
  try {
    await a.upsertSubjects([
      { id, providerId: 1, handle: 'seen' },
      { id: 'stripchat:2', providerId: 2, handle: 'other' },
    ]);
    const commit = (sequence: number) =>
      a.commit({
        subjectId: id,
        sourceEpoch: 'e',
        sourceSequence: String(sequence),
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 2,
        wallStartMs: sequence * 60000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const first = await commit(1),
      second = await commit(2);
    expect((await a.coverage(id, 0, 180000, 180)).seenSpans).toEqual([]);
    const revision = await a.personalRevision();
    expect(await a.markUnitsSeen!('stripchat:2', [{ unitId: first.id, toMs: 62000 }])).toEqual({
      changed: 0,
    });
    expect(
      await a.markUnitsSeen!(id, [
        { unitId: first.id, toMs: 62000 },
        { unitId: first.id, toMs: 62000 },
      ]),
    ).toEqual({ changed: 1 });
    expect(await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 62000 }])).toEqual({ changed: 0 });
    expect(await a.personalRevision()).toBe(revision);
    expect((await a.personal(id, 0, 180000)).favorites).toEqual([]);
    expect((await a.coverage(id, 0, 180000, 180)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 62000 },
    ]);
    expect((await a.coverage(id, 0, 180000, 1)).seenSpans).toEqual([]);
    await a.markUnitsSeen!(id, [{ unitId: second.id, toMs: 122000 }]);
    expect((await a.coverage(id, 0, 180000, 1)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 122000 },
    ]);
    await a.close();
    a = await openArchive({ root });
    expect((await a.coverage(id, 0, 180000, 180)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 62000 },
      { fromMs: 120000, toMs: 122000 },
    ]);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reopens legacy three-column seen journal rows without trusting their unbounded evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-seen-legacy-'));
  const media = path.join(root, 'media');
  let a = await openArchive({ root });
  try {
    await a.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'legacy' }]);
    const first = await a.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'e',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    await a.snapshotPages!('stripchat:1', 60000, 1, 30, { fromMs: 0, toMs: 120000 });
    await a.close();
    const library = new LibraryStorage(root, media);
    const db = await SqlDatabase.open(library.indexFile);
    try {
      await library.attach(db);
      await library.transaction(db, () =>
        db
          .prepare('INSERT INTO unit_seen(unit,subject,seen_at) VALUES(?,?,?)')
          .run(first.id, 'stripchat:1', Date.now()),
      );
    } finally {
      await library.close();
      await db.close();
    }
    a = await openArchive({ root });
    expect((await a.coverage('stripchat:1', 0, 120000, 120)).seenSpans).toEqual([]);
    await a.markUnitsSeen!('stripchat:1', [{ unitId: first.id, toMs: 62000 }]);
    await a.close();
    a = await openArchive({ root });
    expect((await a.coverage('stripchat:1', 0, 120000, 120)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 62000 },
    ]);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a growing tail unread and never rolls evidence back on delayed retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-seen-growth-'));
  let a = await openArchive({ root });
  const id = 'stripchat:1';
  try {
    await a.upsertSubjects([{ id, providerId: 1, handle: 'growing' }]);
    const commit = (start: number) =>
      a.commit({
        subjectId: id,
        sourceEpoch: 'e',
        sourceSequence: String(start),
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 2,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const first = await commit(60000);
    await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 62000 }]);
    await commit(62000);
    await commit(64000);
    const coverage = () => a.coverage(id, 60000, 70000, 100);
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 62000 }]);
    expect(await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 64000 }])).toEqual({ changed: 1 });
    expect(await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 62000 }])).toEqual({ changed: 0 });
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 64000 }]);
    expect((await a.coverage(id, 60000, 70000, 1)).seenSpans).toEqual([]);
    await a.close();
    a = await openArchive({ root });
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 64000 }]);
    // Clamp an overlarge boundary to committed media, never reserve future evidence.
    await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 999999 }]);
    await commit(66000);
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 66000 }]);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});
