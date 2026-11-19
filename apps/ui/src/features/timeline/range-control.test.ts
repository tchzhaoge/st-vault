import { expect, it } from 'vitest';
import {
  aggregateWindow,
  calendarWindow,
  DAY_MS,
  DEFAULT_RANGE_MS,
  MAX_RANGE_MS,
  moveWindow,
  RANGE_STOPS,
  restoreViewWindow,
  dayStart,
  snapSpan,
  viewPanRatio,
  resizeCalendarWindow,
} from './range-control';
const today = Date.UTC(2026, 10, 4, 16),
  now = today + 12 * 3600000,
  first = today - 30 * DAY_MS;
it('bounds morning navigation and resizing at noon and afternoon navigation at midnight', () => {
  const half = DAY_MS / 2;
  for (const clock of [today, today + half - 1]) {
    const latest = calendarWindow(today + 10 * DAY_MS, DAY_MS, first, clock);
    expect(latest).toEqual({ fromMs: today - half, toMs: today + half });
    expect(moveWindow(latest, 1, first, clock)).toEqual(latest);
    expect(resizeCalendarWindow(latest, 'to', 100, first, clock).toMs).toBe(today + half);
  }
  for (const clock of [today + half, today + DAY_MS - 1])
    expect(calendarWindow(today + 10 * DAY_MS, DAY_MS, first, clock)).toEqual({
      fromMs: today,
      toMs: today + DAY_MS,
    });
});
it('limits a fresh morning installation to its initialization day without inventing yesterday', () => {
  for (const duration of RANGE_STOPS)
    expect(restoreViewWindow(null, duration, today + 3600000, today + 1000)).toEqual({
      fromMs: today,
      toMs: today + DAY_MS / 2,
    });
});
it('supports a twelve-hour minimum and moves and resizes in half-day steps', () => {
  const half = DAY_MS / 2;
  expect(snapSpan(half)).toBe(half);
  const window = calendarWindow(today, half, first, now);
  expect(window).toEqual({ fromMs: today, toMs: today + half });
  expect(moveWindow(window, 1, first, now)).toEqual({ fromMs: today + half, toMs: today + DAY_MS });
  expect(
    resizeCalendarWindow({ fromMs: today, toMs: today + DAY_MS }, 'from', 0.5, first, now),
  ).toEqual({ fromMs: today + half, toMs: today + DAY_MS });
});
it('moves the navigator grip by half days without changing its span or exceeding history', () => {
  const view = { fromMs: today - 5 * DAY_MS, toMs: today - 2 * DAY_MS };
  expect(moveWindow(view, 1.6, first, now)).toEqual({
    fromMs: today - 4 * DAY_MS,
    toMs: today - DAY_MS,
  });
  expect(moveWindow(view, 100, first, now)).toEqual({
    fromMs: today - 2 * DAY_MS,
    toMs: today + DAY_MS,
  });
  expect(moveWindow(view, -100, first, now)).toEqual({ fromMs: first, toMs: first + 3 * DAY_MS });
});
it('clamps both bounds to initialization day through the complete current day', () => {
  expect(calendarWindow(today + 10 * DAY_MS, DAY_MS, first, now)).toEqual({
    fromMs: today,
    toMs: today + DAY_MS,
  });
  expect(calendarWindow(today - 20 * DAY_MS, 7 * DAY_MS, today - 2 * DAY_MS + 1234, now)).toEqual({
    fromMs: today - 2 * DAY_MS,
    toMs: today + DAY_MS,
  });
});
it('accepts only the current natural-day spans and resets invalid values', () => {
  expect(RANGE_STOPS).toEqual(Array.from({ length: 14 }, (_, index) => ((index + 1) * DAY_MS) / 2));
  expect(DEFAULT_RANGE_MS).toBe(DAY_MS);
  for (const old of [60000, 3600000, NaN]) expect(snapSpan(old)).toBe(DAY_MS);
  expect(snapSpan(5 * DAY_MS)).toBe(5 * DAY_MS);
  expect(snapSpan(1.5 * DAY_MS)).toBe(1.5 * DAY_MS);
});
it('resizes one boundary by snapped days while keeping the opposite boundary fixed', () => {
  const view = { fromMs: today - 3 * DAY_MS, toMs: today };
  expect(resizeCalendarWindow(view, 'from', -1.6, first, now)).toEqual({
    fromMs: today - 4.5 * DAY_MS,
    toMs: today,
  });
  expect(resizeCalendarWindow(view, 'to', 0.6, first, now)).toEqual({
    fromMs: view.fromMs,
    toMs: today + DAY_MS / 2,
  });
  expect(resizeCalendarWindow(view, 'from', 99, first, now)).toEqual({
    fromMs: today - DAY_MS / 2,
    toMs: today,
  });
  expect(resizeCalendarWindow(view, 'from', -99, first, now)).toEqual({
    fromMs: today - 7 * DAY_MS,
    toMs: today,
  });
  expect(resizeCalendarWindow(view, 'to', -99, first, now)).toEqual({
    fromMs: view.fromMs,
    toMs: view.fromMs + DAY_MS / 2,
  });
});
it('clamps resize to available days and rejects nonfinite gesture deltas', () => {
  const view = { fromMs: today, toMs: today + DAY_MS };
  expect(resizeCalendarWindow(view, 'from', -99, today, now)).toEqual(view);
  expect(resizeCalendarWindow(view, 'to', 99, today, now)).toEqual(view);
  expect(resizeCalendarWindow(view, 'from', NaN, first, now)).toEqual(view);
});
it('uses Shanghai midnight independently of browser timezone', () => {
  expect(dayStart(today + 15 * 3600000)).toBe(today);
  expect(dayStart(today - 1)).toBe(today - DAY_MS);
  expect(calendarWindow(today + 12345, DAY_MS, first, now)).toEqual({
    fromMs: today,
    toMs: today + DAY_MS,
  });
});
it('never creates future days on a fresh installation for any requested span', () => {
  for (const duration of RANGE_STOPS)
    expect(restoreViewWindow(null, duration, now, today + 3600000)).toEqual({
      fromMs: today + DAY_MS - Math.min(duration, DAY_MS),
      toMs: today + DAY_MS,
    });
});
it('moves exactly twelve hours for every span across year boundaries and stops at today', () => {
  const from = Date.UTC(2026, 11, 29, 16),
    clock = from + 20 * DAY_MS;
  for (const duration of RANGE_STOPS) {
    const view = calendarWindow(from, duration, first, clock),
      next = moveWindow(view, 1, first, clock);
    expect(next).toEqual({
      fromMs: from + DAY_MS / 2,
      toMs: from + DAY_MS / 2 + duration,
    });
    expect(moveWindow(next, -1, first, clock)).toEqual(view);
    const latest = calendarWindow(clock + DAY_MS, duration, first, clock);
    expect(moveWindow(latest, 1, first, clock)).toEqual(latest);
    expect(viewPanRatio(view, next)).toBeCloseTo(DAY_MS / 2 / duration);
  }
});
it('restores historical positions and clamps saved future positions', () => {
  expect(restoreViewWindow(today - 2 * DAY_MS + 5 * 3600000, 2 * DAY_MS, now, first)).toEqual({
    fromMs: today - 4 * DAY_MS,
    toMs: today - 2 * DAY_MS,
  });
  expect(restoreViewWindow(today + 8 * DAY_MS, DAY_MS, now, first)).toEqual({
    fromMs: today,
    toMs: today + DAY_MS,
  });
});
it('round-trips morning and afternoon windows for every supported span', () => {
  for (const span of RANGE_STOPS) {
    for (const phase of [0, DAY_MS / 2]) {
      const saved = calendarWindow(today - 10 * DAY_MS + phase, span, first, now);
      expect(restoreViewWindow(saved.toMs, span, now, first)).toEqual(saved);
    }
  }
  expect(restoreViewWindow(today + DAY_MS, DAY_MS / 2, now, first)).toEqual({
    fromMs: today + DAY_MS / 2,
    toMs: today + DAY_MS,
  });
});
it('falls back for invalid dates without exceeding today or JavaScript date limits', () => {
  for (const to of [Number.MAX_SAFE_INTEGER, 8640000000000000, Infinity, NaN]) {
    const view = restoreViewWindow(to, MAX_RANGE_MS, now, first);
    expect(view).toEqual({ fromMs: today - 6 * DAY_MS, toMs: today + DAY_MS });
    expect(() => new Date(view.toMs).toISOString()).not.toThrow();
  }
});
it('does not animate span changes or distant jumps', () => {
  const week = { fromMs: today - 6 * DAY_MS, toMs: today + DAY_MS };
  expect(viewPanRatio(week, calendarWindow(today, DAY_MS, first, now))).toBe(0);
  expect(viewPanRatio(week, { fromMs: first, toMs: first + 7 * DAY_MS })).toBe(0);
});
it('retains exact full-week aggregation endpoints within the API budget', () => {
  const view = { fromMs: 12345, toMs: 12345 + MAX_RANGE_MS };
  for (const step of [1000, 5000, 60000]) expect(aggregateWindow(view, step)).toEqual(view);
  expect(aggregateWindow({ fromMs: 12345, toMs: 25432 }, 5000)).toEqual({
    fromMs: 10000,
    toMs: 30000,
  });
});
