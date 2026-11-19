import { expect, it, vi } from 'vitest';
import { createRunEvents } from './run-events.js';
it('waits for a delayed startup write during normal stop and never restarts the heartbeat', async () => {
  vi.useFakeTimers();
  let release: (id: string) => void = () => undefined;
  const archive = {
    startRun: () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    heartbeatRun: vi.fn(() => Promise.resolve()),
    stopRun: vi.fn(() => Promise.resolve()),
  };
  const events = createRunEvents(archive),
    starting = events.start();
  let paused = false;
  const pause = events.pause().then(() => {
    paused = true;
  });
  try {
    await Promise.resolve();
    expect(paused).toBe(false);
    release('run');
    expect(await starting).toBe(false);
    await pause;
    await events.finish('normal');
    await vi.advanceTimersByTimeAsync(30000);
    expect(archive.stopRun).toHaveBeenCalledExactlyOnceWith('run', 'normal');
    expect(archive.heartbeatRun).not.toHaveBeenCalled();
    expect(await events.start()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it('drains an actual heartbeat before recording an abnormal stop', async () => {
  vi.useFakeTimers();
  let release = (): void => undefined;
  const archive = {
    startRun: () => Promise.resolve('run'),
    heartbeatRun: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
    stopRun: vi.fn(() => Promise.resolve()),
  };
  const events = createRunEvents(archive);
  try {
    await events.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(archive.heartbeatRun).toHaveBeenCalledOnce();
    const stopping = events.finish('abnormal');
    await Promise.resolve();
    expect(archive.stopRun).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(archive.stopRun).toHaveBeenCalledExactlyOnceWith('run', 'abnormal');
  } finally {
    vi.useRealTimers();
  }
});
it('reports persistent heartbeat failure and a later successful recovery truthfully', async () => {
  vi.useFakeTimers();
  const onError = vi.fn(),
    heartbeat = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(Error('failed'))
      .mockResolvedValue(undefined);
  const events = createRunEvents(
    {
      startRun: () => Promise.resolve('run'),
      heartbeatRun: heartbeat,
      stopRun: () => Promise.resolve(),
    },
    onError,
  );
  try {
    await events.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.backgroundTask()).toMatchObject({
      state: 'retrying',
      error: 'run_heartbeat_failed',
      lastSuccessAtMs: null,
    });
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.backgroundTask()).toMatchObject({
      state: 'waiting',
      error: null,
      lastSuccessAtMs: Date.now(),
    });
  } finally {
    await events.finish('normal');
    vi.useRealTimers();
  }
});
