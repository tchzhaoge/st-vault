import { MAX_RANGE_MS, type ViewWindow } from '../timeline/range-control';
export const MINUTE = 60000,
  REPLAY_SPAN_MS = 30 * MINUTE;
export function replayWindow(
  end: number,
  timelineStart: number,
  now = Date.now(),
  duration = REPLAY_SPAN_MS,
): ViewWindow {
  const span = Math.min(
      Math.max(1, Math.round(duration)),
      7 * 86400000,
      Math.max(0, now - timelineStart),
    ),
    toMs = Math.min(now, Math.max(timelineStart + span, Math.round(end)));
  return { fromMs: toMs - span, toMs };
}
export function playbackWindow(
  atMs: number,
  current: ViewWindow,
  timelineStart: number,
  now = Date.now(),
): ViewWindow {
  if (atMs >= current.fromMs && atMs < current.toMs) return current;
  const fromMs = Math.max(timelineStart, Math.min(now - 1, Math.round(atMs)));
  return { fromMs, toMs: Math.min(now, fromMs + MAX_RANGE_MS) };
}
