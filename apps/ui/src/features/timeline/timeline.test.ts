import { describe, expect, it } from 'vitest';
import type { Segment } from '@st-vault/api-schema';
import { formatDateTimePrecise, mediaTimeToUtc, playbackEndUtc, utcToMediaTime } from './timeline';
import { createMediaTimeIndex } from './timeline';

const base: Segment = {
  id: 's1',
  subjectId: 'stripchat:1',
  sourceEpoch: 'e1',
  sourceSequence: '1',
  mediaObjectId: 'm1',
  initObjectId: null,
  durationSeconds: 60,
  wallStartMs: 1_000,
  wallEndMs: 61_000,
  timeBasis: 'source-pdt',
  uncertaintyMs: 0,
  discontinuity: false,
};

describe('fixed UTC timeline window', () => {
  it('indexes manifest progress once and preserves exact boundaries and unknown clocks', () => {
    const segments = Array.from({ length: 2000 }, (_, index) => ({
      ...base,
      id: String(index),
      durationSeconds: 2,
      wallStartMs: index === 7 ? null : index * 3000,
      recordingUnitId: `unit-${index}`,
    }));
    const lookup = createMediaTimeIndex(segments);
    for (const time of [0, 1.9, 2, 14, 15.9, 16, 3999, 4000, -1, NaN])
      expect(lookup(time)?.atMs ?? null).toBe(mediaTimeToUtc(segments, time));
    expect(lookup(3999)?.unitId).toBe('unit-1999');
  });
  it('seeks the explicit unit when two units have identical wall clocks', () => {
    const segments = [
      { ...base, recordingUnitId: 'first' },
      { ...base, id: 's2', recordingUnitId: 'second' },
    ];
    expect(utcToMediaTime(segments, 2000, 'first')).toBe(1);
    expect(utcToMediaTime(segments, 2000, 'second')).toBe(61);
    expect(utcToMediaTime(segments, 2000, 'missing')).toBeNull();
    expect(utcToMediaTime(segments, 2000)).toBe(1);
  });
  it('seeks into the newer fragment when wall-clock intervals overlap', () => {
    const previous = { ...base, wallEndMs: 61019, durationSeconds: 60.019 };
    const next = { ...base, id: 's2', wallStartMs: 61000, wallEndMs: 121000 };
    expect(utcToMediaTime([previous, next], 61000)).toBe(60.019);
    expect(mediaTimeToUtc([previous, next], 60.019)).toBe(61000);
    expect(utcToMediaTime([previous, next], 60999)).toBe(59.999);
  });
  it('shows playback timestamps with millisecond precision', () => {
    expect(formatDateTimePrecise(Date.UTC(2026, 10, 2, 4, 30, 12, 345))).toMatch(/12\.345$/);
  });

  it('maps the media playhead through segment wall-clock boundaries', () => {
    const next = {
      ...base,
      id: 's2',
      wallStartMs: 90_000,
      wallEndMs: 150_000,
      durationSeconds: 60,
    };
    expect(mediaTimeToUtc([base, next], 30)).toBe(31_000);
    expect(mediaTimeToUtc([base, next], 75)).toBe(105_000);
    expect(mediaTimeToUtc([{ ...base, wallStartMs: null }], 10)).toBeNull();
  });

  it('uses the last known wall end only at the explicit ended boundary', () => {
    const sixSecondClip = {
      ...base,
      durationSeconds: 6,
      wallStartMs: 10_000,
      wallEndMs: 16_000,
    };
    expect(mediaTimeToUtc([sixSecondClip], 6.021333)).toBeNull();
    expect(playbackEndUtc([sixSecondClip])).toBe(16_000);
    expect(
      playbackEndUtc([
        sixSecondClip,
        {
          ...sixSecondClip,
          id: 'unknown',
          timeBasis: 'unknown',
          wallStartMs: null,
          wallEndMs: null,
        },
      ]),
    ).toBeNull();
  });
});
