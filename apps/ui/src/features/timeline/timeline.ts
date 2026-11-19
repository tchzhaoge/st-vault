import { dayLabel, clockLabel } from '../../shared/lib/date-label';
import type { Segment } from '@st-vault/api-schema';
import { intervalAtIndex } from '../../shared/lib/time';

/** Immutable manifest index: media order remains authoritative across wall-clock gaps. */
export function createMediaTimeIndex(segments: Segment[]) {
  let elapsed = 0;
  const starts = segments.map((segment) => {
    const start = elapsed;
    elapsed += segment.durationSeconds;
    return start;
  });
  return (seconds: number): { atMs: number; unitId?: string } | null => {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds >= elapsed) return null;
    let lo = 0,
      hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= seconds) lo = mid + 1;
      else hi = mid;
    }
    const index = lo - 1,
      segment = segments[index];
    if (segment?.wallStartMs == null) return null;
    return {
      atMs: segment.wallStartMs + (seconds - starts[index]) * 1000,
      unitId: segment.recordingUnitId,
    };
  };
}

/** Maps a manifest-relative media clock through the returned segment sequence to UTC wall time. */
export function mediaTimeToUtc(segments: Segment[], mediaTimeSeconds: number): number | null {
  return mediaTimePosition(segments, mediaTimeSeconds)?.atMs ?? null;
}
export function mediaTimePosition(
  segments: Segment[],
  mediaTimeSeconds: number,
): { atMs: number; unitId?: string } | null {
  if (!Number.isFinite(mediaTimeSeconds) || mediaTimeSeconds < 0) return null;
  let mediaCursor = 0;
  for (const segment of segments) {
    const end = mediaCursor + segment.durationSeconds;
    if (mediaTimeSeconds >= mediaCursor && mediaTimeSeconds < end) {
      if (segment.wallStartMs === null) return null;
      return {
        atMs: segment.wallStartMs + (mediaTimeSeconds - mediaCursor) * 1000,
        unitId: segment.recordingUnitId,
      };
    }
    mediaCursor = end;
  }
  return null;
}

export function utcToMediaTime(segments: Segment[], utcMs: number, unitId?: string): number | null {
  const index = intervalAtIndex(
    segments,
    utcMs,
    (segment) => (!unitId || segment.recordingUnitId === unitId ? segment.wallStartMs : null),
    (segment) => (!unitId || segment.recordingUnitId === unitId ? segment.wallEndMs : null),
  );
  if (index < 0) return null;
  let elapsed = 0;
  for (let i = 0; i < index; i++) elapsed += segments[i].durationSeconds;
  return elapsed + (utcMs - segments[index].wallStartMs!) / 1000;
}

/** Returns the final manifest segment's known wall end; it never bridges trailing unknown media. */
export function playbackEndUtc(segments: Segment[]): number | null {
  const last = segments[segments.length - 1];
  if (
    !last ||
    last.timeBasis === 'unknown' ||
    last.wallStartMs === null ||
    last.wallEndMs === null ||
    last.wallEndMs < last.wallStartMs
  )
    return null;
  return last.wallEndMs;
}

export function formatDateTime(utcMs: number, includeDate = true): string {
  const time = clockLabel(utcMs).slice(0, 5);
  return includeDate ? dayLabel(utcMs) + ' ' + time : time;
}

export function formatDateTimePrecise(utcMs: number): string {
  return dayLabel(utcMs) + ' ' + clockLabel(utcMs, true);
}
