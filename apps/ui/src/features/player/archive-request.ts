import type { MediaTimeRange, PlaybackResponse } from '@st-vault/api-schema';

/** Null bounds mean a seek independent of the rolling presentation window. */
export function archiveRequest(
  subjectId: string,
  atMs: number,
  range: MediaTimeRange | null,
  unitId?: string,
) {
  const target = Math.round(atMs);
  return {
    subjectId,
    ...(unitId ? { unitId } : {}),
    targetUtcMs: range
      ? Math.max(Math.round(range.fromMs), Math.min(Math.round(range.toMs) - 1, target))
      : target,
    gapPolicy: 'next' as const,
    ...(range ? { fromMs: Math.round(range.fromMs), toMs: Math.round(range.toMs) } : {}),
  };
}

/** Media invalidation follows the loaded source, even after it leaves the view. */
export function archiveRange(playback: PlaybackResponse, fallback: MediaTimeRange): MediaTimeRange {
  return {
    fromMs: playback.rangeFromMs ?? playback.segments[0]?.wallStartMs ?? fallback.fromMs,
    toMs: playback.rangeToMs ?? Math.max(playback.windowEndMs ?? 0, fallback.toMs),
  };
}
