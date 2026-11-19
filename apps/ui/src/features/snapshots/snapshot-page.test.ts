import { expect, it } from 'vitest';
import type { SnapshotItem, SnapshotPagesResponse } from '@st-vault/api-schema';
import {
  snapshotGridSlots,
  projectSnapshotPacket,
  snapshotPageAt,
  snapshotPlaybackPage,
  nearestSnapshotPage,
  liveSnapshotPresentation,
} from './snapshot-page';
const item = (at: number, end = at + 2000, index = 0) =>
  ({
    unitId: `u-${at}`,
    atMs: at,
    slotFromMs: at,
    slotToMs: end,
    gridIndex: index,
    url: `/${at}.jpg`,
  }) as SnapshotItem;
it('projects a waiting live tail before the next metadata heartbeat, without inventing media', () => {
  const units = [{ ...item(1000, 59000), open: true }];
  const before = liveSnapshotPresentation(units, { fromMs: 0, toMs: 59999 });
  expect(before.cells.map((cell) => cell.kind)).toEqual(['unit']);
  const after = liveSnapshotPresentation(units, { fromMs: 0, toMs: 61000 });
  expect(after.cells.map((cell) => cell.kind)).toEqual(['unit', 'pending']);
  expect(after.cells[1].fromMs).toBe(60000);
  expect(units[0].slotToMs).toBe(59000);
  const slots = snapshotGridSlots(after.items, { fromMs: 0, toMs: 61000 }, 1, 30, after.cells, 0);
  expect(slots[0]).toEqual(after.items[0]);
  expect(slots[1]).toMatchObject({ kind: 'pending', fromMs: 60000 });
  expect(slots.slice(2)).toEqual(Array(28).fill(null));
});
it('bounds a full live page and hands pending ownership to a unit independently of its JPEG', () => {
  const units = Array.from({ length: 30 }, (_, i) => ({
    ...item(i * 60000, (i + 1) * 60000 - 1000, i),
    open: i === 29,
  }));
  const range = { fromMs: 0, toMs: 1801000 };
  const waiting = liveSnapshotPresentation(units, range);
  expect(waiting.cells).toHaveLength(30);
  expect(waiting.items[0].unitId).toBe(units[1].unitId);
  expect(waiting.cells.at(-1)?.kind).toBe('pending');
  const next = { ...item(1800000, 1800500), open: true, url: '/not-generated-yet.jpg' };
  const ready = liveSnapshotPresentation(
    [...units.map((u) => ({ ...u, open: false })), next],
    range,
  );
  expect(ready.cells).toHaveLength(30);
  expect(ready.cells.at(-1)).toMatchObject({ kind: 'unit', unitId: next.unitId });
  expect(ready.items.at(-1)?.url).toBe('/not-generated-yet.jpg');
});
it('lays out sparse live coverage and compressed gaps from the front without filling unused capacity', () => {
  const units = [item(1000, 59000), item(300000, 359000), { ...item(360000, 380000), open: true }];
  const range = { fromMs: 1000, toMs: 390000 };
  const presentation = liveSnapshotPresentation(units, range);
  const slots = snapshotGridSlots(presentation.items, range, 1, 30, presentation.cells, 0);
  expect(slots[0]).toMatchObject({ unitId: units[0].unitId });
  expect(slots.slice(1, 4).map((cell) => (cell && 'kind' in cell ? cell.kind : null))).toEqual([
    'gap',
    'gap',
    'gap',
  ]);
  expect(slots[4]).toMatchObject({ unitId: units[1].unitId });
  expect(slots[5]).toMatchObject({ unitId: units[2].unitId });
  expect(slots.slice(6)).toEqual(Array(24).fill(null));
});
it('follows server page anchors instead of inferring pages from elapsed minutes', () => {
  const range = { fromMs: 0, toMs: 86400000 },
    anchors = [1000, 10000000, 70000000];
  expect(snapshotPlaybackPage(9999999, range, [1, 2, 3], anchors)).toBe(1);
  expect(snapshotPlaybackPage(10000000, range, [1, 2, 3], anchors)).toBe(2);
  expect(snapshotPlaybackPage(70000000, range, [1, 2, 3], anchors)).toBe(3);
  expect(snapshotPlaybackPage(range.toMs, range, [1, 2, 3], anchors)).toBeNull();
  expect(nearestSnapshotPage(3, [1, 2, 6])).toBe(6);
  expect(nearestSnapshotPage(9, [1, 2, 6])).toBe(6);
  expect(nearestSnapshotPage(1, [])).toBe(1);
});
it('retains intersecting whole units through interval contraction without borrowing another page or subject', () => {
  const items = [item(58000, 62000), item(62000, 74000, 1)];
  const packet = {
    range: { fromMs: 0, toMs: 120000 },
    value: {
      subjectId: 's',
      items,
      page: 1,
      limit: 30,
      deletionRevision: 1,
      total: 2,
      pages: 1,
      occupiedPages: [1],
      session: null,
    } as SnapshotPagesResponse,
  };
  const projected = projectSnapshotPacket(packet, 's', { fromMs: 60000, toMs: 75000 }, 1);
  expect(projected?.items).toEqual(items);
  expect(projected?.items[0]).toBe(items[0]);
  expect(projectSnapshotPacket(packet, 'other', packet.range, 1)).toBeNull();
  expect(projectSnapshotPacket(packet, 's', { fromMs: 120000, toMs: 180000 }, 1)).toBeNull();
  expect(projectSnapshotPacket(packet, 's', packet.range, 2)).toBeNull();
  expect(projectSnapshotPacket(packet, 's', packet.range, 2, 60000)?.items).toEqual(items);
  expect(projectSnapshotPacket(packet, 's', packet.range, 2, 90000)).toBeNull();
});
it('retains one complete old snapshot during a range transition instead of mixing new rows and old layout', () => {
  const value = {
    subjectId: 's',
    page: 1,
    items: [item(0, 30000), item(90000, 120000, 2)],
    cells: [{ index: 1, kind: 'gap', fromMs: 30000, toMs: 90000 }],
    total: 2,
    pages: 1,
    occupiedPages: [1],
    limit: 30,
    deletionRevision: 1,
    session: null,
  } as SnapshotPagesResponse;
  const packet = { range: { fromMs: 0, toMs: 120000 }, value };
  expect(projectSnapshotPacket(packet, 's', { fromMs: 90000, toMs: 120000 }, 1)).toBe(value);
});
it('keeps chronological page position as units and gaps before it change', () => {
  const position = {
    subjectId: 's',
    atMs: 70000000,
    range: { fromMs: 0, toMs: 86400000 },
    page: 3,
  };
  expect(snapshotPageAt(position, 's', { fromMs: 60000, toMs: 86400000 }, [60000, 70000000])).toBe(
    2,
  );
  expect(snapshotPageAt(position, 'other', position.range, [0, 70000000])).toBe(1);
  expect(snapshotPageAt(position, 's', { fromMs: 86400000, toMs: 172800000 }, [86400000])).toBe(1);
});
it('keeps a manually chosen ordinal when several pages share the same PDT anchor', () => {
  const range = { fromMs: 0, toMs: 10000 };
  const position = {
    subjectId: 's',
    atMs: 1000,
    range,
    page: 2,
    browsing: true,
    pageAnchors: [1000, 1000, 1000],
  };
  expect(snapshotPageAt(position, 's', range, [1000, 1000, 1000])).toBe(2);
  // A changed layout still resolves chronologically rather than retaining a stale ordinal.
  expect(snapshotPageAt(position, 's', range, [0, 500, 1000, 1000])).toBe(4);
  expect(snapshotPlaybackPage(1000, range, [1, 2, 3], [1000, 1000, 1000])).toBe(3);
});
it('renders explicit finite gaps and full unit identity without rebasing to natural minutes', () => {
  const units = [item(1001, 5000, 0), item(9000000, 9002000, 4)];
  const cells = [
    { index: 1, kind: 'gap' as const, fromMs: 5000, toMs: 9000000, part: 1, parts: 3 },
    { index: 2, kind: 'gap' as const, fromMs: 5000, toMs: 9000000, part: 2, parts: 3 },
    { index: 3, kind: 'gap' as const, fromMs: 5000, toMs: 9000000, part: 3, parts: 3 },
  ];
  const slots = snapshotGridSlots(units, { fromMs: 0, toMs: 10000000 }, 1, 30, cells);
  expect(slots.slice(0, 5)).toEqual([units[0], ...cells, units[1]]);
  expect(slots.slice(5)).toEqual(Array(25).fill(null));
});
it('honors tail-aligned page offset when the oldest live page is partial', () => {
  const units = [item(1000, 2000, 5), item(61000, 62000, 6)];
  const slots = snapshotGridSlots(units, { fromMs: 0, toMs: 120000 }, 2, 30, [], 5);
  expect(slots.slice(0, 2)).toEqual(units);
});
it('keeps old live images while the next metadata read is pending and updates without decoding the whole batch', () => {
  const items = Array.from({ length: 31 }, (_, i) => item(i * 60000, (i + 1) * 60000, i));
  const before = { fromMs: 0, toMs: 1800000 },
    after = { fromMs: 60000, toMs: 1860000 };
  const old = { subjectId: 's', page: 1, items: items.slice(0, 30) } as SnapshotPagesResponse;
  const fresh = { ...old, items: items.slice(1) };
  expect(projectSnapshotPacket({ range: before, value: old }, 's', after, 1)).toBe(old);
  expect(projectSnapshotPacket({ range: after, value: fresh }, 's', after, 1)).toBe(fresh);
});
