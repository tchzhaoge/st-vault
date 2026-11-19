import {
  DAY_MS,
  calendarSlot,
  calendarSpan,
  slotTime,
  dayStart,
  type ViewWindow,
} from '../../shared/lib/time';
export { DAY_MS, dayStart, type ViewWindow } from '../../shared/lib/time';
export const VIEW_STEP_MS = DAY_MS / 2;
export const DEFAULT_RANGE_MS = DAY_MS;
export const MAX_RANGE_MS = 7 * DAY_MS;
export const RANGE_STOPS = Array.from({ length: 14 }, (_, index) => (index + 1) * VIEW_STEP_MS);
const MAX_VIEW_POSITION_MS = 8640000000000000 - DAY_MS - MAX_RANGE_MS;
/** Round ordinary aggregation queries, retaining exact endpoints at the API cap. */
export function aggregateWindow(window: ViewWindow, step: number, start = 0): ViewWindow {
  const fromMs = Math.max(start, Math.floor(window.fromMs / step) * step),
    toMs = Math.ceil(window.toMs / step) * step;
  return toMs - fromMs > MAX_RANGE_MS
    ? { fromMs: Math.max(start, window.fromMs), toMs: window.toMs }
    : { fromMs, toMs };
}
export function snapSpan(duration: number): number {
  return RANGE_STOPS.includes(duration) ? duration : DEFAULT_RANGE_MS;
}
/** Leave room for a full week and timezone transitions inside JavaScript's Date limit. */
export function isValidViewPosition(atMs: unknown): atMs is number {
  return (
    typeof atMs === 'number' &&
    Number.isSafeInteger(atMs) &&
    atMs >= 0 &&
    atMs <= MAX_VIEW_POSITION_MS
  );
}
/** Calendar slots stay at local midnight/noon even on 23/25-hour DST days. */
export function calendarEnd(nowMs: number): number {
  return slotTime(calendarSlot(nowMs) + 1);
}
/** Half-day slots, bounded by initialization day and the current half-day. */
export function calendarWindow(
  fromMs: number,
  durationMs: number,
  timelineStartMs = 0,
  nowMs = Date.now(),
): ViewWindow {
  const safeFrom = isValidViewPosition(fromMs) ? fromMs : nowMs;
  const end = calendarSlot(nowMs) + 1;
  const first = Math.min(
    Math.floor(calendarSlot(timelineStartMs) / 2) * 2,
    Math.floor(calendarSlot(nowMs) / 2) * 2,
  );
  const slots = Math.min(snapSpan(durationMs) / VIEW_STEP_MS, end - first);
  const start = Math.max(first, Math.min(calendarSlot(safeFrom), end - slots));
  return { fromMs: slotTime(start), toMs: slotTime(start + slots) };
}
export function restoreViewWindow(
  viewToMs: number | null | undefined,
  durationMs: number,
  nowMs: number,
  timelineStartMs: number,
): ViewWindow {
  const duration = snapSpan(durationMs);
  return calendarWindow(
    isValidViewPosition(viewToMs)
      ? slotTime(calendarSlot(viewToMs) - duration / VIEW_STEP_MS)
      : nowMs,
    duration,
    timelineStartMs,
    nowMs,
  );
}
export function moveWindow(
  window: ViewWindow,
  direction: number,
  timelineStartMs = 0,
  nowMs = Date.now(),
  spanMs = calendarSpan(window.fromMs, window.toMs),
): ViewWindow {
  if (!Number.isFinite(direction)) return window;
  return calendarWindow(
    slotTime(calendarSlot(window.fromMs) + Math.round(direction)),
    spanMs,
    timelineStartMs,
    nowMs,
  );
}

/** Resize one edge in half-day slots without moving its opposite. Delta is in days. */
export function resizeCalendarWindow(
  window: ViewWindow,
  edge: 'from' | 'to',
  deltaDays: number,
  timelineStartMs: number,
  nowMs = Date.now(),
): ViewWindow {
  if (!Number.isFinite(deltaDays)) return window;
  const delta = Math.round(deltaDays * 2);
  const first = calendarSlot(dayStart(timelineStartMs)),
    last = calendarSlot(nowMs) + 1;
  const from = calendarSlot(window.fromMs),
    to = calendarSlot(window.toMs);
  return edge === 'from'
    ? {
        fromMs: slotTime(Math.max(first, to - 14, Math.min(to - 1, from + delta))),
        toMs: window.toMs,
      }
    : {
        fromMs: window.fromMs,
        toMs: slotTime(Math.min(last, from + 14, Math.max(from + 1, to + delta))),
      };
}

export function viewPanRatio(previous: ViewWindow, next: ViewWindow): number {
  const duration = next.toMs - next.fromMs,
    delta = next.fromMs - previous.fromMs;
  // Only adjacent-day navigation has an overscanned continuation to animate.
  return duration > 0 && duration === previous.toMs - previous.fromMs && Math.abs(delta) <= DAY_MS
    ? delta / duration
    : 0;
}
