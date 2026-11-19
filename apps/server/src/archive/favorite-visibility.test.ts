import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
it('removes likes consistently from personal, unit query and coverage at deletion acceptance before unlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-favorite-visible-'));
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
      if (point === 'before-unlink') {
        reached();
        await gate;
      }
    },
  });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'favorite' }]);
    const ids: string[] = [];
    for (const minute of [1, 2])
      ids.push(
        (
          await archive.commit({
            subjectId: 'stripchat:1',
            sourceEpoch: 'e',
            sourceSequence: String(minute),
            init: null,
            bytes: new Uint8Array([1]),
            durationSeconds: 2,
            wallStartMs: minute * 60000,
            timeBasis: 'source-pdt',
            uncertaintyMs: 0,
            discontinuity: false,
          })
        ).id,
      );
    await archive.unitFavorites!('stripchat:1', ids, true, 0);
    expect(await archive.coverage('stripchat:1', 0, 180000, 180)).not.toHaveProperty(
      'protectedSpans',
    );
    expect(
      (await archive.coverage('stripchat:1', 0, 180000, 180, true)).protectedSpans,
    ).toHaveLength(2);
    const plan = await archive.planUnitDeletion!('stripchat:1', [ids[0]]);
    await archive.deleteSelection!('stripchat:1', plan.id, plan.personalRevision);
    await paused;
    expect((await archive.personal('stripchat:1', 0, 180000)).favorites.map((x) => x.id)).toEqual([
      ids[1],
    ]);
    expect(
      (await archive.unitFavoriteQuery!('stripchat:1', ids)).favorites.map((x) => x.id),
    ).toEqual([ids[1]]);
    const coverage = await archive.coverage('stripchat:1', 0, 180000, 180, true);
    expect(coverage.protectedSpans).toHaveLength(1);
    release();
    await archive.resumeDeletions!();
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('includes bounded post-preview growth of A after A closes naturally, without deleting its new B successor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-delete-growth-'));
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'growth' }]);
    const commit = (at: number, sequence: number) =>
      archive.commit({
        subjectId: 'stripchat:1',
        sourceEpoch: 'e',
        sourceSequence: String(sequence),
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 0.1,
        wallStartMs: at,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const a = await commit(65000, 0);
    const preview = await archive.planUnitDeletion!('stripchat:1', [a.id]);
    expect(preview.total).toBe(1);
    for (let n = 1; n <= 130; n++) await commit(65000 + n * 100, n);
    const b = await commit(120000, 131);
    const job = await archive.deleteSelection!('stripchat:1', preview.id, preview.personalRevision);
    expect(job.total).toBe(131);
    await archive.resumeDeletions!();
    expect((await archive.timeline('stripchat:1', 0, 180000)).segments.map((x) => x.id)).toEqual([
      b.id,
    ]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it('cancels explicit unit-id preview preparation before creating or accepting work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-preview-cancel-'));
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'cancel' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      archive.planUnitDeletion!(
        'stripchat:1',
        ['00000000-0000-4000-8000-000000000001'],
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(await archive.deletionJobs!()).toEqual([]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
