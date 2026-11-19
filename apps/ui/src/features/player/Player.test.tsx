import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import type * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Subject, Segment } from '@st-vault/api-schema';
import { Player, type PlayerSource, type PlayerHandle } from './Player';
import { MediaSlot, type MediaSlotHandle } from './MediaSlot';
import { PlaybackNoticeContent } from './PlaybackNoticeContent';

vi.mock('../../shared/lib/api', () => ({ request: vi.fn(() => Promise.resolve()) }));

vi.mock('./MediaSlot', () => ({
  MediaSlot: () => <video />,
  sourceKey: (source: PlayerSource) =>
    source.kind === 'live' ? source.stream.sessionId : source.playback.sessionId,
  closeSource: () => Promise.resolve(),
}));
const hooks = vi.hoisted(() => ({
  enabled: false,
  stateful: false,
  cursor: 0,
  values: [] as unknown[],
  effects: [] as (() => unknown)[],
  cleanups: [] as (() => void)[],
  atMs: 0,
}));
// Keep markup tests on React's renderer; isolate handlers from media/effect hooks
// only when directly exercising the forwarded component below.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return {
    ...actual,
    useState: (value: unknown) => {
      if (hooks.stateful) {
        const index = hooks.cursor++;
        if (index >= hooks.values.length) hooks.values[index] = value;
        return [
          hooks.values[index],
          (next: unknown) => {
            hooks.values[index] = next;
          },
        ];
      }
      return hooks.enabled
        ? [value === null ? hooks.atMs : value, vi.fn()]
        : actual.useState(value);
    },
    useRef: (value: unknown) => {
      if (hooks.stateful) {
        const index = hooks.cursor++;
        return (hooks.values[index] ??= { current: value });
      }
      return hooks.enabled ? { current: value } : actual.useRef(value);
    },
    useEffect: (...args: Parameters<typeof actual.useEffect>) => {
      if (hooks.stateful) hooks.effects.push(args[0]);
      else if (!hooks.enabled) actual.useEffect(...args);
    },
    useImperativeHandle: (...args: Parameters<typeof actual.useImperativeHandle>) => {
      if (hooks.stateful && args[0] && typeof args[0] === 'object') {
        (args[0] as { current: unknown }).current = args[1]();
      } else if (!hooks.enabled) actual.useImperativeHandle(...args);
    },
    useMemo: <T,>(factory: () => T, deps: Parameters<typeof actual.useMemo>[1]) =>
      hooks.enabled ? factory() : actual.useMemo(factory, deps),
    useCallback: <T extends (...args: never[]) => unknown>(
      callback: T,
      deps: Parameters<typeof actual.useCallback>[1],
    ) => (hooks.enabled ? callback : actual.useCallback(callback, deps)),
  };
});

