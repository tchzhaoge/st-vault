import { describe, expect, it, vi } from 'vitest';
import { PlaybackCoordinator } from './playback-coordinator';

describe('PlaybackCoordinator', () => {
  it('replaces requests without allowing an old completion to clear the new owner', () => {
    const coordinator = new PlaybackCoordinator(vi.fn());
    const old = coordinator.begin('range');
    const next = coordinator.begin('range');
    expect(old.signal.aborted).toBe(true);
    coordinator.settled('range', old);
    expect(coordinator.owns('range', next)).toBe(true);
    coordinator.invalidate();
    expect(next.signal.aborted).toBe(true);
  });
  it('releases late resources while accepting only the current generation', () => {
    const release = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve());
    const coordinator = new PlaybackCoordinator(release);
    const stamp = coordinator.stamp();
    coordinator.invalidate();
    expect(coordinator.adopt(stamp, new AbortController().signal, 'old')).toBe(false);
    expect(release).toHaveBeenCalledWith('old');
    expect(coordinator.adopt(coordinator.stamp(), new AbortController().signal, 'new')).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('coalesces seeks and retains a new owner queued during an old request', async () => {
    const coordinator = new PlaybackCoordinator(vi.fn());
    let finish!: () => void;
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const next = vi.fn<(at: number) => Promise<void>>(() => Promise.resolve());
    const running = coordinator.scrub(1, first, () => true);
    await coordinator.scrub(2, next, () => true);
    await coordinator.scrub(3, next, () => true);
    finish();
    await running;
    expect(first).toHaveBeenCalledWith(1);
    expect(next.mock.calls).toEqual([[3]]);
  });
  it('drops pending seeks on close and ignores invalid owners', async () => {
    const coordinator = new PlaybackCoordinator(vi.fn());
    let finish!: () => void;
    const first = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const next = vi.fn(() => Promise.resolve());
    const running = coordinator.scrub(1, first, () => true);
    await coordinator.scrub(2, next, () => true);
    coordinator.invalidate();
    finish();
    await running;
    await coordinator.scrub(3, next, () => false);
    expect(next).not.toHaveBeenCalled();
  });
});
