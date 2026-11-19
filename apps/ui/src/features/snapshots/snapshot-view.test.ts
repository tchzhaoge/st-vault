import { expect, it } from 'vitest';
import type { SnapshotPagesResponse } from '@st-vault/api-schema';
import { SnapshotViewController } from './snapshot-view';
const packet = (revision: number) =>
  ({ subjectId: 's', deletionRevision: revision }) as SnapshotPagesResponse;
it('refuses earlier requests and earlier deletion generations independently', () => {
  const view = new SnapshotViewController();
  const first = view.invalidate();
  expect(view.accept(first, packet(4))).toBe(true);
  const next = view.invalidate();
  expect(view.accept(first, packet(5))).toBe(false);
  expect(view.accept(next, packet(3))).toBe(false);
  expect(view.accept(next, packet(4))).toBe(true);
  expect(view.accept(next, packet(5))).toBe(true);
  expect(view.accept(next, packet(4))).toBe(false);
});