afterEach(() => {
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  hooks.enabled = false;
  hooks.stateful = false;
  hooks.values = [];
  hooks.effects = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const subject: Subject = {
  id: 'stripchat:1',
  providerId: 1,
  handle: 'test',
  monitorEnabled: true,
  autoRecord: true,
  providerStatus: 'PUBLIC',
  observedAtMs: null,
};
const noop = (): void => undefined;
it('renders selected identity and range while the playback request is still pending', () => {
  vi.stubGlobal('document', { fullscreenEnabled: true });
  const html = renderToStaticMarkup(
    <Player
      subject={subject}
      source={null}
      busy
      range={{ fromMs: 1000, toMs: 1801000 }}
      timeline={null}
      onCursor={noop}
      onPrepareNext={() => Promise.resolve(null)}
      onAdvance={noop}
      onFollowLive={noop}
    />,
  );
  expect(html).toContain('https://stripchat.com/test');
  expect(html).toContain('30分钟');
  expect(html.indexOf('class="selection-summary"')).toBeGreaterThan(
    html.indexOf('class="player-actions"'),
  );
  expect(html).not.toContain('点击主播播放直播，或拖选时间段回放');
});
it('shows the idle instruction inside the picture using the shared notice style, without a heading', () => {
  const html = render(null);
  expect(html).not.toContain('class="player-heading');
  expect(html).toContain('class="playback-status"');
  expect(html).toContain('class="playback-status-content"');
  expect(html).toContain('点击主播播放直播，或拖选时间段回放');
  expect(html).toContain('class="playback-status-symbol"');
  expect(html).toContain('<svg');
  expect(html).toContain('<p>选择主播即可观看直播，也可在时间线上拖选录像范围。</p>');
});
const archive: PlayerSource = {
  kind: 'archive',
  subject,
  playback: {
    sessionId: 'archive',
    manifestUrl: '/archive.m3u8',
    requestedAtMs: 1000,
    actualAtMs: 1000,
    seekOffsetSeconds: 0,
    timeBasis: 'source-pdt',
    uncertaintyMs: null,
    segments: [],
  },
};
const live: PlayerSource = {
  kind: 'live',
  subject,
  stream: {
    sessionId: 'live',
    manifestUrl: '/live.m3u8',
    expiresAtMs: 10000,
    quality: { height: 720, bandwidth: 1000000 },
  },
};
function render(source: PlayerSource | null, fullscreenEnabled = true): string {
  vi.stubGlobal('document', { fullscreenEnabled });
  return renderToStaticMarkup(
    <Player
      source={source}
      busy={false}
      timeline={<div data-timeline="focus" />}
      onCursor={noop}
      onPrepareNext={() => Promise.resolve(null)}
      onAdvance={noop}
      onFollowLive={noop}
    />,
  );
}

it('gives every icon control a descriptive label and tooltip, with decorative SVGs', () => {
  const html = render(archive);
  for (const label of ['开始播放', '开启声音', '全屏播放']) {
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*aria-label="${label}"[^>]*title="${label}"[^>]*><svg[^>]*aria-hidden="true"`,
      ),
    );
  }
  expect(html).not.toContain('aria-label="音量"');
  expect(html).not.toContain('aria-label="播放倍速"');
  expect(html).not.toContain('♪');
});

it('uses matching picture badges without archive-only speed controls', () => {
  const liveHtml = render(live),
    archiveHtml = render(archive);
  expect(liveHtml).toContain('aria-label="回到直播"');
  expect(liveHtml).toContain('player-mode-badge is-live');
  expect(archiveHtml).toContain('player-mode-badge is-archive');
  expect(archiveHtml).toContain('aria-label="录像"');
  expect(archiveHtml).not.toMatch(/>录像<\/span>/);
  expect(liveHtml.indexOf('player-mode-badge')).toBeGreaterThan(liveHtml.indexOf('</header>'));
  expect(liveHtml).not.toContain('player-rate');
  expect(archiveHtml).not.toContain('player-rate');
  expect(render(null)).not.toContain('player-mode-badge');
  expect(archiveHtml).not.toContain('aria-label="回到直播"');
  expect(archiveHtml.match(/data-timeline="focus"/g)).toHaveLength(1);
  expect(archiveHtml).not.toContain('type="range"');
});

it('reserves idle controls and disables unavailable playback actions without changing layout', () => {
  expect(render(null)).toContain('class="player-actions"');
  expect(render(null)).toMatch(/<button[^>]*aria-label="开始播放"[^>]*disabled=""/);
  expect(render(archive, false)).toMatch(/<button[^>]*aria-label="全屏播放"[^>]*disabled=""/);
});

it('does not expose point-favorite controls or their placeholder row', () => {
  const html = render(archive);
  expect(html).not.toContain('喜欢此刻');
  expect(html).not.toContain('player-favorites');
});

interface ElementProps {
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'data-review'?: string;
}
function find(
  element: ReactElement<ElementProps>,
  className: string,
): ReactElement<ElementProps> | undefined {
  if (element.type === PlaybackNoticeContent)
    return find(
      PlaybackNoticeContent(
        (element as ReactElement<ComponentProps<typeof PlaybackNoticeContent>>).props,
      ),
      className,
    );
  if (element.props.className?.split(' ').includes(className)) return element;
  for (const child of [element.props.children].flat(Infinity)) {
    if (child && typeof child === 'object' && 'props' in child) {
      const match = find(child as ReactElement<ElementProps>, className);
      if (match) return match;
    }
  }
  return undefined;
}

// Keep the existing handler harness, with persistent state for source/slot swaps.
function playbackHarness(
  source: PlayerSource | null,
  extra: Partial<ComponentProps<typeof Player>> = {},
) {
  hooks.enabled = true;
  hooks.stateful = true;
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', {
    fullscreenEnabled: true,
    addEventListener: vi.fn(),
    removeEventListener: noop,
    querySelector: () => null,
  });
  const props = {
    source,
    busy: false,
    timeline: null,
    ...extra,
    onCursor: vi.fn(),
    onPrepareNext: vi.fn<ComponentProps<typeof Player>['onPrepareNext']>(() =>
      Promise.resolve(null),
    ),
    onAdvance: vi.fn(),
    onFollowLive: noop,
  };
  const handle = { current: null as PlayerHandle | null };
  const render = (): ReactElement<ElementProps> => {
    hooks.cursor = 0;
    const renderPlayer = (
      Player as unknown as {
        render: (
          props: ComponentProps<typeof Player>,
          ref: typeof handle,
        ) => ReactElement<ElementProps>;
      }
    ).render;
    const tree = renderPlayer(props, handle);
    hooks.effects.splice(0).forEach((effect) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup as () => void);
    });
    return tree;
  };
  return { props, render, handle };
}
function mediaSlots(tree: ReactElement): ReactElement<ComponentProps<typeof MediaSlot>>[] {
  if (tree.type === MediaSlot) return [tree as ReactElement<ComponentProps<typeof MediaSlot>>];
  const children = (tree.props as ElementProps).children;
  return [children]
    .flat(Infinity)
    .flatMap((child) =>
      child && typeof child === 'object' && 'props' in child
        ? mediaSlots(child as ReactElement)
        : [],
    );
}
it('resumes a buffered screenshot seek while ordinary seeks preserve pause state', () => {
  const { render, handle } = playbackHarness(live);
  const slot = mediaSlots(render())[0];
  const play = vi.fn(() => Promise.resolve());
  const seek = vi.fn(() => true);
  (slot as unknown as { ref: (value: MediaSlotHandle) => void }).ref({
    video: null,
    play,
    seek,
    liveEdge: () => null,
  });
  expect(handle.current?.seek(1000)).toBe(true);
  expect(play).not.toHaveBeenCalled();
  expect(handle.current?.seek(2000, true)).toBe(true);
  expect(play).toHaveBeenCalledOnce();
  seek.mockReturnValue(false);
  expect(handle.current?.seek(3000, true)).toBe(false);
  expect(play).toHaveBeenCalledOnce();
});
it('keeps live playback mounted until the requested screenshot archive is ready', () => {
  const { props, render } = playbackHarness(live);
  const liveSlot = mediaSlots(render())[0];
  liveSlot.props.onReady();
  props.source = archive;
  render();
  const slots = mediaSlots(render());
  expect(slots).toHaveLength(2);
  expect(slots[0].props.source).toBe(live);
  expect(slots[0].props.active).toBe(true);
  expect(slots[1].props.source).toBe(archive);
  expect(slots[1].props.active).toBe(false);
  slots[1].props.onReady();
  const active = mediaSlots(render());
  expect(active).toHaveLength(1);
  expect(active[0].props.source).toBe(archive);
  expect(active[0].props.active).toBe(true);
  expect(props.onAdvance).not.toHaveBeenCalled();
});

it('keeps stale progress from the retained source out of a new playback request', () => {
  const { props, render } = playbackHarness(live);
  const slot = mediaSlots(render())[0];
  slot.props.onReady();
  props.busy = true;
  render();
  slot.props.onProgress(1000, 1);
  expect(props.onCursor).not.toHaveBeenCalled();
  props.busy = false;
  props.source = archive;
  render();
  slot.props.onProgress(2000, 2);
  expect(props.onCursor).not.toHaveBeenCalled();
});
it('does not seek a retained decoder while a newer playback lookup owns the cursor', () => {
  const { props, render, handle } = playbackHarness(live);
  const slot = mediaSlots(render())[0];
  const seek = vi.fn(() => true);
  (slot as unknown as { ref: (value: MediaSlotHandle) => void }).ref({
    video: null,
    seek,
    play: () => Promise.resolve(),
    liveEdge: () => null,
  });
  props.busy = true;
  render();
  expect(handle.current?.seek(2000, true)).toBe(false);
  expect(seek).not.toHaveBeenCalled();
});
it('does not activate an earlier screenshot preparation while a newer lookup is pending', () => {
  const { props, render } = playbackHarness(live);
  mediaSlots(render())[0].props.onReady();
  props.source = archive;
  render();
  const prepared = mediaSlots(render())[1];
  props.busy = true;
  render();
  prepared.props.onReady();
  expect(props.onCursor).not.toHaveBeenCalled();
  expect(mediaSlots(render())[0].props.source).toBe(live);
});
it('ignores a superseded screenshot preparation and activates only the latest target', () => {
  const { props, render } = playbackHarness(live);
  mediaSlots(render())[0].props.onReady();
  props.source = archive;
  render();
  const stale = mediaSlots(render())[1];
  const latest: PlayerSource = {
    ...archive,
    playback: { ...archive.playback, sessionId: 'latest-click' },
  };
  props.source = latest;
  render();
  const next = mediaSlots(render())[1];
  stale.props.onReady();
  stale.props.onError('Stale preparation failed');
  expect(mediaSlots(render())[0].props.source).toBe(live);
  expect(find(render(), 'form-error')).toBeUndefined();
  next.props.onReady();
  expect(mediaSlots(render())[0].props.source).toBe(latest);
});
it('suspends a deleted source without destroying its decoded frame and replaces it at first-frame readiness', () => {
  const { props, render, handle } = playbackHarness(archive);
  const slot = mediaSlots(render())[0];
  const pause = vi.fn(),
    suspend = vi.fn(),
    seek = vi.fn(() => true);
  (slot as unknown as { ref: (value: MediaSlotHandle) => void }).ref({
    video: { pause } as unknown as HTMLVideoElement,
    play: vi.fn(),
    seek,
    liveEdge: () => null,
    suspend,
  });
  slot.props.onReady();
  handle.current?.suspend();
  slot.props.onProgress(1000, 1);
  expect(props.onCursor).not.toHaveBeenCalled();
  expect(pause).toHaveBeenCalled();
  expect(suspend).toHaveBeenCalled();
  expect(handle.current?.seek(1000)).toBe(false);
  expect(seek).not.toHaveBeenCalled();
  expect(mediaSlots(render())[0].props.source).toBe(archive);
  const next: PlayerSource = {
    ...archive,
    playback: { ...archive.playback, sessionId: 'after-deletion' },
  };
  props.source = next;
  render();
  const replacement = mediaSlots(render())[1];
  expect(replacement.props.bufferAheadSeconds).toBe(0);
  replacement.props.onReady();
  expect(mediaSlots(render())[0].props.source).toBe(next);
});
it('keeps overlays inside the picture and the seek lane outside it in the shared stage', () => {
  const { render } = playbackHarness(archive, {
    timeline: <div className="test-seek-lane" />,
    snapshots: <div className="test-snapshot-area" />,
  });
  const tree = render();
  const picture = find(tree, 'player-picture')!;
  expect(find(picture, 'player-heading')).toBeDefined();
  expect(find(picture, 'player-actions')).toBeDefined();
  expect(find(picture, 'test-seek-lane')).toBeUndefined();
  expect(find(find(tree, 'media-review')!, 'test-seek-lane')).toBeDefined();
  expect(find(find(tree, 'media-review')!, 'test-snapshot-area')).toBeDefined();
  expect(find(picture, 'test-snapshot-area')).toBeUndefined();
  expect(find(tree, 'test-snapshot-area')).toBeDefined();
});
function keyboardHandler(type: string) {
  const call = vi
    .mocked(document.addEventListener)
    .mock.calls.slice()
    .reverse()
    .find(([name]) => name === type);
  expect(call, `document ${type} listener`).toBeDefined();
  return call![1] as (event: unknown) => void;
}

it('keeps review visibility separate from player chrome and toggles only on manual action', () => {
  const { render } = playbackHarness(archive);
  const tree = render();
  const toggle = find(tree, 'review-toggle');
  expect(toggle).toBeDefined();
  expect(toggle!.props['aria-expanded']).toBe(true);
  expect(tree.props['data-review']).toBe('expanded');
  toggle!.props.onClick!();
  const collapsed = render();
  expect(collapsed.props['data-review']).toBe('collapsed');
  expect(find(collapsed, 'review-toggle')!.props['aria-expanded']).toBe(false);
  find(collapsed, 'review-toggle')!.props.onClick!();
  expect(render().props['data-review']).toBe('expanded');
});

it('clamps live shortcuts to buffered media and stops handling them after suspension or disconnect', () => {
  const { render, handle } = playbackHarness(live);
  const tree = render();
  const slot = mediaSlots(tree)[0];
  const slotRef = (slot as unknown as { ref: (handle: MediaSlotHandle) => void }).ref;
  const video = {
    currentTime: 8,
    pause: vi.fn(),
    seekable: { length: 1, start: () => 0, end: () => 12 },
  } as unknown as HTMLVideoElement;
  slotRef({ video } as MediaSlotHandle);
  const key = { key: 'ArrowRight', target: { closest: () => null }, preventDefault: vi.fn() };
  const down = keyboardHandler('keydown');
  down(key);
  expect(video.currentTime).toBeCloseTo(11.99);
  down({ ...key, key: 'ArrowLeft' });
  expect(video.currentTime).toBeCloseTo(6.99);
  handle.current!.suspend();
  down(key);
  expect(key.preventDefault).toHaveBeenCalledTimes(2);
  handle.current!.stop();
  down(key);
  expect(key.preventDefault).toHaveBeenCalledTimes(2);
  render();
  keyboardHandler('keydown')(key);
  expect(key.preventDefault).toHaveBeenCalledTimes(2);
});

it('seeks during repeated arrow keydown events before keyup, even before a new frame arrives', () => {
  const segment: Segment = {
    id: 's',
    subjectId: subject.id,
    sourceEpoch: 'e',
    sourceSequence: '1',
    mediaObjectId: 'm',
    initObjectId: null,
    durationSeconds: 60,
    wallStartMs: 1000,
    wallEndMs: 61000,
    timeBasis: 'source-pdt',
    uncertaintyMs: 0,
    discontinuity: false,
  };
  const onSeek = vi.fn();
  const { render } = playbackHarness(
    {
      ...archive,
      playback: { ...archive.playback, rangeFromMs: 1000, rangeToMs: 61000, segments: [segment] },
    },
    { onSeek },
  );
  const tree = render();
  const slot = mediaSlots(tree)[0];
  const slotRef = (slot as unknown as { ref: (handle: MediaSlotHandle) => void }).ref;
  expect(typeof slotRef).toBe('function');
  if (typeof slotRef !== 'function') throw Error('Missing media slot');
  slotRef({ video: { currentTime: 10 } as HTMLVideoElement } as MediaSlotHandle);
  // The focused streamer button is outside the player: keys must still reach it.
  const handlers = { onKeyDown: keyboardHandler('keydown'), onKeyUp: keyboardHandler('keyup') };
  const preventDefault = vi.fn();
  const key = { key: 'ArrowRight', target: { closest: () => null }, preventDefault };
  handlers.onKeyDown(key);
  handlers.onKeyDown({ ...key, repeat: true });
  expect(onSeek.mock.calls).toEqual([[16000], [21000]]);
  expect(preventDefault).toHaveBeenCalledTimes(2);
  handlers.onKeyUp(key);
  handlers.onKeyDown({ ...key, key: 'ArrowLeft' });
  expect(onSeek).toHaveBeenLastCalledWith(6000);
  handlers.onKeyDown({ ...key, target: { closest: () => ({}) } });
  expect(onSeek).toHaveBeenCalledTimes(3);
});
it('uses the selected cover and real server phase before a media session exists', () => {
  vi.useFakeTimers();
  const { render } = playbackHarness(null, {
    busy: true,
    subject,
    liveProgress: { phase: 'resolving' },
  });
  const tree = render();
  expect(find(tree, 'playback-poster')).toBeDefined();
  expect(find(tree, 'playback-status-content')).toBeUndefined();
  vi.advanceTimersByTime(600);
  expect(JSON.stringify(find(render(), 'playback-status-content'))).toContain('获取直播源');
  vi.advanceTimersByTime(10000);
  const waiting = render();
  expect(find(waiting, 'playback-status--brief')).toBeDefined();
  expect(find(find(waiting, 'playback-status--brief')!, 'playback-poster')).toBeUndefined();
  expect(find(waiting, 'playback-poster')).toBeDefined();
  expect(mediaSlots(tree)).toHaveLength(0);
});
it('keeps buffered frames visible during a temporary wait and removes the notice after readiness', () => {
  vi.useFakeTimers();
  const { render } = playbackHarness(live);
  const slot = mediaSlots(render())[0];
  slot.props.onReady();
  slot.props.onBuffering();
  slot.props.onPhase?.('network');
  expect(find(render(), 'playback-status')).toBeUndefined();
  vi.advanceTimersByTime(600);
  expect(find(render(), 'playback-status--brief')).toBeDefined();
  expect(find(render(), 'playback-poster')).toBeUndefined();
  slot.props.onReady();
  expect(find(render(), 'playback-status')).toBeUndefined();
});
it('does not announce an archive end while the next session is being prepared', async () => {
  vi.useFakeTimers();
  const current: PlayerSource = { ...archive, playback: { ...archive.playback, nextAtMs: 2000 } };
  const { props, render } = playbackHarness(current);
  let finish!: (value: null) => void;
  props.onPrepareNext.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const slot = mediaSlots(render())[0];
  slot.props.onReady();
  slot.props.onProgress(1000, 0);
  slot.props.onEnded();
  expect(find(render(), 'playback-status-content')).toBeUndefined();
  vi.advanceTimersByTime(600);
  expect(JSON.stringify(find(render(), 'playback-status-content'))).toContain('等待后续画面');
  finish(null);
  await Promise.resolve();
  await Promise.resolve();
  expect(JSON.stringify(find(render(), 'playback-status-content'))).toContain('当前录像已播完');
});
it('stops live media on confirmed privacy loss but leaves archive playback independent', () => {
  const { props, render } = playbackHarness(live, {
    liveProgress: { phase: 'stopped', reason: 'private' },
  });
  expect(mediaSlots(render())).toHaveLength(0);
  expect(find(render(), 'playback-status')).toBeDefined();
  props.source = archive;
  props.live = false;
  render();
  expect(mediaSlots(render())).toHaveLength(1);
});
it('does not cover current good video when next-session preparation fails', async () => {
  const current: PlayerSource = { ...archive, playback: { ...archive.playback, nextAtMs: 2000 } };
  const { props, render } = playbackHarness(current);
  props.onPrepareNext.mockRejectedValue(new Error('read failed'));
  const slot = mediaSlots(render())[0];
  slot.props.onReady();
  slot.props.onProgress(1000, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(find(render(), 'form-error')).toBeUndefined();
  slot.props.onEnded();
  expect(find(render(), 'form-error')).toBeDefined();
});
it('presents autoplay permission as a manual action instead of endless loading', () => {
  const { render } = playbackHarness(live);
  const slot = mediaSlots(render())[0];
  slot.props.onPhase?.('blocked');
  slot.props.onError('浏览器阻止了自动播放，请点击播放。');
  expect(find(render(), 'playback-status-symbol')?.props.className).not.toContain('spinner');
  expect(JSON.stringify(find(render(), 'playback-status-content'))).toContain('等待点击播放');
  expect(find(render(), 'form-error')).toBeUndefined();
});
it('keeps fullscreen failures out of media errors', async () => {
  const { render } = playbackHarness(live);
  vi.stubGlobal('document', {
    fullscreenEnabled: true,
    fullscreenElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    exitFullscreen: () => Promise.reject(new Error('denied')),
  });
  mediaSlots(render())[0].props.onReady();
  find(render(), 'fullscreen-button')?.props.onClick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(find(render(), 'player-control-feedback')).toBeDefined();
  expect(find(render(), 'playback-status')).toBeUndefined();
});
it('ignores stale slot callbacks after replacing a source in the same bank index', () => {
  const { props, render } = playbackHarness(live),
    old = mediaSlots(render())[0];
  props.source = { ...live, stream: { ...live.stream, sessionId: 'new-live' } };
  render();
  const next = mediaSlots(render())[0];
  old.props.onError('媒体暂不可用。');
  old.props.onProgress(123, 1);
  old.props.onReady();
  expect(props.onCursor).not.toHaveBeenCalled();
  expect(find(render(), 'form-error')).toBeUndefined();
  next.props.onError('媒体暂不可用。');
  expect(find(render(), 'form-error')).toBeDefined();
  old.props.onRecovered();
  expect(find(render(), 'form-error')).toBeDefined();
  next.props.onReady();
  expect(find(render(), 'form-error')).toBeDefined();
  next.props.onRecovered();
  expect(find(render(), 'form-error')).toBeUndefined();
});
it('keeps a prepared slot failure separate from the playing source and surfaces it when continuation is needed', async () => {
  const current: PlayerSource = {
    ...archive,
    playback: { ...archive.playback, nextAtMs: 2000 },
  };
  const next = {
    ...current,
    playback: { ...current.playback, sessionId: 'prepared' },
  };
  const { props, render } = playbackHarness(current);
  props.onPrepareNext.mockResolvedValue(next);
  mediaSlots(render())[0].props.onProgress(1000, 0);
  await vi.waitFor(() => {
    expect(mediaSlots(render())).toHaveLength(2);
  });
  const [activeSlot, preparedSlot] = mediaSlots(render());
  expect(preparedSlot).toBeDefined();
  preparedSlot.props.onError('媒体暂不可用。');
  expect(find(render(), 'form-error')).toBeUndefined();
  activeSlot.props.onEnded();
  expect(find(render(), 'form-error')).toBeDefined();
  expect(props.onAdvance).not.toHaveBeenCalled();
});
it('activates the prepared slot and releases the old slot without a history flush', async () => {
  const current: PlayerSource = { ...archive, playback: { ...archive.playback, nextAtMs: 2000 } };
  const next = { ...current, playback: { ...current.playback, sessionId: 'prepared-success' } };
  const { props, render } = playbackHarness(current);
  props.onPrepareNext.mockResolvedValue(next);
  mediaSlots(render())[0].props.onProgress(1000, 0);
  await vi.waitFor(() => expect(mediaSlots(render())).toHaveLength(2));
  const [active, prepared] = mediaSlots(render());
  prepared.props.onReady();
  active.props.onEnded();
  const remaining = mediaSlots(render());
  expect(remaining).toHaveLength(1);
  expect(remaining[0].props.source).toEqual(next);
  expect(remaining[0].props.active).toBe(true);
  expect(props.onAdvance).toHaveBeenCalledWith(next);
});
it('stops both active media and a pending continuation without resurrecting late results', async () => {
  const current: PlayerSource = { ...archive, playback: { ...archive.playback, nextAtMs: 2000 } };
  const next = { ...current, playback: { ...current.playback, sessionId: 'deleted-preparation' } };
  const { props, render, handle } = playbackHarness(current);
  let finish!: (source: typeof next) => void;
  props.onPrepareNext.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const slot = mediaSlots(render())[0];
  const pause = vi.fn();
  (slot as unknown as { ref: (value: MediaSlotHandle) => void }).ref({
    video: { pause } as unknown as HTMLVideoElement,
    play: () => Promise.resolve(),
    seek: () => true,
    liveEdge: () => null,
  });
  slot.props.onProgress(1000, 0);
  await vi.waitFor(() => expect(props.onPrepareNext).toHaveBeenCalled());
  handle.current!.stop();
  // The owner clears its source in the same confirmed-deletion transition.
  props.source = null;
  expect(pause).toHaveBeenCalledOnce();
  expect(mediaSlots(render())).toHaveLength(0);
  finish(next);
  await Promise.resolve();
  await Promise.resolve();
  expect(mediaSlots(render())).toHaveLength(0);
  expect(props.onAdvance).not.toHaveBeenCalled();
});
