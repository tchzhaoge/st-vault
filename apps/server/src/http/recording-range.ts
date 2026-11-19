import type { ArchivePort } from '../ports.js';
/** Intersect with real recording coverage, including exclusive right edges.
 * Two indexed lookups avoid loading every fragment of a week-long selection. */
export async function recordingRange(
  archive: Pick<ArchivePort, 'locate' | 'unitBounds'>,
  id: string,
  fromMs: number,
  toMs: number,
): Promise<{ fromMs: number; toMs: number; openUnitId?: string } | null> {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs || fromMs < 0)
    return null;
  if (archive.unitBounds) return archive.unitBounds(id, fromMs, toMs);
  const first = await archive.locate(id, fromMs, 'next');
  if (first?.wallStartMs == null || first.wallEndMs == null || first.wallStartMs >= toMs)
    return null;
  const last = await archive.locate(id, toMs - 1, 'previous');
  if (last?.wallEndMs == null || last.wallStartMs == null || last.wallEndMs <= fromMs) return null;
  const from = Math.max(fromMs, first.wallStartMs),
    to = Math.min(toMs, last.wallEndMs);
  return to > from ? { fromMs: from, toMs: to } : null;
}
