import { expect, it } from 'vitest';
import { dayLabel, clockLabel } from './date-label';
import { DAY_MS } from './time';
it('labels Shanghai days consistently across midnight, month and year boundaries', () => {
  const now = Date.UTC(2026, 0, 1, 16, 1);
  expect(dayLabel(now, now)).toBe('今天');
  expect(dayLabel(now - DAY_MS, now)).toBe('昨天');
  expect(dayLabel(now - 2 * DAY_MS, now)).toBe('前天');
  expect(dayLabel(now - 3 * DAY_MS, now)).toBe('2025-12-30');
  expect(clockLabel(now)).toBe('00:01:00');
});
