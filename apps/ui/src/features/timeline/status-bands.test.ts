import { expect, it } from 'vitest';
import { statusBands } from './status-bands';
it('compacts long unknown spans without hiding real changes or modifying API data', () => {
  const buckets = [0, 1, 2].map((i) => ({
    fromMs: i * 10,
    toMs: (i + 1) * 10,
    durationsMs: {
      PUBLIC: i === 2 ? 10 : 0,
      PRIVATE: 0,
      OFFLINE: 0,
      UNKNOWN: i === 2 ? 0 : 10,
    },
  }));
  const original = structuredClone(buckets),
    bands = statusBands(buckets);
  expect(bands.map((band) => [band.fromMs, band.toMs, band.status])).toEqual([
    [0, 20, 'UNKNOWN'],
    [20, 30, 'PUBLIC'],
  ]);
  expect(bands[0].durationsMs.UNKNOWN).toBe(20);
  expect(buckets).toEqual(original);
});
it('does not join across unobserved gaps and keeps ties unknown', () => {
  const bucket = {
    fromMs: 0,
    toMs: 10,
    durationsMs: { PUBLIC: 5, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 5 },
  };
  expect(statusBands([bucket, { ...bucket, fromMs: 20, toMs: 30 }])).toHaveLength(2);
  expect(statusBands([bucket])[0].status).toBe('UNKNOWN');
});
