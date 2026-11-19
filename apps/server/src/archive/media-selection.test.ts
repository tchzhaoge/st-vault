import { like } from '../../../../tests/support/unit-selection.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
import { recordingRange } from '../http/recording-range.js';

const subject = { id: 'stripchat:1', providerId: 1, handle: 'media-fixture' };
it('keeps a long surviving fragment as one unit while GC is paused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-delete-long-span-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const archive = await openArchive({
    root,
    fault: async (point) => {
      if (point === 'before-unlink') {
        entered();
        await gate;
      }
    },
  });
  try {
    await archive.upsertSubjects([subject]);
    for (const [seq, start, duration] of [
      [1, 1000, 180],
      [2, 300000, 10],
    ])
      await archive.commit({
        subjectId: subject.id,
        sourceEpoch: 'one',
        sourceSequence: String(seq),
        init: null,
        bytes: new Uint8Array([seq]),
        durationSeconds: duration,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const plan = await archive.planDeletion!(subject.id, [{ fromMs: 300000, toMs: 360000 }]);
    await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision);
    await paused;
    const window = { fromMs: 0, toMs: 360000 };
    const during = await archive.snapshotPages!(subject.id, 60000, 1, 30, window);
    // Complete source fragments stay indivisible even when they cross several minutes.
    expect(during.items).toHaveLength(1);
    expect(during.items[0]).toMatchObject({ atMs: 1000, slotFromMs: 1000, slotToMs: 181000 });
    release();
    await archive.resumeDeletions!();
    const after = await archive.snapshotPages!(subject.id, 60000, 1, 30, window);
    expect(after.items).toEqual(during.items);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('projects pending deletion consistently into bounds, playback, screenshots and coverage before file GC finishes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-logical-deletion-'));
  let entered!: () => void, release!: () => void;
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  const archive = await openArchive({
    root,
    fault: async (point) => {
      if (armed && point === 'before-unlink') {
        armed = false;
        entered();
        await gate;
      }
    },
  });
  const commit = (id: string, seq: number, start: number) =>
    archive.commit({
      subjectId: id,
      sourceEpoch: 'one',
      sourceSequence: String(seq),
      init: null,
      bytes: new Uint8Array([seq]),
      durationSeconds: 10,
      wallStartMs: start,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([subject, { id: 'stripchat:2', providerId: 2, handle: 'other' }]);
    // Creation revision is global, not the subject journal head.
    for (let i = 0; i < 8; i++) await commit('stripchat:2', i, 60000 + i * 10000);
    for (let i = 1; i <= 5; i++) await commit(subject.id, i, i * 60000);
    const plan = await archive.planDeletion!(
      subject.id,
      [1, 3, 5].map((i) => ({ fromMs: i * 60000, toMs: (i + 1) * 60000 })),
    );
    expect(plan.total).toBe(3);
    let deleteNotices = 0;
    const detach = archive.subscribeMedia!((event) => {
      if (event.kind === 'delete') deleteNotices++;
    });
    const job = await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision);
    await enteredGate;
    expect((await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision)).id).toBe(
      job.id,
    );
    expect(await recordingRange(archive, subject.id, 0, 360000)).toEqual({
      fromMs: 120000,
      toMs: 250000,
    });
    expect((await archive.locate(subject.id, 180000, 'next'))?.wallStartMs).toBe(240000);
    const coverage = await archive.coverage(subject.id, 0, 360000, 6);
    expect(coverage.buckets.map((b) => b.coveredMs)).toEqual([0, 0, 10000, 0, 10000, 0]);
    const shots = await archive.snapshotPages!(subject.id, 120000, 1, 30, {
      fromMs: 0,
      toMs: 360000,
    });
    expect(shots.items.map((item) => item.atMs)).toEqual([120000, 240000]);
    expect(shots.total).toBe(2);
    // File GC of one subject does not serialize another subject's recording.
    await commit('stripchat:2', 9, 180000);
    release();
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!())[0].state).toBe('completed');
    expect(deleteNotices).toBe(2); // Two accepted/idempotent requests, no per-GC-batch invalidations.
    detach();
    expect((await archive.coverage(subject.id, 0, 360000, 6)).buckets).toEqual(coverage.buckets);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('supports scroll selections larger than a page and deduplicates files crossing minute boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-scroll-selection-'));
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([subject]);
    const ranges = Array.from({ length: 65 }, (_, index) => ({
      fromMs: index * 120000,
      toMs: index * 120000 + 60000,
    }));
    const segment = await archive.commit({
      subjectId: subject.id,
      sourceEpoch: 'a',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 59000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const plan = await archive.planDeletion!(subject.id, [
      ...ranges,
      { fromMs: 60000, toMs: 120000 },
    ]);
    expect(plan.total).toBe(1);
    expect(plan.fromMs).toBe(segment.wallStartMs);
    expect(plan).not.toHaveProperty('segmentIds');
    const liked = await like(archive, subject.id, [
      { atMs: 59000, fromMs: 0, toMs: 60000 },
      ...Array.from({ length: 31 }, () => ({ atMs: 59000, fromMs: 0, toMs: 60000 })),
    ]);
    expect(new Set(liked.favorites.map((item) => item.id)).size).toBe(1);
    const protectedPlan = await archive.planDeletion!(subject.id, [
      ...ranges,
      { fromMs: 60000, toMs: 120000 },
    ]);
    expect(protectedPlan.favoriteSegments).toBe(1);
    const partialBoundary = await archive.planDeletion!(subject.id, [
      { fromMs: 0, toMs: 60000 },
      { fromMs: 7 * 86400000 - 1, toMs: 7 * 86400000 + 59999 },
    ]);
    expect(partialBoundary.total).toBe(1);
    expect(() =>
      archive.planDeletion!(subject.id, [
        { fromMs: 0, toMs: 60000 },
        { fromMs: 10 * 86400000, toMs: 10 * 86400000 + 60000 },
      ]),
    ).toThrow('INVALID_MEDIA_SELECTION');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('serializes favorite protection with an already admitted retention batch and rejects vanished media', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-pin-race-'));
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const archive = await openArchive({
    root,
    fault: async (point) => {
      if (point === 'after-tombstone-sync') {
        reached();
        await gate;
      }
    },
  });
  try {
    await archive.upsertSubjects([subject]);
    await archive.commit({
      subjectId: subject.id,
      sourceEpoch: 'a',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 65000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const pruning = archive.pruneBefore(300000);
    await paused;
    let settled = false;
    const liking = like(archive, subject.id, [
      { atMs: 65000, fromMs: 60000, toMs: 120000 },
    ]).finally(() => {
      settled = true;
    });
    const rejected = expect(liking).rejects.toThrow('MEDIA_SELECTION_STALE');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await pruning;
    await rejected;
    expect((await archive.personal(subject.id, 0, 120000)).favorites).toHaveLength(0);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('pins selected units durably and excludes their complete files from retention until unliked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-pins-'));
  let archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([subject]);
    const segments = [];
    for (const [index, start] of [59000, 65000, 125000, 180000].entries())
      segments.push(
        await archive.commit({
          subjectId: subject.id,
          sourceEpoch: 'a',
          sourceSequence: String(index),
          init: new Uint8Array([1]),
          bytes: new Uint8Array([2]),
          durationSeconds: 2,
          wallStartMs: start,
          timeBasis: 'source-pdt',
          uncertaintyMs: null,
          discontinuity: false,
        }),
      );
    const firstPins = await like(archive, subject.id, [
      { atMs: 65000, fromMs: 60000, toMs: 120000 },
    ]);
    const point = firstPins.favorites[0];
    const repeated = await like(archive, subject.id, [
      { atMs: 66000, fromMs: 60000, toMs: 120000 },
    ]);
    expect(repeated.favorites[0].id).toBe(point.id);
    const pins = await like(archive, subject.id, [{ atMs: 180000, fromMs: 180000, toMs: 240000 }]);
    await archive.close();
    archive = await openArchive({ root });
    expect((await archive.pruneBefore(300000)).deletedSegments).toBe(1);
    expect(await archive.hasMedia([segments[0].id, segments[1].id, segments[3].id])).toBe(true);
    expect(await archive.hasMedia([segments[2].id])).toBe(false);
    for (const favorite of firstPins.favorites) await archive.removeFavorite(favorite.id);
    await archive.removeFavorite(pins.favorites.find((favorite) => favorite.fromMs === 180000)!.id);
    expect((await archive.pruneBefore(300000)).deletedSegments).toBe(3);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('previews exact intersecting files for disjoint minutes and never deletes files created after that preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-delete-plan-'));
  const archive = await openArchive({ root });
  const commit = (sequence: string, start: number) =>
    archive.commit({
      subjectId: subject.id,
      sourceEpoch: 'a',
      sourceSequence: sequence,
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: start,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([subject]);
    const first = await commit('1', 59000),
      hole = await commit('2', 125000),
      last = await commit('3', 180000);
    const plan = await archive.planDeletion!(subject.id, [
      { fromMs: 60000, toMs: 120000 },
      { fromMs: 180000, toMs: 240000 },
    ]);
    expect(plan.total).toBe(2);
    expect(plan.toMs).toBe(last.wallEndMs);
    expect(plan.fromMs).toBe(59000);
    expect(plan.toMs).toBe(182000);
    const newer = await commit('4', 70000);
    expect((await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision)).total).toBe(
      2,
    );
    await archive.resumeDeletions!();
    expect(await archive.hasMedia([hole.id, newer.id])).toBe(true);
    expect(await archive.hasMedia([first.id])).toBe(false);
    const next = await archive.planDeletion!(subject.id, [{ fromMs: 60000, toMs: 120000 }]);
    await like(archive, subject.id, [{ atMs: 70000, fromMs: 60000, toMs: 120000 }]);
    await expect(
      archive.deleteSelection!(subject.id, next.id, next.personalRevision),
    ).rejects.toThrow('STALE_DELETE_PLAN');
    expect(await archive.hasMedia([newer.id])).toBe(true);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
