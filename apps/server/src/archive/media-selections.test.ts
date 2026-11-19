import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

const subject = { id: 'stripchat:1', providerId: 1, handle: 'selection' };
it('freezes a whole-range unliked selection without returning its full catalog', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-selection-'));
  const a = await openArchive({ root });
  const commit = (sequence: number) =>
    a.commit({
      subjectId: subject.id,
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
  try {
    await a.upsertSubjects([subject]);
    const first = await commit(1),
      second = await commit(2),
      third = await commit(3);
    await a.unitFavorites!(subject.id, [first.id], true, 0);
    const selection = await a.prepareMediaSelection!(
      subject.id,
      { fromMs: 0, toMs: 600000 },
      'unliked',
    );
    expect(selection).toMatchObject({ count: 2, personalRevision: 1 });
    expect(selection).not.toHaveProperty('items');
    const later = await commit(4);
    const result = await a.favoriteMediaSelection!(subject.id, selection.id, true, 1, {});
    expect(result).toMatchObject({ count: 2, revision: 2 });
    const favorites = await a.unitFavoriteQuery!(subject.id, [
      first.id,
      second.id,
      third.id,
      later.id,
    ]);
    expect(favorites.favorites.map((x) => x.id).sort()).toEqual(
      [first.id, second.id, third.id].sort(),
    );
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects stale selection versions before changing any favorite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-selection-version-'));
  const a = await openArchive({ root });
  try {
    await a.upsertSubjects([subject]);
    const segment = await a.commit({
      subjectId: subject.id,
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
    const selected = await a.prepareMediaSelection!(subject.id, { fromMs: 0, toMs: 120000 }, 'all');
    await a.unitFavorites!(subject.id, [segment.id], true, 0);
    await expect(a.favoriteMediaSelection!(subject.id, selected.id, false, 0, {})).rejects.toThrow(
      'MEDIA_SELECTION_STALE',
    );
    expect((await a.unitFavoriteQuery!(subject.id, [segment.id])).favorites).toHaveLength(1);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('unions range selections and exceptions without changing the base token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-selection-union-'));
  const a = await openArchive({ root });
  try {
    await a.upsertSubjects([subject]);
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++)
      ids.push(
        (
          await a.commit({
            subjectId: subject.id,
            sourceEpoch: 'e',
            sourceSequence: String(i),
            init: null,
            bytes: new Uint8Array([1]),
            durationSeconds: 2,
            wallStartMs: i * 60000,
            timeBasis: 'source-pdt',
            uncertaintyMs: 0,
            discontinuity: false,
          })
        ).id,
      );
    const base = await a.prepareMediaSelection!(subject.id, { fromMs: 60000, toMs: 122000 }, 'all');
    const union = await a.prepareMediaSelection!(
      subject.id,
      { fromMs: 180000, toMs: 242000 },
      'all',
      undefined,
      { baseSelectionId: base.id, excludeUnitIds: [ids[0]] },
    );
    expect(base.count).toBe(2);
    expect(union.count).toBe(3);
    const plan = await a.planMediaSelectionDeletion!(subject.id, union.id, {});
    expect(plan.total).toBe(3);
    await a.deleteSelection!(subject.id, plan.id, plan.personalRevision);
    await a.resumeDeletions!();
    expect((await a.timeline(subject.id, 0, 300000)).segments.map((s) => s.id)).toEqual([ids[0]]);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('builds selections in bounded pages and restores frozen identities on another data root', async () => {
  const started = performance.now();
  const timings: Record<string, number> = {};
  const root = await mkdtemp(path.join(tmpdir(), 'stv-selection-pages-'));
  let a = await openArchive({ root });
  try {
    await a.upsertSubjects([subject]);
    for (let i = 1; i <= 270; i++)
      await a.commit({
        subjectId: subject.id,
        sourceEpoch: 'e',
        sourceSequence: String(i),
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 1,
        wallStartMs: i * 60000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    timings.seedMs = performance.now() - started;
    const selection = await a.prepareMediaSelection!(
      subject.id,
      { fromMs: 0, toMs: 271 * 60000 },
      'all',
    );
    expect(selection.count).toBe(270);
    timings.preparedMs = performance.now() - started;
    await a.close();
    a = await openArchive({
      root: path.join(root, 'restored'),
      mediaRoot: path.join(root, 'media'),
    });
    timings.restoredMs = performance.now() - started;
    const result = await a.favoriteMediaSelection!(
      subject.id,
      selection.id,
      true,
      selection.personalRevision,
      {},
    );
    expect(result.count).toBe(270);
    expect((await a.personal(subject.id, 0, 271 * 60000)).favorites).toHaveLength(270);
    const projection = await a.coverage(subject.id, 0, 271 * 60000, 12, true);
    expect(projection.protectedSpans!.length).toBeLessThanOrEqual(12);
    console.info(
      JSON.stringify({
        benchmark: 'selection-cold-restore-270',
        ...timings,
        totalMs: performance.now() - started,
      }),
    );
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
  // Includes 270 durable media commits and a cold replay; throughput is measured separately.
}, 60000);
