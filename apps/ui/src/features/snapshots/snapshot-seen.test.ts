import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotSeen } from './snapshot-seen';
type Send = (
  subjectId: string,
  evidence: { unitId: string; toMs: number }[],
) => Promise<{ changed: number }>;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('preserves newer evidence received while an older boundary is being acknowledged', async () => {
  vi.useFakeTimers();
  let complete!: (value: { changed: number }) => void;
  const send = vi
    .fn<Send>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue({ changed: 1 });
  const reporter = new SnapshotSeen(send, vi.fn());
  reporter.loaded('s', 'a', 100);
  await vi.advanceTimersByTimeAsync(120);
  reporter.loaded('s', 'a', 200);
  reporter.loaded('s', 'a', 150);
  complete({ changed: 1 });
  await vi.runAllTimersAsync();
  expect(send.mock.calls.map((call) => call[1])).toEqual([
    [{ unitId: 'a', toMs: 100 }],
    [{ unitId: 'a', toMs: 200 }],
  ]);
  reporter.loaded('s', 'a', 100);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(2);
});
it('batches decoded image evidence, deduplicates reloads, and bounds requests', async () => {
  vi.useFakeTimers();
  const send = vi.fn<Send>().mockResolvedValue({ changed: 1 }),
    changed = vi.fn();
  const reporter = new SnapshotSeen(send, changed);
  for (let i = 0; i < 230; i++) reporter.loaded('s', String(i), 100);
  reporter.loaded('s', '0', 100);
  expect(send).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(send.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 30]);
  reporter.loaded('s', '0', 100);
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(3);
  expect(changed).toHaveBeenCalledTimes(3);
});
it('retains evidence on transport failure and retries without overlapping requests', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const send = vi
    .fn<Send>()
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValue({ changed: 0 });
  const changed = vi.fn(),
    reporter = new SnapshotSeen(send, changed);
  reporter.loaded('s', 'a', 100);
  await vi.advanceTimersByTimeAsync(120);
  reporter.loaded('s', 'b', 100);
  await vi.runAllTimersAsync();
  expect(send.mock.calls.map((call) => call[1].map((item) => item.unitId))).toEqual([
    ['a'],
    ['a', 'b'],
  ]);
  expect(changed).not.toHaveBeenCalled();
});
