import { expect, it } from 'vitest';
import { hoverMediaTime, previewPosition, samePreviewUnit } from './hover-preview';

it('reuses only the resolved unit inside the same subject and coverage revision', () => {
  const resolved = { id: 'stripchat:1', revision: 7, fromMs: 100, toMs: 200 };
  expect(samePreviewUnit(resolved, { id: 'stripchat:1', revision: 7, at: 100 })).toBe(true);
  expect(samePreviewUnit(resolved, { id: 'stripchat:1', revision: 7, at: 199 })).toBe(true);
  for (const point of [
    { id: 'stripchat:1', revision: 7, at: 200 },
    { id: 'stripchat:1', revision: 7, at: 99 },
    { id: 'stripchat:2', revision: 7, at: 150 },
    { id: 'stripchat:1', revision: 8, at: 150 },
  ])
    expect(samePreviewUnit(resolved, point)).toBe(false);
  expect(samePreviewUnit(null, { id: 'stripchat:1', revision: 7, at: 150 })).toBe(false);
});

it('only previews occupied media bounds, including subpixel recordings', () => {
  const buckets = [
    { fromMs: 0, toMs: 1000, coveredMs: 10, segmentCount: 1, mediaFromMs: 200, mediaToMs: 210 },
    { fromMs: 1000, toMs: 2000, coveredMs: 0, segmentCount: 0 },
  ];
  expect(hoverMediaTime(buckets, 205, 1)).toBe(205);
  expect(hoverMediaTime(buckets, 210, 1)).toBeNull();
  expect(hoverMediaTime(buckets, 215, 20)).toBe(209);
  expect(hoverMediaTime(buckets, 190, 20)).toBeNull();
  expect(hoverMediaTime(buckets, 1500, 20)).toBeNull();
});

it('fits the recording lane height beside the pointer, preferring the right side', () => {
  const bounds = { left: 300, right: 1000, top: 100, bottom: 190 };
  expect(previewPosition(500, 140, bounds)).toEqual({
    left: 512,
    top: 100,
    width: 160,
    height: 90,
  });
  expect(previewPosition(950, 185, bounds)).toEqual({
    left: 778,
    top: 100,
    width: 160,
    height: 90,
  });
});
it('shrinks to the available side, preserves 16:9, and rejects invisible lanes', () => {
  const small = previewPosition(350, 125, { left: 300, right: 420, top: 100, bottom: 190 })!;
  expect(small.left).toBe(362);
  expect(small.width).toBe(58);
  expect(small.height).toBeCloseTo((58 * 9) / 16);
  expect(small.top).toBeGreaterThanOrEqual(100);
  expect(small.top + small.height).toBeLessThanOrEqual(190);
  expect(previewPosition(350, 120, { left: 300, right: 400, top: 100, bottom: 100 })).toBeNull();
});
it('caps large rows and stays inside a partially visible recording lane', () => {
  expect(previewPosition(500, 105, { left: 300, right: 1000, top: 100, bottom: 400 })).toEqual({
    left: 512,
    top: 100,
    width: 240,
    height: 135,
  });
  const partial = previewPosition(500, 5, { left: 300, right: 1000, top: 0, bottom: 20 })!;
  expect(partial.top).toBe(0);
  expect(partial.height).toBe(20);
  expect(partial.width).toBeCloseTo((20 * 16) / 9);
});
