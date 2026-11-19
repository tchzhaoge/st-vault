import { civilTime, fromCivilTime, slotTime } from '../../shared/lib/time';
import { dayKey, clockLabel } from '../../shared/lib/date-label';
const MINUTE = 60000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
export interface RulerTick {
  atMs: number;
  label: string;
  position: number;
}
export function calendarDivisions(
  from: number,
  to: number,
  overscan = 0,
): { atMs: number; position: number; level: 'day' | 'half-day' | 'hour' }[] {
  if (!(to > from) || !Number.isFinite(to - from)) return [];
  const result: ReturnType<typeof calendarDivisions> = [];
  let atMs = from - overscan;
  // Actual-time traversal retains repeated DST hours; local rounding also
  // handles half-hour transitions without drawing a false whole-hour tick.
  for (let attempts = 0; atMs <= to + overscan && attempts < 1000; attempts++) {
    const local = civilTime(atMs);
    const remainder = ((local % HOUR) + HOUR) % HOUR;
    if (remainder) {
      atMs += HOUR - remainder;
      continue;
    }
    const hour = ((local % DAY) + DAY) % DAY;
    result.push({
      atMs,
      position: (atMs - from) / (to - from),
      level: hour === 0 ? 'day' : hour === 12 * HOUR ? 'half-day' : 'hour',
    });
    atMs += HOUR;
  }
  return result;
}
/** Date captions occupy the center of each day, independently of hour labels. */
export function rulerDays(
  from: number,
  to: number,
  overscan = 0,
): { atMs: number; position: number; width: number; half: 'am' | 'pm' | null }[] {
  if (!(to > from) || !Number.isFinite(to - from)) return [];
  const result: ReturnType<typeof rulerDays> = [];
  for (let day = Math.floor(civilTime(from - overscan) / DAY); result.length < 100; day++) {
    const atMs = slotTime(day * 2),
      noon = slotTime(day * 2 + 1),
      end = slotTime((day + 1) * 2);
    if (atMs >= to + overscan) break;
    const visibleFrom = atMs < to && end > from ? Math.max(atMs, from) : atMs;
    const visibleTo = atMs < to && end > from ? Math.min(end, to) : end;
    result.push({
      atMs,
      half:
        visibleFrom === atMs && visibleTo === noon
          ? 'am'
          : visibleFrom === noon && visibleTo === end
            ? 'pm'
            : null,
      position: ((visibleFrom + visibleTo) / 2 - from) / (to - from),
      width: (visibleTo - visibleFrom) / (to - from),
    });
  }
  return result;
}
const date = (ms: number): string => dayKey(ms).slice(5);
const time = (ms: number, seconds = false): string => clockLabel(ms).slice(0, seconds ? 8 : 5);
/** Deployment-calendar ticks with reserved text width at both edges. */
export function rulerTicks(
  from: number,
  to: number,
  width: number,
  labelInset = 0,
  overscanMs = 0,
): RulerTick[] {
  if (!(to > from) || !Number.isFinite(width) || width < 45) return [];
  const duration = to - from,
    crossesDay = dayKey(from) !== dayKey(to);
  const daily = duration >= 3 * DAY,
    monthly = duration >= 90 * DAY,
    seconds = duration < 5 * MINUTE;
  const labelWidth = monthly
    ? 54
    : daily
      ? 42
      : crossesDay
        ? seconds
          ? 114
          : 92
        : seconds
          ? 60
          : 40;
  const count = Math.max(1, Math.floor(width / (labelWidth + 24)));
  const intervals = [
    1000,
    2000,
    5000,
    10000,
    15000,
    30000,
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    7 * DAY,
    14 * DAY,
  ];
  const step =
    intervals.find(
      (value) =>
        value >= duration / count && (!daily || value >= DAY) && (seconds || value >= MINUTE),
    ) ?? 30 * DAY;
  const ticks: RulerTick[] = [],
    inset = (labelWidth / 2 + 3) / width;
  const candidates: number[] = [];
  if (monthly) {
    const local = new Date(civilTime(from));
    let month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1);
    while (fromCivilTime(month) <= to + overscanMs && candidates.length < 100) {
      candidates.push(fromCivilTime(month));
      const current = new Date(month);
      month = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
    }
  } else if (step >= DAY) {
    for (
      let local = Math.ceil(civilTime(from - overscanMs) / step) * step;
      fromCivilTime(local) <= to + overscanMs && candidates.length < 100;
      local += step
    )
      candidates.push(fromCivilTime(local));
  } else if (step >= HOUR) {
    candidates.push(
      ...calendarDivisions(from, to, overscanMs)
        .filter((tick) => (((civilTime(tick.atMs) % DAY) + DAY) % DAY) % step === 0)
        .map((tick) => tick.atMs),
    );
  } else {
    const start = from - overscanMs;
    let next = fromCivilTime(Math.ceil(civilTime(start) / step) * step);
    while (next < start) next += step;
    for (; next <= to + overscanMs && candidates.length < 100; next += step) candidates.push(next);
  }
  for (const next of candidates) {
    const position = (next - from) / duration;
    if (
      (position >= inset + labelInset / width && position <= 1 - inset) ||
      position < 0 ||
      position > 1
    )
      ticks.push({
        atMs: next,
        label: monthly
          ? dayKey(next).slice(0, 7)
          : daily
            ? date(next)
            : crossesDay
              ? `${date(next)} ${time(next, seconds)}`
              : time(next, seconds),
        position,
      });
  }
  if (!ticks.length) {
    const atMs = Math.round((from + to) / 2);
    ticks.push({
      atMs,
      label: daily
        ? date(atMs)
        : crossesDay
          ? `${date(atMs)} ${time(atMs, seconds)}`
          : time(atMs, seconds),
      position: 0.5,
    });
  }
  return ticks;
}
