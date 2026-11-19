export interface RowWindow {
  ids: readonly string[];
  top: number;
  height: number;
}
export interface RowMove {
  id: string;
  from: number;
  to: number;
  opacity: [number, number];
  exit: boolean;
}
/** Plan viewport pixels, not a journey through every intermediate list index. */
export function planRowMotion(
  before: RowWindow,
  after: RowWindow,
  rowHeight: number,
  interrupted = new Map<string, number>(),
): RowMove[] {
  const positions = (view: RowWindow) =>
    new Map(view.ids.map((id, index) => [id, index * rowHeight - view.top]));
  const old = positions(before),
    next = positions(after);
  const visible = (y: number | undefined, height: number) =>
    y !== undefined && y < height && y + rowHeight > 0;
  const candidates = new Set<string>();
  for (const view of [before, after]) {
    const first = Math.max(0, Math.floor(view.top / rowHeight));
    for (const id of view.ids.slice(first, Math.ceil((view.top + view.height) / rowHeight)))
      candidates.add(id);
  }
  for (const id of interrupted.keys()) candidates.add(id);
  const moves: RowMove[] = [];
  for (const id of candidates) {
    const previous = interrupted.get(id) ?? old.get(id),
      target = next.get(id);
    if (!visible(previous, before.height) && !visible(target, after.height)) continue;
    const from = Math.max(-rowHeight, Math.min(before.height, previous ?? target! + 16));
    const to = Math.max(-rowHeight, Math.min(after.height, target ?? from - 16));
    const opacity: [number, number] = [
      previous === undefined ? 0 : 1,
      target === undefined ? 0 : 1,
    ];
    if (from === to && opacity[0] === opacity[1]) continue;
    moves.push({ id, from, to, opacity, exit: !visible(target, after.height) });
  }
  return moves;
}
