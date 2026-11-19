import { expect, it } from 'vitest';
import { snapshotPlaybackTarget } from './snapshot-playing';
import type { SnapshotItem } from '@st-vault/api-schema';
it('highlights the actual unit rather than another unit with the same UTC', () => {
  const first = { unitId: 'first', atMs: 1000, slotFromMs: 1000, slotToMs: 61000 } as SnapshotItem;
  const second = { ...first, unitId: 'second' };
  expect(snapshotPlaybackTarget([first, second], [], 2000, false, 61000, 'first')).toEqual({
    kind: 'unit',
    item: first,
  });
  expect(snapshotPlaybackTarget([second], [], 2000, false, 61000, 'first')).toBeNull();
});
const snapshotPlaying = (item: Pick<SnapshotItem, 'slotFromMs' | 'slotToMs'>, at: number | null) =>
  snapshotPlaybackTarget([item as SnapshotItem], [], at, false, item.slotToMs) !== null;
it('assigns overlapping boundaries to the newer unit immediately in live and archive views', () => {
  const previous = { unitId: 'previous', atMs: 0, slotFromMs: 0, slotToMs: 60019 } as SnapshotItem;
  const clicked = {
    unitId: 'clicked',
    atMs: 60000,
    slotFromMs: 60000,
    slotToMs: 120000,
  } as SnapshotItem;
  for (const live of [true, false]) {
    expect(snapshotPlaybackTarget([previous, clicked], [], clicked.atMs, live, 120000)).toEqual({
      kind: 'unit',
      item: clicked,
    });
    expect(snapshotPlaybackTarget([clicked, previous], [], clicked.atMs, live, 120000)).toEqual({
      kind: 'unit',
      item: clicked,
    });
    expect(snapshotPlaybackTarget([previous, clicked], [], 59999, live, 120000)).toEqual({
      kind: 'unit',
      item: previous,
    });
  }
});
it('follows fixed minutes and transfers at the exclusive boundary', () => {
  const first = { atMs: 12345, slotFromMs: 10000, slotToMs: 70000 },
    next = { atMs: 71000, slotFromMs: 70000, slotToMs: 130000 };
  expect(snapshotPlaying(first, 69999)).toBe(true);
  expect(snapshotPlaying(first, 70000)).toBe(false);
  expect(snapshotPlaying(next, 70000)).toBe(true);
  expect(snapshotPlaying(first, null)).toBe(false);
  expect(snapshotPlaying(first, 9999)).toBe(false);
});
it('uses the same full minute for a live tail and clipped replay without a mode-specific extension', () => {
  const tail = { atMs: 10000, slotFromMs: 0, slotToMs: 60000 };
  expect(snapshotPlaying(tail, 30000)).toBe(true);
  expect(snapshotPlaying(tail, 60000)).toBe(false);
});
it('keeps a live open unit highlighted while fragment commits lag, without changing archive bounds', () => {
  const item = {
    unitId: 'u',
    open: true,
    atMs: 1000,
    slotFromMs: 1000,
    slotToMs: 5000,
  } as SnapshotItem;
  expect(snapshotPlaybackTarget([item], [], 20000, true, 30000)).toEqual({ kind: 'unit', item });
  expect(snapshotPlaying(item, 20000)).toBe(false);
  expect(snapshotPlaybackTarget([item], [], 20000, false, 30000)).toBeNull();
  expect(snapshotPlaybackTarget([{ ...item, open: false }], [], 20000, true, 30000)).toBeNull();
  expect(snapshotPlaybackTarget([item], [], 60000, true, 65000)).toBeNull();
  expect(item.slotToMs).toBe(5000);
});
it('marks the actual pending position at rollover, then transfers to the committed successor', () => {
  const item = {
    unitId: 'u',
    open: true,
    atMs: 1000,
    slotFromMs: 1000,
    slotToMs: 59000,
  } as SnapshotItem;
  const cells = [{ index: 1, kind: 'pending' as const, fromMs: 60000, toMs: 61000 }];
  expect(snapshotPlaybackTarget([item], cells, 62000, true, 65000)).toEqual({
    kind: 'pending',
    fromMs: 60000,
  });
  expect(snapshotPlaybackTarget([item], cells, 62000, false, 65000)).toBeNull();
  const next = { ...item, unitId: 'v', slotFromMs: 61000, slotToMs: 63000 };
  expect(snapshotPlaybackTarget([item, next], cells, 62000, true, 65000)).toEqual({
    kind: 'unit',
    item: next,
  });
  expect(snapshotPlaybackTarget([item], cells, 65000, true, 65000)).toBeNull();
});
it('follows media time rather than JPEG readiness or the newest wall-clock cell', () => {
  const previous = { unitId: 'previous', slotFromMs: 0, slotToMs: 60000, atMs: 0 } as SnapshotItem;
  const next = {
    unitId: 'next',
    open: true,
    slotFromMs: 60000,
    slotToMs: 62000,
    atMs: 60000,
    url: '/still-pending.jpg',
  } as SnapshotItem;
  expect(snapshotPlaybackTarget([previous, next], [], 59000, true, 65000)).toEqual({
    kind: 'unit',
    item: previous,
  });
  expect(snapshotPlaybackTarget([previous, next], [], 63000, true, 65000)).toEqual({
    kind: 'unit',
    item: next,
  });
});
