import { expect, it } from 'vitest';
import {
  coverageBands,
  coverageGeometry,
  coverageSurface,
  splitSeenCoverage,
} from './coverage-bands';
import type { CoverageBucket } from '@st-vault/api-schema';
it('splits seen coverage without filling holes or losing unread subpixel tails', () => {
  const band = (fromMs: number, toMs: number) => ({
    key: fromMs,
    fromMs,
    toMs,
    coveredMs: toMs - fromMs,
    level: 15,
  });
  const result = splitSeenCoverage([band(0, 20), band(40, 60)], [{ fromMs: 10, toMs: 59 }]);
  expect(result[0].bands.map(({ fromMs, toMs }) => [fromMs, toMs])).toEqual([
    [10, 20],
    [40, 59],
  ]);
  expect(result[1].bands.map(({ fromMs, toMs }) => [fromMs, toMs])).toEqual([
    [0, 10],
    [59, 60],
  ]);
  expect(result.flatMap((x) => x.bands).reduce((sum, x) => sum + x.coveredMs, 0)).toBe(40);
});

it('keeps holes and density in separate subpaths without allocating per-fragment nodes', () => {
  const bands = [
    { key: 0, fromMs: 0, toMs: 20, coveredMs: 20, level: 15 },
    { key: 40, fromMs: 40, toMs: 60, coveredMs: 10, level: 8 },
    { key: 80, fromMs: 80, toMs: 100, coveredMs: 20, level: 15 },
  ];
  const surface = coverageSurface(bands, 0, 100, 1000)!;
  expect(surface.paths).toEqual([
    { level: 15, d: 'M0 0h200v100h-200ZM800 0h200v100h-200Z' },
    { level: 8, d: 'M400 0h200v100h-200Z' },
  ]);
  expect(surface.extent.coveredMs).toBe(50);
  expect(bands[0].toMs).toBe(20);
  expect(coverageSurface([], 0, 100, 1000)).toBeNull();
});

it('keeps subpixel fragments visible at both view edges, including overscan', () => {
  const surface = coverageSurface(
    [
      { key: -100, fromMs: -100, toMs: -50, coveredMs: 50, level: 15 },
      { key: 999, fromMs: 999, toMs: 1000, coveredMs: 1, level: 1 },
      { key: 1100, fromMs: 1100, toMs: 1200, coveredMs: 100, level: 15 },
    ],
    0,
    1000,
    100,
  )!;
  const path = surface.paths.find((item) => item.level === 1)!.d;
  const [left, width] = /M([\d.]+) 0h([\d.]+)/.exec(path)!.slice(1).map(Number);
  expect((width * 130) / 1000).toBeCloseTo(1);
  expect(((left + width) * 1300) / 1000 - 100).toBeCloseTo(1000);
});

it('coalesces continuous coverage without mutating the source used for precise selection', () => {
  const buckets: CoverageBucket[] = Array.from({ length: 720 }, (_, index) => ({
    fromMs: index * 1000,
    toMs: (index + 1) * 1000,
    coveredMs: 1000,
    segmentCount: 1,
  }));
  const original = structuredClone(buckets);
  expect(coverageBands(buckets, 0, 720000)).toEqual([
    { key: 0, fromMs: 0, toMs: 720000, coveredMs: 720000, level: 15 },
  ]);
  expect(buckets).toEqual(original);
});
it('keeps real gaps and different density levels separate', () => {
  const buckets = [
    { fromMs: 0, toMs: 1000, coveredMs: 1000, segmentCount: 1 },
    { fromMs: 1000, toMs: 2000, coveredMs: 0, segmentCount: 0 },
    { fromMs: 2000, toMs: 3000, coveredMs: 100, segmentCount: 1 },
    { fromMs: 3000, toMs: 4000, coveredMs: 1000, segmentCount: 1 },
  ];
  expect(coverageBands(buckets, 0, 4000).map(({ fromMs, toMs }) => [fromMs, toMs])).toEqual([
    [0, 1000],
    [2000, 3000],
    [3000, 4000],
  ]);
});
it('merges only gaps smaller than one display pixel and preserves visible gaps', () => {
  const buckets = [
    { fromMs: 0, toMs: 1000, coveredMs: 1000, segmentCount: 1 },
    {
      fromMs: 1000,
      toMs: 2000,
      coveredMs: 999,
      segmentCount: 1,
      mediaFromMs: 1001,
      mediaToMs: 2000,
    },
    {
      fromMs: 2000,
      toMs: 3000,
      coveredMs: 998,
      segmentCount: 1,
      mediaFromMs: 2002,
      mediaToMs: 3000,
    },
  ];
  const original = structuredClone(buckets);
  expect(coverageBands(buckets, 0, 3000, 2).map(({ fromMs, toMs }) => [fromMs, toMs])).toEqual([
    [0, 2000],
    [2002, 3000],
  ]);
  expect(buckets).toEqual(original);
});
it('keeps even one millisecond and uses exact occupied edges rather than the whole bucket', () => {
  expect(
    coverageBands(
      [
        {
          fromMs: 0,
          toMs: 604800000,
          coveredMs: 1,
          segmentCount: 1,
          mediaFromMs: 604799999,
          mediaToMs: 604800000,
        },
      ],
      0,
      604800000,
    ),
  ).toEqual([{ key: 0, fromMs: 604799999, toMs: 604800000, coveredMs: 1, level: 1 }]);
});
it('excludes outside data while retaining overscan geometry and real bounds', () => {
  const bands = coverageBands(
    [
      { fromMs: 0, toMs: 10, coveredMs: 10, segmentCount: 1 },
      { fromMs: 20, toMs: 40, coveredMs: 20, segmentCount: 1 },
      { fromMs: 50, toMs: 60, coveredMs: 10, segmentCount: 1 },
    ],
    25,
    45,
  );
  expect(bands).toEqual([{ key: 20, fromMs: 20, toMs: 40, coveredMs: 20, level: 15 }]);
  expect(coverageGeometry(bands[0], 25, 45)).toEqual({
    left: '-25%',
    width: '100%',
    minWidth: 'calc(1px + 25%)',
  });
});
it('does not pull an offscreen overscan marker into the visible right edge', () => {
  expect(
    coverageGeometry({ key: 100, fromMs: 101, toMs: 102, coveredMs: 1, level: 1 }, 0, 100),
  ).toEqual({ left: '101%', width: '1%', minWidth: '0px' });
});
