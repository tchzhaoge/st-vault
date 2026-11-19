import { expect, it } from 'vitest';
import { DeletionObserver, deletionAffectsPlayback } from './media-deletion';
import type { MediaDeletionJob } from '@st-vault/api-schema';
import type { MediaDeletePlan } from '@st-vault/api-schema';
const plan = (fromMs: number, toMs: number): MediaDeletePlan => ({
  subjectId: 'stripchat:1',
  ranges: [{ fromMs, toMs }],
  id: 'id',
  total: 1,
  fromMs,
  toMs,
  personalRevision: 0,
  favoriteSegments: 0,
  bytes: 0,
});
const job = (id: string, state: MediaDeletionJob['state'], updatedAtMs = 1): MediaDeletionJob => ({
  id,
  state,
  updatedAtMs,
  subjectId: 'stripchat:1',
  total: 100,
  processed: state === 'completed' ? 100 : 0,
  reclaimedBytes: 0,
  fromMs: 0,
  toMs: 100,
  createdAtMs: 0,
  error: null,
});
it('tracks concurrent submissions before the first heartbeat without losing completed acceptance', () => {
  const observer = new DeletionObserver();
  observer.submit('first');
  observer.submit('second');
  expect(
    observer
      .update([job('first', 'completed'), job('second', 'completed')])
      .accepted.map((value) => value.id),
  ).toEqual(['first', 'second']);
  expect(observer.update([job('first', 'completed'), job('second', 'completed')]).accepted).toEqual(
    [],
  );
});
it('ignores initial completed history but reconciles work completed between heartbeats', () => {
  const observer = new DeletionObserver();
  expect(observer.update([job('old', 'completed')]).accepted).toEqual([]);
  expect(
    observer.update([job('new', 'completed'), job('old', 'completed')]).accepted.map((j) => j.id),
  ).toEqual(['new']);
});
it('recovers a lost acceptance response even when the first heartbeat finds the task completed', () => {
  const observer = new DeletionObserver();
  observer.submit('submitted');
  expect(
    observer
      .update([job('submitted', 'completed'), job('old', 'completed')])
      .accepted.map((j) => j.id),
  ).toEqual(['submitted']);
  expect(observer.remember(job('submitted', 'queued', 0))).toMatchObject({
    accepted: [],
    jobs: [
      { id: 'submitted', state: 'completed' },
      { id: 'old', state: 'completed' },
    ],
  });
});
it('announces a pending mutation once and reports its completion once', () => {
  const observer = new DeletionObserver();
  expect(observer.remember(job('one', 'queued')).accepted).toHaveLength(1);
  expect(observer.update([job('one', 'running', 2)])).toMatchObject({
    accepted: [],
    settled: false,
  });
  expect(observer.update([job('one', 'completed', 3)])).toMatchObject({
    accepted: [],
    settled: true,
  });
  expect(observer.update([job('one', 'completed', 3)])).toMatchObject({
    accepted: [],
    settled: false,
  });
});
it('does not regress a committed task when an older heartbeat arrives after its POST', () => {
  const observer = new DeletionObserver();
  observer.update([job('one', 'queued', 10)]);
  observer.remember(job('one', 'completed', 20));
  expect(observer.update([job('one', 'queued', 10)])).toMatchObject({
    jobs: [{ state: 'completed', updatedAtMs: 20 }],
    accepted: [],
    settled: false,
  });
  expect(observer.update([job('one', 'completed', 20)]).settled).toBe(false);
});
it('retains an accepted task missing from an earlier in-flight inventory', () => {
  const observer = new DeletionObserver();
  observer.update([]);
  observer.remember(job('new', 'queued', 20));
  expect(observer.update([]).jobs).toMatchObject([{ id: 'new', state: 'queued' }]);
});
it('keeps newer accepted intent when an older inventory fills the bounded task list', () => {
  const observer = new DeletionObserver();
  const inventory = Array.from({ length: 84 }, (_, i) => job(`old-${i}`, 'completed', 1));
  observer.update(inventory);
  observer.remember(job('new', 'queued', 20));
  expect(observer.update(inventory).jobs).toContainEqual(job('new', 'queued', 20));
  expect(observer.update([job('new', 'running', 30)]).accepted).toEqual([]);
});
it.each([
  [0, 10, true],
  [90, 100, true],
  [40, 50, true],
  [-10, 0, false],
  [100, 110, false],
])('invalidates the complete archive dependency for [%s,%s)', (from, to, affected) => {
  expect(
    deletionAffectsPlayback(
      { subjectId: 'stripchat:1', plan: plan(from, to) },
      { subjectId: 'stripchat:1', kind: 'archive', range: { fromMs: 0, toMs: 100 } },
    ),
  ).toBe(affected);
});
it('does not affect live consumers or another subject', () => {
  const event = { subjectId: 'stripchat:1', plan: plan(0, 100) };
  expect(
    deletionAffectsPlayback(event, {
      subjectId: 'stripchat:1',
      kind: 'live',
      range: { fromMs: 0, toMs: 100 },
    }),
  ).toBe(false);
  expect(
    deletionAffectsPlayback(event, {
      subjectId: 'stripchat:2',
      kind: 'archive',
      range: { fromMs: 0, toMs: 100 },
    }),
  ).toBe(false);
});
