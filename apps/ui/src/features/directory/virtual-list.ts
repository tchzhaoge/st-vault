export const SUBJECT_CHUNK_SIZE = 24;
export const SUBJECT_ROW_HEIGHT = 116;
export const SUBJECT_OVERSCAN = 3;
export function restoreRowViewport(
  ids: string[],
  position: { id: string; offset: number },
  height: number,
  loaded: number,
): { top: number; loaded: number } {
  const index = Math.max(0, ids.indexOf(position.id));
  const top = Math.max(
    0,
    Math.min(
      index * SUBJECT_ROW_HEIGHT + Math.min(SUBJECT_ROW_HEIGHT - 1, position.offset),
      ids.length * SUBJECT_ROW_HEIGHT + 28 - height,
    ),
  );
  return {
    top,
    loaded: Math.min(ids.length, Math.max(loaded, Math.ceil((top + height) / SUBJECT_ROW_HEIGHT))),
  };
}
/** Reveal an ID beyond loaded chunks without mounting intervening rows. */
export function revealRowViewport(
  ids: string[],
  id: string,
  height: number,
  loaded: number,
): { top: number; loaded: number } | null {
  const index = ids.indexOf(id);
  if (index < 0) return null;
  const top = Math.max(
    0,
    Math.min(
      index * SUBJECT_ROW_HEIGHT - (height - SUBJECT_ROW_HEIGHT) / 2,
      ids.length * SUBJECT_ROW_HEIGHT - height,
    ),
  );
  return {
    top,
    loaded: Math.min(
      ids.length,
      Math.max(
        loaded,
        index + 1,
        Math.ceil((top + height) / SUBJECT_ROW_HEIGHT) + SUBJECT_OVERSCAN,
      ),
    ),
  };
}
/** Keep the largest group whose relative order survived a refresh. A row
 * moved by recording/status changes must not drag the browsing viewport along. */
function stableRowIds(previous: string[], positions: Map<string, number>): Set<string> {
  const tails: number[] = [],
    predecessors = new Map<number, number>();
  for (let index = 0; index < previous.length; index++) {
    const position = positions.get(previous[index]);
    if (position === undefined) continue;
    let low = 0,
      high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions.get(previous[tails[middle]])! < position) low = middle + 1;
      else high = middle;
    }
    predecessors.set(index, low ? tails[low - 1] : -1);
    tails[low] = index;
  }
  const stable = new Set<string>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = predecessors.get(index) ?? -1)
    stable.add(previous[index]);
  return stable;
}
/** Anchor the browsing neighborhood, allowing insertions and removals above it. */
export function reconcileRowViewport(
  previous: string[],
  next: string[],
  top: number,
  height: number,
  loaded: number,
  reset: boolean,
): { top: number; loaded: number } {
  if (reset) return { top: 0, loaded: Math.min(SUBJECT_CHUNK_SIZE, next.length) };
  if (
    previous === next ||
    (previous.length === next.length && previous.every((id, index) => id === next[index]))
  )
    return { top, loaded };
  if (!next.length) return { top: 0, loaded: 0 };
  const positions = new Map(next.map((id, index) => [id, index]));
  const stable = stableRowIds(previous, positions);
  const origin = Math.min(previous.length - 1, Math.max(0, Math.floor(top / SUBJECT_ROW_HEIGHT)));
  let target: number | undefined;
  for (let distance = 0; distance < previous.length && target === undefined; distance++) {
    const after = previous[origin + distance],
      before = previous[origin - distance];
    if (stable.has(after)) target = positions.get(after);
    if (target === undefined && stable.has(before)) target = positions.get(before);
  }
  // The fixed-height load sentinel is also part of the native scrolling extent.
  const nextTop = Math.max(
    0,
    Math.min(
      target === undefined ? 0 : target * SUBJECT_ROW_HEIGHT + (top % SUBJECT_ROW_HEIGHT),
      next.length * SUBJECT_ROW_HEIGHT + 28 - height,
    ),
  );
  return {
    top: nextTop,
    loaded: Math.min(
      next.length,
      Math.max(loaded, Math.ceil((nextTop + height) / SUBJECT_ROW_HEIGHT)),
    ),
  };
}
export function virtualRows(
  loaded: number,
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  const start = Math.min(
    Math.max(0, loaded - 1),
    Math.max(0, Math.floor(Math.max(0, scrollTop) / SUBJECT_ROW_HEIGHT) - SUBJECT_OVERSCAN),
  );
  return {
    start,
    end: Math.min(
      loaded,
      start + Math.ceil(viewportHeight / SUBJECT_ROW_HEIGHT) + SUBJECT_OVERSCAN * 2 + 1,
    ),
  };
}
