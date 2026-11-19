import type { MediaTimeRange, SnapshotCell } from './index.js';

export const recordingGapParts = (from: number, to: number): number =>
  Math.min(3, Math.max(0, Math.floor((to - from) / 60000)));

/** Presentation ownership of a growing minute; never a playable/deletable boundary. */
export function recordingDisplayEnd(
  start: number,
  end: number,
  open: boolean,
  live: boolean,
): number {
  return live && open ? Math.max(end, (Math.floor(start / 60000) + 1) * 60000) : end;
}

/** A gap is presentation only; it never creates a selectable media unit. */
export function recordingLayout(
  units: { id: string; start: number; end: number; closed?: number }[],
  window: MediaTimeRange,
  live = false,
): SnapshotCell[] {
  const cells: SnapshotCell[] = [];
  const gap = (fromMs: number, toMs: number, kind: 'gap' | 'pending' = 'gap'): void => {
    if (toMs <= fromMs) return;
    const parts = kind === 'pending' ? 1 : recordingGapParts(fromMs, toMs);
    for (let part = 0; part < parts; part++)
      cells.push({ index: cells.length, kind, fromMs, toMs, part, parts });
  };
  let cursor = window.fromMs;
  for (const unit of units) {
    gap(cursor, unit.start);
    cells.push({
      index: cells.length,
      kind: 'unit',
      unitId: unit.id,
      fromMs: unit.start,
      toMs: unit.end,
    });
    cursor = Math.max(cursor, recordingDisplayEnd(unit.start, unit.end, unit.closed === 0, live));
  }
  if (units.length) gap(cursor, window.toMs, live ? 'pending' : 'gap');
  if (live) {
    // Keep the latest whole units and their spacing in one presentation page.
    // A leading gap would reserve space outside the effective live window.
    cells.splice(0, Math.max(0, cells.length - 30));
    const first = cells.findIndex((cell) => cell.kind === 'unit');
    cells.splice(0, first < 0 ? cells.length : first);
  }
  for (let offset = 0; offset < cells.length; offset += 30) {
    if (cells.slice(offset, offset + 30).every((cell) => cell.kind !== 'unit')) {
      cells.splice(offset, Math.min(30, cells.length - offset));
      offset -= 30;
    }
  }
  return cells.map((cell, index) => ({ ...cell, index }));
}
