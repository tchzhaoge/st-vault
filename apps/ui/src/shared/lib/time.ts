import { TZDateMini, tzOffset } from '@date-fns/tz';
export const DAY_MS = 86400000;
let timeZone = 'Asia/Shanghai';
export function setTimeZone(value: string): void {
  // Validate before changing the shared calendar, never silently use the host zone.
  timeZone = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
}
/** A local calendar coordinate, not a stored timestamp. */
export function civilTime(at: number): number {
  return at + tzOffset(timeZone, new Date(at)) * 60000;
}
export function fromCivilTime(at: number): number {
  const date = new Date(at);
  return new TZDateMini(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
    timeZone,
  ).getTime();
}
export const calendarSlot = (at: number): number => Math.floor(civilTime(at) / (DAY_MS / 2));
export const slotTime = (slot: number): number => fromCivilTime(slot * (DAY_MS / 2));
export const calendarSpan = (from: number, to: number): number =>
  (calendarSlot(to) - calendarSlot(from)) * (DAY_MS / 2);
export interface ViewWindow {
  fromMs: number;
  toMs: number;
}
/** Half-open coverage; overlapping timestamps belong to the latest starting interval.
 * Match the archive locator without sorting/mutating manifest playback order. */
export function intervalAtIndex<T>(
  items: readonly T[],
  at: number,
  from: (item: T) => number | null,
  to: (item: T) => number | null,
): number {
  let index = -1,
    latest = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const start = from(items[i]),
      end = to(items[i]);
    if (start !== null && end !== null && start > latest && at >= start && at < end) {
      index = i;
      latest = start;
    }
  }
  return index;
}
export function dayStart(atMs: number): number {
  return slotTime(Math.floor(calendarSlot(atMs) / 2) * 2);
}
