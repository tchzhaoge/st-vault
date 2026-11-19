import { expect, it } from 'vitest';
import type { FavoriteRange, PersonalTimeline } from '@st-vault/api-schema';
import { mergeFavoriteResult } from './favorite-state';

const favorite = (id: string): FavoriteRange => ({
  id,
  subjectId: 's',
  atMs: 0,
  fromMs: 0,
  toMs: 1000,
  createdAtMs: 0,
});
const current: PersonalTimeline = {
  subjectId: 's',
  fromMs: 0,
  toMs: 2000,
  revision: 4,
  truncated: false,
  favorites: [favorite('first'), favorite('second')],
};
it('applies an unlike reply directly without clearing unrelated page favorites', () => {
  expect(mergeFavoriteResult(current, { revision: 5, favorites: [] }, ['first']).favorites).toEqual(
    [favorite('second')],
  );
});
it('merges a newly liked unit without replacing the complete page snapshot', () => {
  const value = mergeFavoriteResult(current, { revision: 5, favorites: [favorite('third')] }, [
    'third',
  ]);
  expect(value.favorites).toEqual([...current.favorites, favorite('third')]);
  expect(value.revision).toBe(5);
});
it('does not let a stale completion overwrite newer personal facts', () => {
  expect(mergeFavoriteResult(current, { revision: 3, favorites: [] }, ['first'])).toBe(current);
});
