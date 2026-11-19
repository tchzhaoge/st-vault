import type { FavoriteRange, SnapshotItem } from '@st-vault/api-schema';
export const snapshotKey = (item: Pick<SnapshotItem, 'unitId'>): string => item.unitId;
export function isSnapshotLiked(
  item: Pick<SnapshotItem, 'unitId'>,
  favorites: Pick<FavoriteRange, 'id'>[],
): boolean {
  return favorites.some((favorite) => favorite.id === item.unitId);
}
