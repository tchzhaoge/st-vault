import { expect, it, vi } from 'vitest';
import { PlaybackClock } from './playback-clock';
it('publishes a changed unit even when the actual UTC is unchanged', () => {
  const clock = new PlaybackClock(),
    observer = vi.fn();
  clock.subscribe(observer);
  clock.set(1000, 'first');
  clock.set(1000, 'second');
  expect(observer).toHaveBeenCalledTimes(2);
  expect(clock.position()).toEqual({ atMs: 1000, unitId: 'second' });
});

it('publishes actual media progress only to its consumers and clears on disconnect', () => {
  const clock = new PlaybackClock(),
    observer = vi.fn();
  const dispose = clock.subscribe(observer);
  clock.set(1000);
  clock.set(1000);
  expect(observer).toHaveBeenCalledTimes(1);
  expect(clock.snapshot()).toBe(1000);
  clock.set(null);
  expect(observer).toHaveBeenCalledTimes(2);
  expect(clock.snapshot()).toBeNull();
  dispose();
  clock.set(2000);
  expect(observer).toHaveBeenCalledTimes(2);
});
