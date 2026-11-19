import type { ComponentProps, ReactElement } from 'react';
import type * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaSlot, type MediaSlotHandle } from './MediaSlot';
import { request } from '../../shared/lib/api';
import type * as Api from '../../shared/lib/api';
import type { PlayerSource } from './Player';

const harness = vi.hoisted(() => ({
  cursor: 0,
  hooks: [] as unknown[],
  effects: [] as (() => void)[],
  layouts: [] as (() => void)[],
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  const effect = (
    queue: (() => void)[],
    setup: () => void | (() => void),
    deps?: unknown[],
  ): void => {
    const index = harness.cursor++;
    const previous = harness.hooks[index] as { deps?: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps?.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    queue.push(() => {
      previous?.cleanup?.();
      harness.hooks[index] = { deps, cleanup: setup() };
    });
  };
  return {
    ...actual,
    useRef: (value: unknown) => {
      const index = harness.cursor++;
      return (harness.hooks[index] ??= { current: value });
    },
    useEffect: (setup: () => void | (() => void), deps?: unknown[]) =>
      effect(harness.effects, setup, deps),
    useLayoutEffect: (setup: () => void | (() => void), deps?: unknown[]) =>
      effect(harness.layouts, setup, deps),
    useImperativeHandle: (ref: { current: unknown }, factory: () => unknown) => {
      harness.cursor++;
      ref.current = factory();
    },
  };
});
const engine = vi.hoisted(() => ({
  supported: true,
  failures: [] as ((event: string, data: { fatal: boolean; type?: string }) => void)[],
  startLoad: vi.fn(),
  stopLoad: vi.fn(),
  recoverMediaError: vi.fn(),
}));
vi.mock('./player-engine', () => ({
  loadPlayerEngine: () =>
    Promise.resolve({
      default: class {
        static Events: { ERROR: string } = { ERROR: 'error' };
        static ErrorTypes: { NETWORK_ERROR: string; MEDIA_ERROR: string } = {
          NETWORK_ERROR: 'networkError',
          MEDIA_ERROR: 'mediaError',
        };
        static isSupported(): boolean {
          return engine.supported;
        }
        playingDate = new Date(10000);
        latestLevelDetails = {
          fragments: [
            { sn: 1, cc: 0, start: 0, duration: 20, programDateTime: 10000 },
            { sn: 2, cc: 1, start: 20, duration: 20, programDateTime: 70000 },
          ],
        };
        startLoad = engine.startLoad;
        stopLoad = engine.stopLoad;
        recoverMediaError = engine.recoverMediaError;
        on(
          _event: string,
          callback: (event: string, data: { fatal: boolean; type?: string }) => void,
        ): void {
          engine.failures.push(callback);
        }
        attachMedia(): void {
          /* Engine loading is controlled by the test. */
        }
        loadSource(): void {
          /* No network requests in the lifecycle harness. */
        }
        destroy(): void {
          /* Detached callbacks remain available to test stale events. */
        }
      },
    }),
}));
vi.mock('../../shared/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  request: vi.fn(() => Promise.resolve()),
}));

