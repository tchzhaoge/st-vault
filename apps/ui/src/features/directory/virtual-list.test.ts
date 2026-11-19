import { describe, expect, it } from 'vitest';
import {
  SUBJECT_CHUNK_SIZE,
  SUBJECT_ROW_HEIGHT,
  virtualRows,
  reconcileRowViewport,
  revealRowViewport,
  restoreRowViewport,
} from './virtual-list';
it('restores deep list anchors before rendering, even after row reordering', () => {
  const ids = Array.from({ length: 300 }, (_, i) => String(i));
  ids.unshift(ids.splice(210, 1)[0]);
  expect(restoreRowViewport(ids, { id: '210', offset: 17 }, 500, 24).top).toBe(17);
  const restored = restoreRowViewport(ids, { id: '220', offset: 17 }, 500, 24);
  expect(restored.top).toBe(ids.indexOf('220') * SUBJECT_ROW_HEIGHT + 17);
  expect(restored.loaded).toBeGreaterThan(220);
  expect(
    virtualRows(restored.loaded, restored.top, 500).end -
      virtualRows(restored.loaded, restored.top, 500).start,
  ).toBeLessThan(16);
  expect(restoreRowViewport([], { id: 'gone', offset: 17 }, 500, 24)).toEqual({
    top: 0,
    loaded: 0,
  });
});
it('reveals unloaded rows by ID, including both list edges, with a bounded mounted range', () => {
  const ids = Array.from({ length: 300 }, (_, i) => String(i));
  const result = revealRowViewport(ids, '210', 500, 24)!;
  expect(result.top).toBe(210 * SUBJECT_ROW_HEIGHT - (500 - SUBJECT_ROW_HEIGHT) / 2);
  expect(result.loaded).toBeGreaterThan(210);
  const mounted = virtualRows(result.loaded, result.top, 500);
  expect(mounted.start).toBeLessThanOrEqual(210);
  expect(mounted.end).toBeGreaterThan(210);
  expect(mounted.end - mounted.start).toBeLessThan(16);
  expect(revealRowViewport(ids, '0', 500, 24)?.top).toBe(0);
  expect(revealRowViewport(ids, '299', 500, 24)?.top).toBe(300 * SUBJECT_ROW_HEIGHT - 500);
  expect(revealRowViewport(ids, 'missing', 500, 24)).toBeNull();
  expect(revealRowViewport([], '0', 500, 0)).toBeNull();
});
describe('refresh scroll anchoring', () => {
  const ids = Array.from({ length: 120 }, (_, i) => String(i)),
    height = 400;
  it('keeps the browsing neighborhood when the top row moves after footage deletion', () => {
    const next = ids.filter((id) => id !== '60');
    next.push('60');
    expect(
      reconcileRowViewport(ids, next, 60 * SUBJECT_ROW_HEIGHT + 9, height, 96, false).top,
    ).toBe(60 * SUBJECT_ROW_HEIGHT + 9);
  });
  it('preserves the same first visible subject and fractional offset after sorting', () => {
    const next = [...ids.slice(80), ...ids.slice(0, 80)];
    const result = reconcileRowViewport(ids, next, 10 * SUBJECT_ROW_HEIGHT + 17, height, 24, false);
    expect(result.top).toBe(50 * SUBJECT_ROW_HEIGHT + 17);
    expect(result.loaded).toBeGreaterThanOrEqual(
      Math.ceil(50 + (17 + height) / SUBJECT_ROW_HEIGHT),
    );
  });
  it('does not reset scroll or loaded chunks when refreshed membership grows', () => {
    expect(
      reconcileRowViewport(ids, ['new', ...ids], 60 * SUBJECT_ROW_HEIGHT + 9, height, 96, false),
    ).toEqual({
      top: 61 * SUBJECT_ROW_HEIGHT + 9,
      loaded: 96,
    });
  });
  it('uses the next surviving neighbor if the anchor leaves a status filter', () => {
    expect(
      reconcileRowViewport(
        ids,
        ids.filter((id) => id !== '60'),
        60 * SUBJECT_ROW_HEIGHT + 9,
        height,
        96,
        false,
      ).top,
    ).toBe(60 * SUBJECT_ROW_HEIGHT + 9);
    expect(
      reconcileRowViewport(ids, ids.slice(0, 60), 60 * SUBJECT_ROW_HEIGHT + 9, height, 96, false)
        .top,
    ).toBe(60 * SUBJECT_ROW_HEIGHT + 28 - height);
  });
  it('resets only for an explicit filter change, and handles empty results', () => {
    expect(reconcileRowViewport(ids, ids, 1000, height, 96, true)).toEqual({ top: 0, loaded: 24 });
    expect(reconcileRowViewport(ids, [], 1000, height, 96, false)).toEqual({ top: 0, loaded: 0 });
    expect(reconcileRowViewport(ids, ['replacement'], 1000, 30, 96, false)).toEqual({
      top: 0,
      loaded: 1,
    });
  });
  it('leaves unchanged rows and pagination scroll offsets alone', () => {
    expect(reconcileRowViewport(ids, [...ids], 1000, height, 72, false)).toEqual({
      top: 1000,
      loaded: 72,
    });
  });
});
describe('bounded subject rendering', () => {
  it('uses a compact shared row height for covers and recording lanes', () => {
    expect(SUBJECT_ROW_HEIGHT).toBe(116);
  });
  it('starts with one bounded chunk and only mounts viewport plus overscan', () => {
    expect(SUBJECT_CHUNK_SIZE).toBe(24);
    const range = virtualRows(10000, 0, 500);
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThanOrEqual(15);
  });
  it('unmounts far rows in either scroll direction without losing scroll extent', () => {
    const range = virtualRows(10000, 1000 * SUBJECT_ROW_HEIGHT, 500);
    expect(range.start).toBeGreaterThan(990);
    expect(range.end - range.start).toBeLessThanOrEqual(15);
    expect(virtualRows(10000, 0, 500).start).toBe(0);
  });
  it('clamps empty and shortened lists', () => {
    expect(virtualRows(0, 100000, 500)).toEqual({ start: 0, end: 0 });
    expect(virtualRows(3, 100000, 500)).toEqual({ start: 2, end: 3 });
  });
});
