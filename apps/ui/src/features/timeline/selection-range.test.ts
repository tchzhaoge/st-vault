import { expect, it } from 'vitest';
import { dragRange, snapRange, snapCoverageRange } from './selection-range';
it('normalizes both drag directions without half-hour rounding and clamps to available time', () => {
  const limits = { fromMs: 1000, toMs: 90000 };
  expect(dragRange(12123, 45678, limits)).toEqual({
    fromMs: 12123,
    toMs: 45678,
  });
  expect(dragRange(45678, 12123, limits)).toEqual({
    fromMs: 12123,
    toMs: 45678,
  });
  expect(dragRange(-5000, 100000, limits)).toEqual(limits);
  expect(dragRange(12345, 12345, limits)).toBeNull();
});

it('snaps locally to media edges without rounding to coverage bucket boundaries', () => {
  const coverage = {
    subjectId: 'one',
    fromMs: 0,
    toMs: 10000,
    revision: 1,
    unlocatedCount: 0,
    buckets: [
      {
        fromMs: 0,
        toMs: 5000,
        coveredMs: 500,
        segmentCount: 1,
        mediaFromMs: 1200,
        mediaToMs: 1700,
      },
      {
        fromMs: 5000,
        toMs: 10000,
        coveredMs: 400,
        segmentCount: 1,
        mediaFromMs: 8200,
        mediaToMs: 8600,
      },
    ],
  };
  expect(snapCoverageRange({ fromMs: 0, toMs: 10000 }, coverage)).toEqual({
    fromMs: 1200,
    toMs: 8600,
  });
  expect(snapCoverageRange({ fromMs: 1250, toMs: 1500 }, coverage)).toEqual({
    fromMs: 1250,
    toMs: 1500,
  });
  expect(snapCoverageRange({ fromMs: 2000, toMs: 7000 }, coverage)).toBeNull();
  expect(snapCoverageRange({ fromMs: 0, toMs: 10000 }, undefined)).toEqual({
    fromMs: 0,
    toMs: 10000,
  });
});
it('snaps only excess edges, preserving internal coordinates and rejecting empty intersections', () => {
  const bounds = { fromMs: 10000, toMs: 50000 };
  expect(snapRange({ fromMs: 0, toMs: 60000 }, bounds)).toEqual(bounds);
  expect(snapRange({ fromMs: 15000, toMs: 45000 }, bounds)).toEqual({
    fromMs: 15000,
    toMs: 45000,
  });
  expect(snapRange({ fromMs: 0, toMs: 10000 }, bounds)).toBeNull();
  expect(snapRange({ fromMs: 10000, toMs: 50000 }, null)).toBeNull();
});
