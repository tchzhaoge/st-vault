import { afterEach, expect, it } from 'vitest';
import { setTimeZone, dayStart, calendarSlot, slotTime } from './time';
import { dayKey, clockLabel } from './date-label';
import {
  calendarWindow,
  moveWindow,
  restoreViewWindow,
  DAY_MS,
} from '../../features/timeline/range-control';
import { calendarDivisions, rulerDays } from '../../features/timeline/ruler';

afterEach(() => setTimeZone('Asia/Shanghai'));
it('formats deployment time independently of language or browser timezone', () => {
  setTimeZone('Asia/Kathmandu');
  const at = Date.parse('2026-11-15T20:30:45Z');
  expect(dayKey(at)).toBe('2026-11-16');
  expect(clockLabel(at)).toBe('02:15:45');
  expect(dayStart(at)).toBe(Date.parse('2026-11-15T18:15:00Z'));
  expect(() => setTimeZone('Invalid/Zone')).toThrow();
  expect(clockLabel(at)).toBe('02:15:45');
});
it.each([
  ['2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23, 24],
  ['2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25, 26],
])('keeps natural-day boundaries across DST at %s', (from, to, hours, divisions) => {
  setTimeZone('America/New_York');
  const start = Date.parse(from),
    end = Date.parse(to),
    first = start - 14 * DAY_MS;
  const view = calendarWindow(start, DAY_MS, first, end + DAY_MS);
  expect(view).toEqual({ fromMs: start, toMs: end });
  expect((end - start) / 3600000).toBe(hours);
  expect(restoreViewWindow(end, DAY_MS, end + DAY_MS, first)).toEqual(view);
  expect(calendarDivisions(start, end)).toHaveLength(divisions);
  expect(rulerDays(start, end)).toHaveLength(1);
  const noon = slotTime(calendarSlot(start) + 1);
  expect(clockLabel(noon)).toBe('12:00:00');
  expect(moveWindow(view, 1, first, end + DAY_MS).fromMs).toBe(noon);
});
it('preserves seven calendar days across the fall-back week', () => {
  setTimeZone('America/New_York');
  const from = Date.parse('2026-10-28T04:00:00Z');
  const view = calendarWindow(from, 7 * DAY_MS, from - DAY_MS, from + 10 * DAY_MS);
  expect(view.toMs).toBe(Date.parse('2026-11-04T05:00:00Z'));
  expect(view.toMs - view.fromMs).toBe(169 * 3600000);
  expect(restoreViewWindow(view.toMs, 7 * DAY_MS, from + 10 * DAY_MS, from - DAY_MS)).toEqual(view);
});
it('keeps hour divisions on local hours across a half-hour DST transition', () => {
  setTimeZone('Australia/Lord_Howe');
  const from = Date.parse('2026-10-03T13:30:00Z');
  const view = calendarWindow(from, DAY_MS, from - DAY_MS, from + 3 * DAY_MS);
  expect(view.toMs - view.fromMs).toBe(23.5 * 3600000);
  expect(
    calendarDivisions(view.fromMs, view.toMs).every((tick) =>
      clockLabel(tick.atMs).endsWith(':00:00'),
    ),
  ).toBe(true);
});
