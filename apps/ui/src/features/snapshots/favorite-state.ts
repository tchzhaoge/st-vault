import type { PersonalTimeline } from '@st-vault/api-schema';

/** Mutation replies contain exact facts for named units, not the whole page. */
export function mergeFavoriteResult(
  current: PersonalTimeline,
  result: Pick<PersonalTimeline, 'favorites' | 'revision'>,
  unitIds: string[],
): PersonalTimeline {
  if (result.revision < current.revision) return current;
  const changed = new Set(unitIds);
  return {
    ...current,
    revision: result.revision,
    favorites: [...current.favorites.filter((item) => !changed.has(item.id)), ...result.favorites],
  };
}

export interface FavoritePreview {
  owner: number;
  scope: string;
  ids: Set<string>;
  liked: boolean;
  revision?: number;
}
