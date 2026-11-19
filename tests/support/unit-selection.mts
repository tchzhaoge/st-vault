import type { ArchivePort } from '../../apps/server/src/ports.js';
import type { MediaTimeRange } from '../../packages/api-schema/src/index.js';
async function selectedUnits(archive: ArchivePort, id: string, ranges: MediaTimeRange[]) {
  const ids = new Set<string>();
  for (const range of ranges) {
    let page = 1;
    while (true) {
      const result = await archive.snapshotPages!(id, range.fromMs, page, 1000, range);
      for (const item of result.items) ids.add(item.unitId);
      if (page >= result.pages) break;
      page++;
    }
  }
  return [...ids];
}
/** Test callers select real units instead of constructing obsolete minute marks. */
export async function like(
  archive: ArchivePort,
  id: string,
  ranges: (MediaTimeRange & { atMs?: number })[],
) {
  const units = await selectedUnits(archive, id, ranges);
  if (!units.length) throw Error('MEDIA_SELECTION_STALE');
  return archive.unitFavorites!(id, units, true, await archive.personalRevision());
}
export async function unlike(
  archive: ArchivePort,
  id: string,
  ranges: MediaTimeRange[],
  revision: number,
) {
  const ids = await selectedUnits(archive, id, ranges);
  const value = await archive.unitFavorites!(id, ids, false, revision);
  return { removed: value.removed, revision: value.revision };
}
