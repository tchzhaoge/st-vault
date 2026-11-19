import { expect, it, vi } from 'vitest';
import type { Segment } from '@st-vault/api-schema';
import { recordingRange } from './recording-range.js';
const segment = (start: number, end: number) => ({ wallStartMs: start, wallEndMs: end }) as Segment;
const fixture = (segments: Segment[]) => ({
  locate: vi.fn((_id: string, at: number, policy: string) =>
    Promise.resolve(
      segments.find((s) => s.wallStartMs! <= at && s.wallEndMs! > at) ??
        (policy === 'next'
          ? segments.find((s) => s.wallStartMs! >= at)
          : [...segments].reverse().find((s) => s.wallEndMs! <= at)) ??
        null,
    ),
  ),
});
it('snaps excess left/right margins to actual footage and preserves partial footage boundaries', async () => {
  const archive = fixture([segment(10000, 20000), segment(40000, 50000)]);
  expect(await recordingRange(archive, 's', 0, 60000)).toEqual({ fromMs: 10000, toMs: 50000 });
  expect(await recordingRange(archive, 's', 15000, 45000)).toEqual({ fromMs: 15000, toMs: 45000 });
  expect(await recordingRange(archive, 's', 25000, 45000)).toEqual({ fromMs: 40000, toMs: 45000 });
});
it('keeps end exclusive and never expands empty or reversed selections into nearby footage', async () => {
  const archive = fixture([segment(10000, 20000), segment(40000, 50000)]);
  for (const [from, to] of [
    [0, 10000],
    [20000, 40000],
    [50000, 60000],
    [45000, 45000],
    [45000, 40000],
  ])
    expect(await recordingRange(archive, 's', from, to)).toBeNull();
  expect(await recordingRange(archive, 's', 19999, 20000)).toEqual({ fromMs: 19999, toMs: 20000 });
});
