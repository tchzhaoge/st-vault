import { expect, it, vi } from 'vitest';
import { RowAnchorStore } from './row-anchor';

it('publishes geometry only to connection subscribers and keeps unchanged snapshots stable', () => {
  const store = new RowAnchorStore();
  const changed = vi.fn();
  const stop = store.subscribe(changed);
  store.set({ y: 200, offscreen: null });
  const visible = store.snapshot();
  store.set({ y: 200, offscreen: null });
  expect(store.snapshot()).toBe(visible);
  expect(changed).toHaveBeenCalledTimes(1);
  store.set({ y: 200, offscreen: 'below' });
  expect(store.snapshot()?.offscreen).toBe('below');
  store.set(null);
  expect(store.snapshot()).toBeNull();
  expect(changed).toHaveBeenCalledTimes(3);
  stop();
  store.set({ y: 20, offscreen: 'filtered' });
  expect(changed).toHaveBeenCalledTimes(3);
});
