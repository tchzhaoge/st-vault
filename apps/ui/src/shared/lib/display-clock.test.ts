import { expect, it } from 'vitest';
import { DisplayClock } from './display-clock';

it('advances each displayed second between server heartbeats without duplicate pulses', () => {
  let elapsed = 0;
  const clock = new DisplayClock(10000, () => elapsed);
  expect(clock.sample()).toBe(10000);
  elapsed = 250;
  expect(clock.sample()).toBeNull();
  elapsed = 1000;
  expect(clock.sample()).toBe(11000);
  elapsed = 4500;
  expect(clock.sample()).toBe(14500);
  elapsed = 5000.75;
  expect(clock.sample()).toBe(15000);
  expect(Number.isSafeInteger(clock.now())).toBe(true);
});
it('calibrates against server UTC using monotonic elapsed time rather than the client wall clock', () => {
  let elapsed = 100;
  const clock = new DisplayClock(10000, () => elapsed);
  clock.synchronize(50000);
  elapsed = 1100;
  expect(clock.sample()).toBe(51000);
  elapsed = 121100;
  expect(clock.sample()).toBe(171000);
  clock.synchronize(170000);
  expect(clock.sample()).toBe(170000);
});
