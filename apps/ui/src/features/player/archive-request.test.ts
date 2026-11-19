import { expect, it } from 'vitest';
import type { PlaybackResponse } from '@st-vault/api-schema';
import { archiveRange, archiveRequest } from './archive-request';

it('only constrains media to an explicitly selected range', () => {
  expect(archiveRequest('42', 1000, null, 'unit-a')).toMatchObject({
    targetUtcMs: 1000,
    unitId: 'unit-a',
  });
  expect(archiveRequest('42', 50.6, null)).toEqual({
    subjectId: '42',
    targetUtcMs: 51,
    gapPolicy: 'next',
  });
  expect(archiveRequest('42', 500, { fromMs: 100, toMs: 200 })).toMatchObject({
    targetUtcMs: 199,
    fromMs: 100,
    toMs: 200,
  });
  expect(archiveRequest('42', 50, { fromMs: 100, toMs: 200 }).targetUtcMs).toBe(100);
});
it('invalidates the real archive source independently of the moving view', () => {
  const fallback = { fromMs: 10000, toMs: 20000 };
  const playback = { segments: [{ wallStartMs: 100 }], windowEndMs: 500 } as PlaybackResponse;
  expect(archiveRange(playback, fallback)).toEqual({ fromMs: 100, toMs: 20000 });
  expect(archiveRange({ ...playback, rangeFromMs: 50, rangeToMs: 900 }, fallback)).toEqual({
    fromMs: 50,
    toMs: 900,
  });
});
