import { beforeEach, expect, it } from 'vitest';
import {
  beginDeletionProjection,
  clearDeletionProjections,
  pendingProjection,
  projectionDeletesUnit,
  subtractRanges,
  projectionRanges,
  protectionSubjects,
  adoptDeletionProjection,
  type DeletionProjection,
} from './deletion-projection';
import type { SnapshotItem } from '@st-vault/api-schema';
beforeEach(clearDeletionProjections);
it('uses local favorite ranges immediately and stops demand after server publication', () => {
  expect(protectionSubjects(['s'])).toEqual([]);
  beginDeletionProjection('c', 's', entry.target, entry.ranges, entry.protectedIds, [
    { fromMs: 10, toMs: 20 },
  ]);
  expect(protectionSubjects(['other', 's'])).toEqual(['s']);
  expect(projectionRanges({ ...entry, protectedRanges: [{ fromMs: 10, toMs: 20 }] })).toEqual([
    { fromMs: 0, toMs: 10 },
    { fromMs: 20, toMs: 100 },
  ]);
  adoptDeletionProjection({
    ...entry.job,
    state: 'running',
    updatedAtMs: Date.now() + 1,
    deletionRevision: 4,
  });
  expect(protectionSubjects(['s'])).toEqual([]);
});
const entry: DeletionProjection = {
  job: {
    id: 'c',
    subjectId: 's',
    state: 'preparing',
    total: 0,
    processed: 0,
    reclaimedBytes: 0,
    fromMs: 0,
    toMs: 100,
    createdAtMs: 1,
    updatedAtMs: 1,
    error: null,
  },
  target: { kind: 'range', mode: 'unliked', fromMs: 0, toMs: 100 },
  ranges: [{ fromMs: 0, toMs: 100 }],
  protectedIds: ['liked'],
};
it('retires known units immediately while preserving favorite exceptions', () => {
  expect(
    projectionDeletesUnit(entry, {
      unitId: 'normal',
      slotFromMs: 10,
      slotToMs: 20,
    } as SnapshotItem),
  ).toBe(true);
  expect(
    projectionDeletesUnit(entry, { unitId: 'liked', slotFromMs: 10, slotToMs: 20 } as SnapshotItem),
  ).toBe(false);
  expect(projectionRanges(entry, [{ fromMs: 10, toMs: 20 }])).toEqual([
    { fromMs: 0, toMs: 10 },
    { fromMs: 20, toMs: 100 },
  ]);
});
it('keeps stale reads masked until the acceptance generation arrives, and rolls back failures', () => {
  expect(pendingProjection(entry, 's', 1000)).toBe(true);
  const accepted = { ...entry, job: { ...entry.job, deletionRevision: 4 } };
  expect(pendingProjection(accepted, 's', 3)).toBe(true);
  expect(pendingProjection(accepted, 's', 4)).toBe(false);
  expect(pendingProjection({ ...entry, job: { ...entry.job, state: 'failed' } }, 's', 0)).toBe(
    false,
  );
});
it('does not hide unseen pages with unknown favorite protection before server admission', () => {
  expect(
    projectionDeletesUnit({ ...entry, ranges: [{ fromMs: 0, toMs: 10 }] }, {
      unitId: 'unseen',
      slotFromMs: 20,
      slotToMs: 30,
    } as SnapshotItem),
  ).toBe(false);
});
it('subtracts whole deletion ranges without erasing unrelated coverage', () => {
  expect(
    subtractRanges(
      [{ fromMs: 0, toMs: 100 }],
      [
        { fromMs: 20, toMs: 40 },
        { fromMs: 35, toMs: 60 },
      ],
    ),
  ).toEqual([
    { fromMs: 0, toMs: 20 },
    { fromMs: 60, toMs: 100 },
  ]);
  expect(() =>
    beginDeletionProjection('c', 's', entry.target, entry.ranges, entry.protectedIds),
  ).not.toThrow();
});
