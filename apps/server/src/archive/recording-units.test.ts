import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

it('locates the newer overlapping unit while retaining explicit identity and next-in-gap behavior', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-boundary-'));
  const archive = await openArchive({ root });
  const commit = (at: number, durationSeconds: number) =>
    archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'e',
      sourceSequence: String(at),
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'overlap' }]);
    const previous = await commit(58000, 4.019);
    const next = await commit(62000, 4);
    const later = await commit(122000, 4);
    expect((await archive.snapshotUnit!('stripchat:1', 62000))?.unitId).toBe(next.id);
    expect((await archive.snapshotUnit!('stripchat:1', 61999))?.unitId).toBe(previous.id);
    expect((await archive.snapshotUnit!('stripchat:1', 62000, previous.id))?.unitId).toBe(
      previous.id,
    );
    expect((await archive.snapshotUnit!('stripchat:1', 66000))?.unitId).toBe(later.id);
    expect(await archive.snapshotUnit!('stripchat:1', 126000)).toBeNull();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('owns complete fragments across minute edges, gaps, reconnects, favorites and restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-units-'));
  let archive = await openArchive({ root });
  const commit = (at: number, epoch = 'e') =>
    archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: epoch,
      sourceSequence: String(at),
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 4,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: epoch !== 'e',
    });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'unit-fixture' }]);
    await commit(58000);
    await commit(62000);
    await commit(70000, 'reconnected');
    let page = await archive.snapshotPages!('stripchat:1', 74000, 1, 30, {
      fromMs: 60000,
      toMs: 75000,
    });
    expect(page.items.map((item) => [item.slotFromMs, item.slotToMs])).toEqual([
      [58000, 62000],
      [62000, 74000],
    ]);
    const unit = page.items[1];
    expect(unit.unitId).toBeTruthy();
    expect(await archive.unitBounds!('stripchat:1', 65000, 66000)).toEqual({
      fromMs: 62000,
      toMs: 74000,
    });
    const revision = await archive.personalRevision();
    await archive.unitFavorites!('stripchat:1', [unit.unitId], true, revision);
    expect(await archive.unitBounds!('stripchat:1', 66000, 68000)).toBeNull();
    await commit(90000);
    expect((await archive.personal('stripchat:1', 60000, 120000)).favorites).toMatchObject([
      { id: unit.unitId, fromMs: 62000, toMs: 94000 },
    ]);
    await archive.close();
    archive = await openArchive({ root });
    page = await archive.snapshotPages!('stripchat:1', 94000, 1, 30, { fromMs: 0, toMs: 95000 });
    expect(page.items[1].unitId).toBe(unit.unitId);
    expect((await archive.pruneBefore(120000)).deletedSegments).toBe(1);
    expect((await archive.timeline('stripchat:1', 0, 120000)).segments).toHaveLength(3);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('deletes the entire selected open unit, includes pre-confirmation additions and preserves its successor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-delete-'));
  const archive = await openArchive({ root });
  const commit = (at: number) =>
    archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'e',
      sourceSequence: String(at),
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'fixture' }]);
    await commit(62000);
    const plan = await archive.planDeletion!('stripchat:1', [{ fromMs: 62500, toMs: 63000 }]);
    await commit(66000);
    const job = await archive.deleteSelection!('stripchat:1', plan.id, plan.personalRevision);
    expect(job.total).toBe(2);
    expect(job.toMs).toBe(68000);
    const later = await commit(68000);
    await archive.resumeDeletions!();
    expect((await archive.timeline('stripchat:1', 0, 120000)).segments.map((s) => s.id)).toEqual([
      later.id,
    ]);
    const page = await archive.snapshotPages!('stripchat:1', 70000, 1, 30, {
      fromMs: 0,
      toMs: 120000,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].unitId).toBe(later.id);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('resumes a unit deletion after interrupted unlink without consuming its recorded successor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-resume-'));
  let blocked = true;
  let archive = await openArchive({
    root,
    fault(point) {
      if (blocked && point === 'before-unlink') throw Error('INJECTED_DISK_OFFLINE');
    },
  });
  const commit = (at: number) =>
    archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'e',
      sourceSequence: String(at),
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'resume' }]);
    await commit(62000);
    await commit(66000);
    const plan = await archive.planDeletion!('stripchat:1', [{ fromMs: 62000, toMs: 68000 }]);
    await archive.deleteSelection!('stripchat:1', plan.id, plan.personalRevision);
    await archive.resumeDeletions!();
    // A durable deletion's unlink failure is a retryable task, not archive corruption.
    expect(await archive.deletionJobs!()).toEqual([
      expect.objectContaining({ id: plan.id, state: 'retry', processed: 0 }),
    ]);
    await archive.close();
    blocked = false;
    archive = await openArchive({ root });
    expect((await archive.deletionJobs!())[0].state).toBe('queued');
    const successor = await commit(68000);
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!())[0].state).toBe('completed');
    expect((await archive.timeline('stripchat:1', 0, 120000)).segments.map((s) => s.id)).toEqual([
      successor.id,
    ]);
    const page = await archive.snapshotPages!('stripchat:1', 70000, 1, 30, {
      fromMs: 0,
      toMs: 120000,
    });
    expect(page.items.map((item) => item.unitId)).toEqual([successor.id]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('separates true source-clock regression and resolves repeated sample times by unit identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-clock-'));
  const archive = await openArchive({ root });
  const commit = (at: number, epoch: string) =>
    archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: epoch,
      sourceSequence: String(at),
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: epoch !== 'a',
    });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'clock' }]);
    const first = await commit(61000, 'a');
    await commit(81000, 'a');
    const reset = await commit(71000, 'reset');
    expect(
      (await archive.snapshotPages!('stripchat:1', 83000, 1, 30, { fromMs: 60000, toMs: 90000 }))
        .items,
    ).toHaveLength(2);
    await archive.setObservation('stripchat:1', 'OFFLINE', 90000, 10000);
    const repeated = await commit(61000, 'new');
    const old = await archive.snapshotUnit!('stripchat:1', 61000, first.id),
      fresh = await archive.snapshotUnit!('stripchat:1', 61000, repeated.id);
    expect(old?.atMs).toBe(fresh?.atMs);
    expect(old?.url).not.toBe(fresh?.url);
    expect((await archive.unitSource!('stripchat:1', first.id, 61000))?.id).toBe(first.id);
    expect((await archive.unitSource!('stripchat:1', repeated.id, 61000))?.id).toBe(repeated.id);
    expect((await archive.unitSource!('stripchat:1', reset.id, 71000))?.id).toBe(reset.id);
    expect((await archive.snapshotForSegment!('stripchat:1', repeated.id))?.unitId).toBe(
      repeated.id,
    );
    const a = await archive.snapshotUnits!('stripchat:1', undefined, 1),
      b = await archive.snapshotUnits!('stripchat:1', a.cursor!, 1),
      c = await archive.snapshotUnits!('stripchat:1', b.cursor!, 1);
    expect([a.items[0].unitId, b.items[0].unitId, c.items[0].unitId]).toEqual([
      first.id,
      reset.id,
      repeated.id,
    ]);
    expect((await archive.snapshotUnits!('stripchat:1', c.cursor!, 1)).items).toEqual([]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('uses the same global creation order for live commits and historical unit discovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-order-')),
    archive = await openArchive({ root });
  const commit = (subjectId: string, at: number) =>
    archive.commit({
      subjectId,
      sourceEpoch: 'e',
      sourceSequence: String(at),
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([
      { id: 'stripchat:1', providerId: 1, handle: 'a' },
      { id: 'stripchat:2', providerId: 2, handle: 'b' },
    ]);
    await commit('stripchat:1', 62000);
    const first = await commit('stripchat:2', 62000);
    const page = await archive.snapshotUnits!('stripchat:2');
    expect((JSON.parse(page.cursor!) as [number, string])[0]).toBe(2);
    expect(page.items[0].unitId).toBe(first.id);
    const next = await commit('stripchat:2', 122000),
      tail = await archive.snapshotUnits!('stripchat:2', page.cursor!);
    expect((JSON.parse(tail.cursor!) as [number, string])[0]).toBe(3);
    expect(tail.items.map((item) => item.unitId)).toEqual([next.id]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('observes background index and orphan work without creating new maintenance runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-observation-')),
    archive = await openArchive({ root });
  try {
    const first = await archive.backgroundTasks!();
    const second = await archive.backgroundTasks!();
    expect(first.map((task) => task.id)).toEqual([
      'favorite-materialization',
      'library-checkpoint',
      'archive-index',
      'orphan-sweep',
    ]);
    expect(first.find((task) => task.id === 'archive-index')).toMatchObject({
      state: 'idle',
      processed: 0,
      error: null,
    });
    expect(second.find((task) => task.id === 'archive-index')?.processed).toBe(0);
    expect(JSON.stringify(second)).not.toContain(root);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