class Video extends EventTarget {
  muted = true;
  volume = 1;
  playbackRate = 1;
  readyState = 2;
  currentTime = 0;
  paused = true;
  seeking = false;
  error: { code: number } | null = null;
  buffered = { length: 1, start: () => 0, end: () => 100 };
  seekable = { length: 1, start: () => 0, end: () => 100 };
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause(): void {
    this.paused = true;
  }
  canPlayType(): string {
    return '';
  }
  removeAttribute(): void {
    /* Source ownership is exercised through effects. */
  }
  load(): void {
    /* No browser resource selection in this fake. */
  }
  fire(name: string): void {
    this.dispatchEvent(new Event(name));
  }
}
const source: PlayerSource = {
  kind: 'live',
  subject: {
    id: 'one',
    providerId: 1,
    handle: 'one',
    monitorEnabled: true,
    autoRecord: true,
    providerStatus: 'PUBLIC',
    observedAtMs: null,
  },
  stream: {
    sessionId: 'live',
    manifestUrl: '/live.m3u8',
    expiresAtMs: 10000,
    quality: { height: 720, bandwidth: 1000000 },
  },
};
function setup() {
  const video = new Video(),
    handle: { current: MediaSlotHandle | null } = { current: null };
  const props = {
    source,
    active: true,
    muted: true,
    volume: 1,
    onProgress: vi.fn(),
    onReady: vi.fn(),
    onBuffering: vi.fn(),
    onEnded: vi.fn(),
    onPlaying: vi.fn(),
    onAudio: vi.fn(),
    onError: vi.fn(),
    onRecovered: vi.fn(),
    onPhase: vi.fn(),
  };
  const render = (overrides: Partial<typeof props> = {}): void => {
    Object.assign(props, overrides);
    harness.cursor = 0;
    const component = MediaSlot as unknown as {
      render: (props: ComponentProps<typeof MediaSlot>, ref: typeof handle) => ReactElement;
    };
    const tree = component.render({ ...props }, handle);
    (tree as unknown as { ref: { current: unknown } }).ref.current = video;
    harness.layouts.splice(0).forEach((run) => run());
    harness.effects.splice(0).forEach((run) => run());
  };
  render();
  return { video, props, render, handle };
}
it('seeks and reports exact recording identity for identical PDT intervals', async () => {
  const { video, props, render, handle } = setup();
  const segment = {
    id: 'a',
    subjectId: 'one',
    sourceEpoch: 'e',
    sourceSequence: '1',
    mediaObjectId: 'm',
    initObjectId: null,
    durationSeconds: 10,
    wallStartMs: 1000,
    wallEndMs: 11000,
    timeBasis: 'source-pdt' as const,
    uncertaintyMs: 0,
    discontinuity: false,
  };
  const archive: PlayerSource = {
    kind: 'archive',
    subject: source.subject,
    playback: {
      sessionId: 'archive',
      manifestUrl: '/archive.m3u8',
      requestedAtMs: 1000,
      seekOffsetSeconds: 0,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      actualAtMs: 1000,
      segments: [
        { ...segment, recordingUnitId: 'first' },
        { ...segment, id: 'b', recordingUnitId: 'second' },
      ],
    },
  };
  render({ source: archive });
  await Promise.resolve();
  video.fire('loadedmetadata');
  expect(handle.current?.seek(2000, 'second')).toBe(true);
  expect(video.currentTime).toBe(11);
  expect(props.onProgress).toHaveBeenLastCalledWith(2000, 11, 'second');
  expect(handle.current?.seek(2000, 'first')).toBe(true);
  expect(video.currentTime).toBe(1);
  expect(props.onProgress).toHaveBeenLastCalledWith(2000, 1, 'first');
  expect(handle.current?.seek(2000, 'missing')).toBe(false);
  video.fire('seeked');
  props.onProgress.mockClear();
  video.currentTime = 12;
  vi.advanceTimersByTime(101);
  video.fire('timeupdate');
  expect(props.onProgress).toHaveBeenLastCalledWith(3000, 12, 'second');
});
beforeEach(() => {
  vi.mocked(request).mockClear();
  harness.cursor = 0;
  harness.hooks = [];
  harness.effects = [];
  harness.layouts = [];
  engine.failures = [];
  engine.supported = true;
  engine.startLoad.mockClear();
  engine.stopLoad.mockClear();
  engine.recoverMediaError.mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true })),
  );
});
it('releases the lease with keepalive on pagehide so reload can reconnect without occupying two slots', () => {
  setup();
  window.dispatchEvent(new Event('pagehide'));
  expect(request).toHaveBeenCalledWith('/api/live/live', {
    method: 'DELETE',
    keepalive: true,
    operation: 'session',
  });
});
it('suspends downloads and playback while retaining the mounted decoded media', async () => {
  const { handle, video } = setup();
  await Promise.resolve();
  const pause = vi.spyOn(video, 'pause');
  handle.current?.suspend?.();
  expect(pause).toHaveBeenCalled();
  expect(engine.stopLoad).toHaveBeenCalledOnce();
  expect(handle.current?.video).toBe(video);
});
afterEach(() => {
  for (const hook of harness.hooks) (hook as { cleanup?: () => void } | undefined)?.cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('does not publish an unpositioned media clock before metadata is loaded', async () => {
  const { video, props } = setup();
  await Promise.resolve();
  vi.advanceTimersByTime(101);
  video.fire('timeupdate');
  expect(props.onProgress).not.toHaveBeenCalled();
  video.fire('loadedmetadata');
  video.fire('timeupdate');
  expect(props.onProgress).toHaveBeenCalledWith(10000, 0);
});
it('seeks through exact live fragment timestamps and rejects stale progress until seek completion', async () => {
  const { video, props, handle } = setup();
  await Promise.resolve();
  video.fire('loadedmetadata');
  expect(handle.current?.seek(71000)).toBe(true);
  expect(video.currentTime).toBe(21);
  expect(props.onProgress).toHaveBeenLastCalledWith(71000, 21);
  props.onProgress.mockClear();
  video.currentTime = 0;
  video.seeking = true;
  video.fire('timeupdate');
  expect(props.onProgress).not.toHaveBeenCalled();
  video.currentTime = 21;
  video.seeking = false;
  video.fire('seeked');
  expect(props.onProgress).toHaveBeenLastCalledWith(71000, 21);
  expect(handle.current?.seek(50000)).toBe(false);
});

it('does not report an interrupted autoplay request as unavailable media', async () => {
  const { video, props } = setup();
  video.play.mockRejectedValueOnce(
    new DOMException('The play request was interrupted by pause()', 'AbortError'),
  );
  video.fire('loadedmetadata');
  await Promise.resolve();
  expect(props.onError).not.toHaveBeenCalled();
});
it('reports actual initialization and recovery phases rather than simulated progress', async () => {
  const { props, video } = setup();
  expect(props.onPhase).toHaveBeenLastCalledWith('engine');
  await Promise.resolve();
  expect(props.onPhase).toHaveBeenLastCalledWith('manifest');
  video.fire('loadedmetadata');
  expect(props.onPhase).toHaveBeenLastCalledWith('decoding');
  engine.failures[0]('error', { fatal: true, type: 'networkError' });
  expect(props.onPhase).toHaveBeenLastCalledWith('network');
});
it('reports browser autoplay blocking as requiring a user action', async () => {
  const { props, video } = setup();
  video.play.mockRejectedValueOnce(new DOMException('Permission required', 'NotAllowedError'));
  video.fire('loadedmetadata');
  await Promise.resolve();
  expect(props.onPhase).toHaveBeenLastCalledWith('blocked');
  expect(props.onError).toHaveBeenCalledWith('浏览器阻止了自动播放，请点击播放。');
});
it('recovers fatal live network errors through HLS before showing unavailable media', async () => {
  const { props } = setup();
  await Promise.resolve();
  engine.failures[0]('error', { fatal: true, type: 'networkError' });
  expect(props.onError).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(600);
  expect(engine.startLoad).toHaveBeenCalledWith(-1);
});
it('recovers one decoder failure and reports a repeated unrecovered failure', async () => {
  const { props } = setup();
  await Promise.resolve();
  engine.failures[0]('error', { fatal: true, type: 'mediaError' });
  await vi.advanceTimersByTimeAsync(600);
  expect(engine.recoverMediaError).toHaveBeenCalledTimes(1);
  expect(props.onError).not.toHaveBeenCalled();
  engine.failures[0]('error', { fatal: true, type: 'mediaError' });
  expect(props.onError).toHaveBeenCalledWith('视频解码失败，解码器恢复未能完成。');
});
it('resumes active playback after decoder reattachment but preserves a deliberate pause', async () => {
  const { video } = setup();
  await Promise.resolve();
  video.fire('loadedmetadata');
  engine.failures[0]('error', { fatal: true, type: 'mediaError' });
  await vi.advanceTimersByTimeAsync(600);
  video.fire('loadedmetadata');
  expect(video.play).toHaveBeenCalledTimes(2);
});
it('does not autoplay a paused video after decoder reattachment', async () => {
  const { video } = setup();
  await Promise.resolve();
  video.fire('loadedmetadata');
  video.pause();
  engine.failures[0]('error', { fatal: true, type: 'mediaError' });
  await vi.advanceTimersByTimeAsync(600);
  video.fire('loadedmetadata');
  expect(video.play).toHaveBeenCalledTimes(1);
});
it('cancels pending network recovery when the playback source changes', async () => {
  const { render } = setup();
  await Promise.resolve();
  engine.failures[0]('error', { fatal: true, type: 'networkError' });
  render({
    source: {
      ...source,
      stream: { ...source.stream, sessionId: 'replacement' },
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(engine.startLoad).not.toHaveBeenCalled();
});
it('ignores an old source play rejection and detached HLS fatal callback after source replacement', async () => {
  const { video, props, render } = setup();
  await Promise.resolve();
  let rejectPlay: (error: Error) => void = () => undefined;
  video.play.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      }),
  );
  video.fire('loadedmetadata');
  const detachedFailure = engine.failures[0];
  render({
    source: { ...source, stream: { ...source.stream, sessionId: 'next' } },
  });
  rejectPlay(new Error('Old play failed'));
  detachedFailure('error', { fatal: true });
  await Promise.resolve();
  expect(props.onError).not.toHaveBeenCalled();
});
it('does not surface a rejected play request after its slot becomes prepared', async () => {
  const { video, props, render } = setup();
  let rejectPlay: (error: Error) => void = () => undefined;
  video.play.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      }),
  );
  video.fire('loadedmetadata');
  render({ active: false });
  rejectPlay(new Error('Inactive play failed'));
  await Promise.resolve();
  expect(props.onError).not.toHaveBeenCalled();
});
it('recovers an error only after active, unpaused media actually advances', () => {
  const { video, props } = setup();
  video.error = { code: 3 };
  video.fire('error');
  expect(props.onError).toHaveBeenCalledWith('视频解码失败，解码器恢复未能完成。');
  video.error = null;
  video.fire('loadedmetadata');
  video.fire('canplay');
  video.fire('timeupdate');
  expect(props.onRecovered).not.toHaveBeenCalled();
  video.currentTime = 1;
  video.seeking = true;
  video.fire('timeupdate');
  video.seeking = false;
  video.paused = true;
  video.currentTime = 2;
  video.fire('timeupdate');
  expect(props.onRecovered).not.toHaveBeenCalled();
  video.paused = false;
  video.fire('timeupdate');
  video.currentTime = 2.2;
  video.fire('timeupdate');
  expect(props.onRecovered).toHaveBeenCalled();
});
it('defers a terminal HLS failure while buffered media advances, then reports it when the buffer runs out', async () => {
  const { video, props } = setup();
  await Promise.resolve();
  video.fire('loadedmetadata');
  video.fire('timeupdate');
  video.currentTime = 0.2;
  video.fire('timeupdate');
  engine.failures[0]('error', { fatal: true });
  expect(props.onError).not.toHaveBeenCalled();
  video.currentTime = 0.4;
  video.fire('timeupdate');
  video.readyState = 1;
  video.fire('waiting');
  expect(props.onError).toHaveBeenCalledWith('播放引擎无法继续处理当前媒体，请重新连接。');
});
it('keeps the terminal cause after buffered playback recovers a visible failure', async () => {
  const { video, props } = setup();
  await Promise.resolve();
  engine.failures[0]('error', { fatal: true });
  expect(props.onError).toHaveBeenCalledTimes(1);
  video.fire('loadedmetadata');
  video.fire('timeupdate');
  video.currentTime = 0.2;
  video.fire('timeupdate');
  expect(props.onRecovered).toHaveBeenCalledTimes(1);
  video.readyState = 1;
  video.fire('waiting');
  expect(props.onError).toHaveBeenCalledTimes(2);
});
it('uses the same cancellation semantics when activating a prebuffered slot or playing manually', async () => {
  const { video, props, render, handle } = setup();
  render({ active: false });
  video.play.mockRejectedValueOnce(
    new DOMException('Interrupted by a new load request', 'AbortError'),
  );
  render({ active: true });
  await Promise.resolve();
  expect(props.onError).not.toHaveBeenCalled();
  video.play.mockRejectedValueOnce(new DOMException('Unsupported source', 'NotSupportedError'));
  await handle.current?.play();
  expect(props.onError).toHaveBeenCalledWith('浏览器未能启动视频播放，请点击播放重试。');
});
it('ignores a native cancellation but preserves a real native failure even after healthy playback', () => {
  const { video, props } = setup();
  video.fire('loadedmetadata');
  video.fire('timeupdate');
  video.currentTime = 0.2;
  video.fire('timeupdate');
  video.error = { code: 1 };
  video.fire('error');
  expect(props.onError).not.toHaveBeenCalled();
  video.error = { code: 3 };
  video.fire('error');
  expect(props.onError).toHaveBeenCalledWith('视频解码失败，解码器恢复未能完成。');
  video.currentTime = 0.4;
  video.fire('timeupdate');
  expect(props.onRecovered).not.toHaveBeenCalled();
});
it('retains fatal errors in a prepared slot', async () => {
  const { props, render } = setup();
  render({ active: false });
  await Promise.resolve();
  engine.failures[0]('error', { fatal: true });
  expect(props.onError).toHaveBeenCalledWith('播放引擎无法继续处理当前媒体，请重新连接。');
});
it('retains unsupported-browser errors', async () => {
  engine.supported = false;
  const next = setup();
  await Promise.resolve();
  expect(next.props.onError).toHaveBeenCalledWith('此浏览器不支持 HLS 播放。');
});
