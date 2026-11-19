import { expect, it } from 'vitest';
import { isSnapshotLiked, snapshotKey } from './snapshot-identity';
it('uses immutable unit identity for both cell keys and favorite ownership', () => {
  expect(snapshotKey({ unitId: 'one' })).toBe('one');
  expect(isSnapshotLiked({ unitId: 'one' }, [{ id: 'one' }])).toBe(true);
  expect(isSnapshotLiked({ unitId: 'two' }, [{ id: 'one' }])).toBe(false);
});
