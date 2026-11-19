import { recordingDisplayEnd, type SnapshotItem, type SnapshotCell } from '@st-vault/api-schema';
import { intervalAtIndex } from '../../shared/lib/time';
/** Live ingress is evidence of the displayed time, not evidence of an archived file. */
export function snapshotPlaybackTarget(
  items: SnapshotItem[],
  cells: SnapshotCell[],
  at: number | null,
  live: boolean,
  displayToMs: number,
  unitId?: string,
): { kind: 'unit'; item: SnapshotItem } | { kind: 'pending'; fromMs: number } | null {
  if (at === null) return null;
  if (unitId) {
    const item = items.find((item) => item.unitId === unitId);
    return item ? { kind: 'unit', item } : null;
  }
  const exact =
    items[
      intervalAtIndex(
        items,
        at,
        (item) => item.slotFromMs,
        (item) => item.slotToMs,
      )
    ];
  if (exact) return { kind: 'unit', item: exact };
  if (!live) return null;
  const growing =
    items[
      intervalAtIndex(
        items,
        at,
        (item) => (item.open ? item.slotFromMs : null),
        (item) => recordingDisplayEnd(item.slotFromMs, item.slotToMs, true, true),
      )
    ];
  if (growing) return { kind: 'unit', item: growing };
  const pending = cells.find(
    (cell) => cell.kind === 'pending' && at >= cell.fromMs && at < displayToMs,
  );
  return pending ? { kind: 'pending', fromMs: pending.fromMs } : null;
}
