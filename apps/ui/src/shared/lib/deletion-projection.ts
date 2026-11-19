import { useSyncExternalStore } from 'react';
import type {
  MediaDeletionJob,
  MediaDeletionTarget,
  MediaTimeRange,
  SnapshotItem,
} from '@st-vault/api-schema';

export interface DeletionProjection {
  job: MediaDeletionJob;
  target: MediaDeletionTarget;
  ranges: MediaTimeRange[];
  protectedIds: string[];
  protectedRanges?: MediaTimeRange[];
}
let entries: DeletionProjection[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => entries;
function publish(next: DeletionProjection[]): void {
  entries = next.slice(-128);
  listeners.forEach((listener) => listener());
}
export function useDeletionProjections(): DeletionProjection[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function clearDeletionProjections(): void {
  publish([]);
}
export function beginDeletionProjection(
  id: string,
  subjectId: string,
  target: MediaDeletionTarget,
  ranges: MediaTimeRange[],
  protectedIds: string[],
  protectedRanges: MediaTimeRange[] = [],
): void {
  const now = Date.now();
  publish([
    ...entries,
    {
      ranges,
      target,
      protectedIds,
      protectedRanges,
      job: {
        id,
        subjectId,
        state: 'preparing',
        phase: 'units',
        total: 0,
        processed: 0,
        reclaimedBytes: 0,
        fromMs: target.fromMs,
        toMs: target.toMs,
        createdAtMs: now,
        updatedAtMs: now,
        error: null,
      },
    },
  ]);
}
export function adoptDeletionProjection(job: MediaDeletionJob): void {
  const previous = entries.find((entry) => entry.job.id === job.id);
  if (
    !previous ||
    (previous.job.updatedAtMs === job.updatedAtMs &&
      previous.job.state === job.state &&
      previous.job.deletionRevision === job.deletionRevision)
  )
    return;
  publish(entries.map((entry) => (entry.job.id === job.id ? { ...entry, job } : entry)));
}
export function uncertainDeletionProjection(id: string, error: string): void {
  const entry = entries.find((entry) => entry.job.id === id);
  if (entry)
    adoptDeletionProjection({ ...entry.job, error, state: 'retry', updatedAtMs: Date.now() });
}
export function failDeletionProjection(id: string, error: string): void {
  const entry = entries.find((entry) => entry.job.id === id);
  if (entry)
    adoptDeletionProjection({ ...entry.job, state: 'failed', error, updatedAtMs: Date.now() });
}
export function pendingProjection(
  entry: DeletionProjection,
  subjectId: string | null | undefined,
  revision = 0,
): boolean {
  return (
    entry.job.subjectId === subjectId &&
    entry.job.state !== 'failed' &&
    (entry.job.deletionRevision === undefined || revision < entry.job.deletionRevision)
  );
}
export function projectionDeletesUnit(entry: DeletionProjection, item: SnapshotItem): boolean {
  const target = entry.target;
  if (target.kind === 'units') return target.unitIds.includes(item.unitId);
  if (target.patch?.excludeUnitIds?.includes(item.unitId)) return false;
  if (target.patch?.includeUnitIds?.includes(item.unitId)) return true;
  if (target.kind === 'range')
    return (
      item.slotFromMs < target.toMs &&
      item.slotToMs > target.fromMs &&
      (target.mode !== 'unliked' ||
        (!entry.protectedIds.includes(item.unitId) &&
          entry.ranges.some(
            (range) => range.fromMs < item.slotToMs && range.toMs > item.slotFromMs,
          )))
    );
  return entry.ranges.some((range) => range.fromMs < item.slotToMs && range.toMs > item.slotFromMs);
}
export function subtractRanges<T extends MediaTimeRange>(spans: T[], holes: MediaTimeRange[]): T[] {
  return holes.reduce(
    (remaining, hole) =>
      remaining.flatMap((span) => {
        if (hole.toMs <= span.fromMs || hole.fromMs >= span.toMs) return [span];
        return [
          ...(span.fromMs < hole.fromMs ? [{ ...span, toMs: hole.fromMs }] : []),
          ...(span.toMs > hole.toMs ? [{ ...span, fromMs: hole.toMs }] : []),
        ];
      }),
    spans,
  );
}
export function projectionRanges(
  entry: DeletionProjection,
  favorites: MediaTimeRange[] = [],
): MediaTimeRange[] {
  return entry.target.kind === 'range' && entry.target.mode === 'unliked'
    ? subtractRanges(entry.ranges, [...(entry.protectedRanges ?? []), ...favorites])
    : entry.ranges;
}

/** Only unfinished, not-yet-published unliked deletions need a server mask. */
export function protectionSubjects(ids: string[]): string[] {
  return ids.filter((id) =>
    entries.some(
      (entry) =>
        entry.job.subjectId === id &&
        entry.target.kind === 'range' &&
        entry.target.mode === 'unliked' &&
        entry.job.deletionRevision === undefined &&
        !['failed', 'completed'].includes(entry.job.state),
    ),
  );
}
