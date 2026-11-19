import { expect, it } from 'vitest';
import { LiveClock, liveMediaToUtc, liveUtcToMedia } from './live-clock';
const fragments = [
  { sn: 1, cc: 0, start: 0, duration: 20, programDateTime: 10000 },
  { sn: 2, cc: 1, start: 20, duration: 20, programDateTime: 70000 },
];
it('uses the newer buffered fragment at overlapping UTC boundaries', () => {
  const overlapping = [
    { ...fragments[0], duration: 20.019 },
    { ...fragments[1], programDateTime: 30000, start: 20.019 },
  ];
  expect(liveUtcToMedia(overlapping, 30000)).toBe(20.019);
  expect(liveMediaToUtc(overlapping, 20.019)).toBe(30000);
});
it('maps both directions through actual fragment timestamps without bridging wall-clock gaps', () => {
  expect(liveUtcToMedia(fragments, 71000)).toBe(21);
  expect(liveMediaToUtc(fragments, 21)).toBe(71000);
  expect(liveUtcToMedia(fragments, 50000)).toBeNull();
  expect(liveMediaToUtc(fragments, 20)).toBe(70000);
  expect(liveUtcToMedia(fragments, 90000)).toBeNull();
  expect(liveMediaToUtc(fragments, 40)).toBeNull();
});
it('does not invent positions outside known fragments or for missing timestamps', () => {
  const unknown = [null, { sn: 1, cc: 0, start: 0, duration: 2, programDateTime: null }];
  expect(liveUtcToMedia(unknown, 1)).toBeNull();
  expect(liveMediaToUtc(unknown, 1)).toBeNull();
  expect(liveMediaToUtc(fragments, NaN)).toBeNull();
  expect(liveUtcToMedia(fragments, Infinity)).toBeNull();
});
it('retains buffered clocks, updates corrected timestamps and evicts consumed media', () => {
  const clock = new LiveClock();
  clock.observe(fragments, 0);
  clock.observe([fragments[1]], 0);
  expect(clock.toMedia(11000)).toBe(1);
  clock.observe([{ ...fragments[1], start: 21 }], 0);
  expect(clock.toMedia(71000)).toBe(22);
  clock.observe([], 20);
  expect(clock.toMedia(11000)).toBeNull();
});
