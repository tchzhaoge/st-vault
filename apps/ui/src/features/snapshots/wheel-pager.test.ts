import { expect, it } from 'vitest';
import { WheelPager } from './wheel-pager';
it('turns one page for a wheel notch and suppresses its momentum burst', () => {
  const wheel = new WheelPager();
  expect(wheel.step(120, 0, 400, 0)).toBe(1);
  for (const at of [10, 30, 100, 200]) expect(wheel.step(120, 0, 400, at)).toBe(0);
  expect(wheel.step(-120, 0, 400, 300)).toBe(-1);
});
it('accumulates trackpad deltas, expires stale movement and normalizes line/page units', () => {
  const wheel = new WheelPager();
  expect(wheel.step(30, 0, 400, 0)).toBe(0);
  expect(wheel.step(30, 0, 400, 50)).toBe(0);
  expect(wheel.step(30, 0, 400, 300)).toBe(0);
  expect(wheel.step(50, 0, 400, 350)).toBe(1);
  expect(wheel.step(-6, 1, 400, 600)).toBe(-1);
  expect(wheel.step(1, 2, 400, 900)).toBe(1);
  expect(wheel.step(NaN, 0, 400, 1200)).toBe(0);
});
