import { expect, it } from 'vitest';
import { replayWindow, playbackWindow, REPLAY_SPAN_MS } from './replay-window';
it('opens an out-of-range screenshot or favorite at its own time instead of clamping into the old selection', () => {
  const selection = { fromMs: 200000, toMs: 230000 };
  expect(playbackWindow(210000, selection, 10000, 300000)).toEqual(selection);
  expect(playbackWindow(20000, selection, 10000, 300000)).toEqual({
    fromMs: 20000,
    toMs: 300000,
  });
  expect(playbackWindow(250000, selection, 10000, 300000)).toEqual({
    fromMs: 250000,
    toMs: 300000,
  });
  expect(playbackWindow(10000, selection, 10000, 10 * 86400000).toMs).toBe(10000 + 7 * 86400000);
});
it('preserves exact user-selected durations rather than restoring thirty minutes', () => {
  expect(replayWindow(200000, 10000, 300000, 73521)).toEqual({
    fromMs: 126479,
    toMs: 200000,
  });
  expect(replayWindow(400000, 10000, 300000, 12000)).toEqual({
    fromMs: 288000,
    toMs: 300000,
  });
});
it('bounds the initial focus window and explicit ranges to available history', () => {
  const now = 1700000000000,
    start = now - 2 * REPLAY_SPAN_MS;
  expect(replayWindow(now, start, now)).toEqual({
    fromMs: now - REPLAY_SPAN_MS,
    toMs: now,
  });
  expect(replayWindow(now * 2, start, now).toMs).toBe(now);
  expect(replayWindow(0, start, now)).toEqual({
    fromMs: start,
    toMs: start + REPLAY_SPAN_MS,
  });
  expect(replayWindow(now, now - 20000, now)).toEqual({
    fromMs: now - 20000,
    toMs: now,
  });
});
