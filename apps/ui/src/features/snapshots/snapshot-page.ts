import type { SnapshotItem, SnapshotPagesResponse, SnapshotCell } from '@st-vault/api-schema';
import { recordingLayout } from '@st-vault/api-schema';
import type { ViewWindow } from '../timeline/range-control';
export const overlappingWindows = (a: ViewWindow, b: ViewWindow): boolean =>
  a.fromMs < b.toMs && b.fromMs < a.toMs;
export interface SnapshotPosition {
  subjectId: string | null;
  atMs: number;
  range: ViewWindow;
  page?: number;
  pageAnchors?: readonly number[];
  browsing?: boolean;
  navigationId?: number;
}
export function nearestSnapshotPage(page: number, occupied: number[]): number {
  return occupied.find((p) => p >= page) ?? occupied.at(-1) ?? 1;
}
export function snapshotPlaybackPage(
  at: number | null,
  range: ViewWindow,
  occupied: number[],
  anchors: number[] = [],
): number | null {
  if (at === null || at < range.fromMs || at >= range.toMs || !occupied.length) return null;
  let index = 0;
  while (index + 1 < anchors.length && anchors[index + 1] <= at) index++;
  return occupied.includes(index + 1) ? index + 1 : null;
}
export function snapshotPageAt(
  position: SnapshotPosition | null,
  subjectId: string | null,
  range: ViewWindow,
  anchors: number[] = [],
): number {
  if (!subjectId || position?.subjectId !== subjectId || !overlappingWindows(position.range, range))
    return 1;
  if (!anchors.length) return position.page ?? 1;
  // Wall-clock anchors are not unique under PDT overlap/backwards clocks. An
  // explicit ordinal belongs to this layout until its window or anchors change.
  if (
    position.page !== undefined &&
    position.page >= 1 &&
    position.page <= anchors.length &&
    position.range.fromMs === range.fromMs &&
    position.range.toMs === range.toMs &&
    position.pageAnchors?.length === anchors.length &&
    position.pageAnchors.every((at, index) => at === anchors[index])
  )
    return position.page;
  let index = 0;
  while (index + 1 < anchors.length && anchors[index + 1] <= position.atMs) index++;
  return index + 1;
}
export function projectSnapshotPacket(
  packet: { range: ViewWindow; value: SnapshotPagesResponse } | null,
  subjectId: string | null,
  range: ViewWindow,
  page: number,
  anchoredAt?: number,
): SnapshotPagesResponse | null {
  if (
    !subjectId ||
    packet?.value.subjectId !== subjectId ||
    !overlappingWindows(packet.range, range)
  )
    return null;
  if (
    packet.value.page !== page &&
    !packet.value.items.some(
      (item) =>
        anchoredAt !== undefined && anchoredAt >= item.slotFromMs && anchoredAt < item.slotToMs,
    )
  )
    return null;
  // An old page is either retained whole for transition or rejected. Filtering
  // its rows alone would combine a new window with old cells/counts/anchors.
  return packet.value;
}
export type SnapshotGap = SnapshotCell & { kind: 'gap' | 'pending' };
/** Reuse archive layout rules between metadata reads; waiting cells are never media. */
export function liveSnapshotPresentation(
  items: SnapshotItem[],
  range: ViewWindow,
): { items: SnapshotItem[]; cells: SnapshotCell[] } {
  const cells = recordingLayout(
    items.map((item) => ({
      id: item.unitId,
      start: item.slotFromMs,
      end: item.slotToMs,
      closed: item.open ? 0 : 1,
    })),
    range,
    true,
  );
  const positions = new Map(cells.map((cell) => [cell.unitId, cell.index]));
  return {
    cells,
    items: items.flatMap((item) => {
      const gridIndex = positions.get(item.unitId);
      return gridIndex === undefined ? [] : [{ ...item, gridIndex }];
    }),
  };
}
export function snapshotGridSlots(
  items: SnapshotItem[],
  _range: ViewWindow,
  page: number,
  count = 30,
  cells: SnapshotCell[] = [],
  pageOffset = (page - 1) * 30,
): (SnapshotItem | SnapshotGap | null)[] {
  const slots: (SnapshotItem | SnapshotGap | null)[] = Array.from({ length: count }, () => null);
  const offset = pageOffset;
  for (const cell of cells)
    if (cell.kind !== 'unit' && cell.index >= offset && cell.index < offset + count)
      slots[cell.index - offset] = cell as SnapshotGap;
  items.forEach((item, index) => {
    const slot = (item.gridIndex ?? offset + index) - offset;
    if (slot >= 0 && slot < count) slots[slot] = item;
  });
  return slots;
}
/** Remove retired cells without throwing away decoded survivors or their page ownership. */
export function projectRemovedUnits(
  items: SnapshotItem[],
  original: SnapshotItem[],
  cells: SnapshotCell[],
  offset: number,
) {
  if (items.length === original.length) return { items, cells };
  if (!items.length) return { items, cells: [] };
  const removed = new Set(
    original
      .filter((item) => !items.some((kept) => kept.unitId === item.unitId))
      .map((item) => item.unitId),
  );
  const kept = cells
    .filter((cell) => !cell.unitId || !removed.has(cell.unitId))
    .map((cell, index) => ({ ...cell, index: offset + index }));
  const positions = new Map(kept.map((cell) => [cell.unitId, cell.index]));
  return {
    cells: kept,
    items: items.map((item, index) => ({
      ...item,
      gridIndex: positions.get(item.unitId) ?? offset + index,
    })),
  };
}
