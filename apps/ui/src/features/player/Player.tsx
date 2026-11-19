import { tr } from '../../shared/lib/i18n';
import { request } from '../../shared/lib/api';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  LivePlaybackResponse,
  LiveProgress,
  PlaybackResponse,
  Subject,
} from '@st-vault/api-schema';
import { CoverImage } from '../directory/CoverImage';
import { displayStatus } from '../directory/subjects';
import { liveNotice, mediaNotice, type MediaPhase, type PlaybackNotice } from './player-status';
import { Preparation, shouldPrepareNext } from './playback-continuation';
import { closeSource, MediaSlot, sourceKey, type MediaSlotHandle } from './MediaSlot';
import './player-controls.css';
import { Icon } from '../../design/Icon';
import { mediaTimeToUtc, mediaTimePosition } from '../timeline/timeline';
import type { ViewWindow } from '../timeline/range-control';
import { PlayerHeading } from './PlayerHeading';
import { PlaybackNoticeContent } from './PlaybackNoticeContent';
import { SelectionSummary } from './SelectionSummary';
import { PlayerActivity } from './player-activity';
import { bindPlayerKeyboard, PLAYER_SEEK_SECONDS } from './player-keyboard';
import { usePressVisibility } from '../../shared/lib/use-press-visibility';
import { useNoticeStage } from './use-notice-stage';

export type PlayerSource =
  | { kind: 'live'; stream: LivePlaybackResponse; subject: Subject }
  | { kind: 'archive'; playback: PlaybackResponse; subject: Subject; unitId?: string };
export type ArchivePlayerSource = Extract<PlayerSource, { kind: 'archive' }>;
export interface PlayerHandle {
  stop: () => void;
  seek: (utc: number, resume?: boolean, unitId?: string) => boolean;
  suspend: () => void;
}
interface Props {
  siteOrigin?: string | null;
  range?: ViewWindow | null;
  controlsPinned?: boolean;
  tools?: ReactNode;
  source: PlayerSource | null;
  busy: boolean;
  subject?: Subject | null;
  notice?: PlaybackNotice | null;
  liveProgress?: LiveProgress | null;
  live?: boolean;
  onRetry?: () => void;
  onImportKeys?: () => void;
  onChooseCdn?: () => void;
  timeline: ReactNode;
  snapshots?: ReactNode;
  onSeek?: (utc: number) => void;
  onCursor: (utc: number, unitId?: string) => void;
  onPrepareNext: (
    current: ArchivePlayerSource,
    signal: AbortSignal,
  ) => Promise<ArchivePlayerSource | null>;
  onAdvance: (next: ArchivePlayerSource) => void;
  onFollowLive: (follow: boolean) => void;
}
interface Bank {
  sources: [PlayerSource | null, PlayerSource | null];
  active: number;
}

export const Player = forwardRef<PlayerHandle, Props>(function Player(
  {
    siteOrigin,
    tools,
    range = null,
    controlsPinned = false,
    source,
    busy,
    subject,
    notice,
    liveProgress,
    live = true,
    onRetry,
    onImportKeys,
    onChooseCdn,
    timeline,
    snapshots,
    onSeek,
    onCursor,
    onPrepareNext,
    onAdvance,
    onFollowLive,
  },
  ref,
): JSX.Element {
  const root = useRef<HTMLElement>(null),
    slots = useRef<(MediaSlotHandle | null)[]>([null, null]);
  const heldSeek = useRef<number | null>(null);
  const [bank, setBank] = useState<Bank>({
    sources: [source, null],
    active: 0,
  });
  const current = useRef(bank);
  const suspended = useRef(false);
  current.current = bank;
  const [playing, setPlaying] = useState(false),
    [muted, setMuted] = useState(true),
    [volume, setVolume] = useState(1),
    [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState(''),
    [phase, setPhase] = useState<MediaPhase>('engine'),
    [replacementPhase, setReplacementPhase] = useState<MediaPhase>('engine'),
    [hasFrame, setHasFrame] = useState(false),
    [controlError, setControlError] = useState(''),
    [ready, setReady] = useState(false);

  const readiness = useRef(new Set<string>()),
    slotErrors = useRef(new Map<string, string>()),
    waiting = useRef(false),
    generation = useRef(0);
  const replacement = useRef<string | null>(null);
  const preparation = useRef(
    new Preparation<ArchivePlayerSource>((next) => {
      void closeSource(next).catch((error) =>
        console.warn('Prepared playback release failed', error),
      );
    }),
  );
  const callbacks = useRef({
    source,
    busy,
    onCursor,
    onPrepareNext,
    onAdvance,
  });
  callbacks.current = {
    source,
    busy,
    onCursor,
    onPrepareNext,
    onAdvance,
  };
  const ownsCursor = (item: PlayerSource): boolean => {
    const requested = callbacks.current.source;
    return (
      !suspended.current &&
      !callbacks.current.busy &&
      !!requested &&
      sourceKey(requested) === sourceKey(item)
    );
  };
  const activeSource = bank.sources[bank.active];
  const diagnosticSubject = source?.subject.id;
  const diagnosticMedia = source?.kind;
  useEffect(() => {
    if (!diagnosticSubject || !diagnosticMedia) return;
    void request('/api/diagnostics/player', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: diagnosticSubject,
        media: diagnosticMedia,
        phase,
        ready,
        error: error.slice(0, 1024),
      }),
      signal: AbortSignal.timeout(5000),
    }).catch((cause) => console.warn('Player diagnostics could not be saved', cause));
  }, [diagnosticSubject, diagnosticMedia, phase, ready, error]);
  const activeVideo = (): HTMLVideoElement | null =>
    slots.current[current.current.active]?.video ?? null;
  const cancelPrepared = (): void => {
    replacement.current = null;
    generation.current++;
    preparation.current.cancel();
    waiting.current = false;
    slotErrors.current.delete('preparation');
    const previous = current.current;
    const discarded = previous.sources[1 - previous.active];
    if (discarded) {
      readiness.current.delete(sourceKey(discarded));
      slotErrors.current.delete(sourceKey(discarded));
    }
    const sources = [...previous.sources] as Bank['sources'];
    sources[1 - previous.active] = null;
    const next = { ...previous, sources };
    current.current = next;
    setBank(next);
  };
  useImperativeHandle(
    ref,
    () => ({
      suspend: () => {
        heldSeek.current = null;
        suspended.current = true;
        cancelPrepared();
        const slot = slots.current[current.current.active];
        slot?.video?.pause();
        slot?.suspend?.();
      },
      stop: () => {
        heldSeek.current = null;
        suspended.current = false;
        generation.current++;
        preparation.current.cancel();
        replacement.current = null;
        waiting.current = false;
        for (const slot of slots.current) slot?.video?.pause();
        const empty: Bank = { sources: [null, null], active: 0 };
        current.current = empty;
        setBank(empty);
        readiness.current.clear();
        slotErrors.current.clear();
        setError('');
        setControlError('');
        setHasFrame(false);
        setReady(false);
        setPlaying(false);
      },
      seek: (utc, resume = false, unitId) => {
        const active = current.current.sources[current.current.active];
        if (!active || !ownsCursor(active) || replacement.current) return false;
        cancelPrepared();
        const slot = slots.current[current.current.active];
        if (!slot?.seek(utc, unitId)) return false;
        if (resume)
          void slot
            .play()
            .catch((cause) => console.warn('Snapshot playback could not resume', cause));
        return true;
      },
    }),
    [],
  );
  useEffect(() => {
    const active = current.current.sources[current.current.active];
    if ((!source && !active) || (source && active && sourceKey(source) === sourceKey(active)))
      return;
    suspended.current = false;
    generation.current++;
    preparation.current.cancel();
    waiting.current = false;
    replacement.current = null;
    // A screenshot seek keeps the current decoded picture until its archive slot is ready.
    if (hasFrame && source?.kind === 'archive' && active?.subject.id === source.subject.id) {
      const previous = current.current;
      const discarded = previous.sources[1 - previous.active];
      if (discarded) {
        readiness.current.delete(sourceKey(discarded));
        slotErrors.current.delete(sourceKey(discarded));
      }
      const sources = [...previous.sources] as Bank['sources'];
      sources[1 - previous.active] = source;
      const next = { ...previous, sources };
      replacement.current = sourceKey(source);
      current.current = next;
      setBank(next);
      setError('');
      setControlError('');
      setReplacementPhase('engine');
      return;
    }
    readiness.current.clear();
    slotErrors.current.clear();
    const next: Bank = { sources: [source, null], active: 0 };
    current.current = next;
    setBank(next);
    setError('');
    setReady(false);
    setHasFrame(false);
    setPhase('engine');
    setControlError('');
    setPlaying(false);
  }, [source]);
  useEffect(
    () => () => {
      generation.current++;
      preparation.current.cancel();
    },
    [],
  );
  function advance(): void {
    const previous = current.current,
      target = 1 - previous.active,
      nextSource = previous.sources[target];
    const failure = nextSource && slotErrors.current.get(sourceKey(nextSource));
    if (failure) {
      setError(failure);
      return;
    }
    if (nextSource?.kind !== 'archive' || !readiness.current.has(sourceKey(nextSource))) return;
    const old = previous.sources[previous.active];
    const replacing = replacement.current === sourceKey(nextSource);
    const owner = replacing ? nextSource : old;
    if (!owner || !ownsCursor(owner)) return;
    slots.current[previous.active]?.video?.pause();
    // Keep the prepared element mounted as the active slot, retaining its decoded frame.
    const next: Bank = {
      sources: [...previous.sources] as Bank['sources'],
      active: target,
    };
    replacement.current = null;
    if (old) {
      readiness.current.delete(sourceKey(old));
      slotErrors.current.delete(sourceKey(old));
    }
    next.sources[previous.active] = null;
    current.current = next;
    waiting.current = false;
    generation.current++;
    preparation.current.cancel();
    setBank(next);
    setReady(true);
    setError('');
    if (!replacing) callbacks.current.onAdvance(nextSource);
    callbacks.current.onCursor(
      nextSource.playback.actualAtMs,
      mediaTimePosition(nextSource.playback.segments, nextSource.playback.seekOffsetSeconds)
        ?.unitId,
    );
  }
  function prepare(mediaTime: number): void {
    if (replacement.current) return;
    const active = current.current.sources[current.current.active];
    if (active?.kind !== 'archive' || !shouldPrepareNext(active.playback, mediaTime)) return;
    const expected = generation.current;
    void preparation.current
      .run(async (signal) => {
        const next = await callbacks.current.onPrepareNext(active, signal);
        if (!next && expected === generation.current && waiting.current) {
          setPhase('ended');
          setReady(false);
        }
        return next;
      })
      .then((nextSource) => {
        if (expected === generation.current) slotErrors.current.delete('preparation');
        if (!nextSource) return;
        if (expected !== generation.current) {
          void closeSource(nextSource).catch((error) =>
            console.warn('Prepared playback release failed', error),
          );
          return;
        }
        const previous = current.current,
          target = 1 - previous.active;
        const sources = [...previous.sources] as Bank['sources'];
        sources[target] = nextSource;
        const next = { ...previous, sources };
        current.current = next;
        setBank(next);
      })
      .catch((error: unknown) => {
        if (
          expected === generation.current &&
          !(error instanceof Error && error.name === 'AbortError')
        )
          if (waiting.current) setError(tr('下一段录像读取失败，请重新选取时间范围。'));
          else
            slotErrors.current.set('preparation', tr('下一段录像读取失败，请重新选取时间范围。'));
      });
  }
  useEffect(() => {
    const changed = (): void => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  async function toggleFullscreen(): Promise<void> {
    try {
      setControlError('');
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {
      setControlError(tr('无法切换全屏'));
    }
  }
  async function togglePlay(): Promise<void> {
    if (suspended.current || replacement.current) return;
    const slot = slots.current[current.current.active],
      video = slot?.video;
    if (!video) return;
    if (!video.paused) video.pause();
    else await slot.play();
  }
  const stopped = live && liveProgress?.phase === 'stopped';
  const serverNotice =
    liveProgress && live && (liveProgress.phase !== 'ended' || phase === 'ended')
      ? liveNotice(liveProgress)
      : null;
  const displayNotice: PlaybackNotice | null =
    notice ??
    (stopped ? serverNotice : null) ??
    (error
      ? {
          kind: phase === 'blocked' ? 'action' : 'error',
          title: phase === 'blocked' ? tr('等待点击播放') : tr('播放已中断'),
          detail: error,
          retry: true,
        }
      : null) ??
    (busy
      ? (serverNotice ?? {
          kind: 'loading',
          title: live ? tr('请求直播会话') : tr('准备所选录像'),
          detail: live
            ? tr('正在向本机服务请求直播连接。')
            : tr('服务器正在定位所选时间范围内的录像分片。'),
        })
      : null) ??
    (replacement.current ||
    (source && activeSource && sourceKey(source) !== sourceKey(activeSource))
      ? mediaNotice(replacementPhase, false)
      : null) ??
    (activeSource && !ready
      ? (serverNotice ?? mediaNotice(phase, activeSource.kind === 'live'))
      : null);
  const poster = subject ?? source?.subject;
  const [reviewCollapsed, setReviewCollapsed] = useState(false);
  const review = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (review.current) review.current.inert = fullscreen && reviewCollapsed;
  }, [fullscreen, reviewCollapsed]);
  const presentFrame = hasFrame;
  const noticeStage = useNoticeStage(displayNotice, poster?.id ?? 'player');
  const showPoster = !!displayNotice && (!presentFrame || stopped);
  const [chromeVisible, setChromeVisible] = useState(false),
    [keyboardFocus, setKeyboardFocus] = useState(false);
  const activity = useRef<PlayerActivity | null>(null);
  activity.current ??= new PlayerActivity(setChromeVisible);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const press = usePressVisibility({
    controls: controlsPinned || keyboardFocus || chromeVisible,
    heading: chromeVisible,
  });
  const visible = press.value.controls;
  const seekKey = useRef<(direction: -1 | 1) => boolean>(() => false);
  seekKey.current = (direction) => {
    const video = activeVideo();
    if (
      suspended.current ||
      stopped ||
      !video ||
      !activeSource ||
      current.current.sources[current.current.active] !== activeSource ||
      (poster && poster.id !== activeSource.subject.id)
    )
      return false;
    const offset = direction * PLAYER_SEEK_SECONDS;
    if (activeSource.kind === 'live') {
      if (!video.seekable.length) return false;
      video.currentTime = Math.max(
        video.seekable.start(0),
        Math.min(video.seekable.end(video.seekable.length - 1) - 0.01, video.currentTime + offset),
      );
    } else {
      const at = mediaTimeToUtc(activeSource.playback.segments, video.currentTime);
      if (at === null || !onSeek) return false;
      heldSeek.current = Math.max(
        activeSource.playback.rangeFromMs ?? 0,
        Math.min(
          (activeSource.playback.rangeToMs ?? Number.MAX_SAFE_INTEGER) - 1,
          (heldSeek.current ?? at) + offset * 1000,
        ),
      );
      onSeek(heldSeek.current);
    }
    activity.current!.wake();
    return true;
  };
  useEffect(
    () =>
      bindPlayerKeyboard(
        (direction) => seekKey.current(direction),
        () => {
          heldSeek.current = null;
        },
      ),
    [],
  );
  useEffect(() => {
    heldSeek.current = null;
  }, [poster?.id]);
  useEffect(() => () => activity.current?.dispose(), []);
  const interactiveRegions = '.player-heading, .player-bottom';
  const updateHover = (point: { x: number; y: number } | null): void => {
    if (!point) {
      lastPointer.current = null;
      activity.current!.hide();
      return;
    }
    // The heading is pointer-transparent; hit-test geometry rather than DOM ownership.
    activity.current!.setInteractive(
      !!point &&
        [...(root.current?.querySelectorAll(interactiveRegions) ?? [])].some((region) => {
          const box = region.getBoundingClientRect();
          return (
            point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom
          );
        }),
    );
  };
  useEffect(() => {
    // Fullscreen changes move regions under a stationary pointer.
    updateHover(lastPointer.current);
  }, [fullscreen]);
  return (
    <section
      ref={root}
      className="inline-player"
      data-chrome={visible ? 'visible' : 'hidden'}
      data-review={reviewCollapsed ? 'collapsed' : 'expanded'}
      tabIndex={0}
      onPointerOverCapture={(event) =>
        updateHover(
          (event.target as Element).closest('.player-picture')
            ? { x: event.clientX, y: event.clientY }
            : null,
        )
      }
      onPointerMoveCapture={(event) => {
        if (!(event.target as Element).closest('.player-picture')) {
          updateHover(null);
          return;
        }
        const point = { x: event.clientX, y: event.clientY };
        updateHover(point);
        if (lastPointer.current?.x === point.x && lastPointer.current.y === point.y) return;
        lastPointer.current = point;
        activity.current!.wake();
      }}
      onWheelCapture={(event) => {
        if ((event.target as Element).closest('.player-picture')) activity.current!.wake();
      }}
      onPointerLeave={() => {
        if (fullscreen) {
          lastPointer.current = null;
          activity.current!.hide();
        }
      }}
      onFocusCapture={(event) => {
        if ((event.target as Element).closest('.media-review, .review-toggle')) return;
        if (event.target.matches(':focus-visible')) {
          setKeyboardFocus(true);
          activity.current!.wake();
        }
      }}
      onBlurCapture={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) ||
          event.relatedTarget?.closest('.media-review, .review-toggle')
        )
          setKeyboardFocus(false);
      }}
      onPointerDownCapture={(event) => {
        setKeyboardFocus(false);
        if (
          (event.target as Element).closest('.player-picture') &&
          !(event.target as HTMLElement).closest('input, select, button, [role="slider"]')
        )
          event.currentTarget.focus({ preventScroll: true });
      }}
      aria-label={activeSource?.kind === 'live' ? tr('直播播放器') : tr('录像播放器')}
    >
      <div className="player-stage">
        <div
          className="player-picture"
          data-chrome={visible ? 'visible' : 'hidden'}
          data-heading={press.value.heading ? 'visible' : 'hidden'}
          onPointerLeave={() => {
            lastPointer.current = null;
            activity.current!.hide();
          }}
          onPointerDownCapture={() => {
            press.hold();
            activity.current!.wake();
          }}
        >
          {poster && (
            <header
              className="player-heading player-chrome"
              aria-hidden={!press.value.heading || undefined}
            >
              <PlayerHeading subject={poster ?? null} siteOrigin={siteOrigin} />
            </header>
          )}
          {activeSource?.kind === 'live' && (
            <button
              className="player-mode-badge is-live"
              aria-label={tr('回到直播')}
              title={tr('回到直播')}
              onClick={() => {
                const edge = slots.current[current.current.active]?.liveEdge();
                const video = activeVideo();
                if (video && edge != null) {
                  video.currentTime = edge;
                  onFollowLive(true);
                }
              }}
            >
              <Icon name="camera" />
            </button>
          )}
          {activeSource?.kind === 'archive' && (
            <span
              className="player-mode-badge is-archive"
              role="img"
              aria-label={tr('录像')}
              title={tr('录像')}
            >
              <Icon name="hard-drive" />
            </span>
          )}
          {bank.sources.map(
            (item, index) =>
              item &&
              !stopped && (
                <MediaSlot
                  key={index}
                  ref={(slot) => {
                    slots.current[index] = slot;
                  }}
                  source={item}
                  active={index === bank.active}
                  muted={muted}
                  volume={volume}
                  bufferAheadSeconds={replacement.current === sourceKey(item) ? 0 : 2}
                  onProgress={(utc, mediaTime, unitId) => {
                    if (!ownsCursor(item)) return;
                    if (current.current.sources[index] !== item || current.current.active !== index)
                      return;
                    if (replacement.current) return;
                    callbacks.current.onCursor(utc, unitId);
                    prepare(mediaTime);
                  }}
                  onReady={() => {
                    if (current.current.sources[index] !== item) return;
                    readiness.current.add(sourceKey(item));
                    if (current.current.active === index) {
                      setReady(true);
                      setHasFrame(true);
                    } else if (waiting.current || replacement.current === sourceKey(item))
                      advance();
                  }}
                  onBuffering={() => {
                    if (current.current.sources[index] !== item) return;
                    readiness.current.delete(sourceKey(item));
                    if (current.current.active === index) setReady(false);
                  }}
                  onEnded={() => {
                    if (!ownsCursor(item)) return;
                    if (current.current.sources[index] !== item || current.current.active !== index)
                      return;
                    waiting.current = true;
                    const preparationError = slotErrors.current.get('preparation');
                    if (preparationError) setError(preparationError);
                    else
                      setPhase(
                        preparation.current.pending || current.current.sources[1 - index]
                          ? 'buffering'
                          : 'ended',
                      );
                    setReady(false);
                    advance();
                  }}
                  onPlaying={(next) => {
                    if (current.current.sources[index] === item && current.current.active === index)
                      setPlaying(next);
                  }}
                  onAudio={(nextMuted, nextVolume) => {
                    if (current.current.sources[index] !== item || current.current.active !== index)
                      return;
                    setMuted(nextMuted);
                    setVolume(nextVolume);
                  }}
                  onError={(message) => {
                    if (current.current.sources[index] !== item) return;
                    slotErrors.current.set(sourceKey(item), message);
                    if (
                      current.current.active === index ||
                      waiting.current ||
                      replacement.current === sourceKey(item)
                    )
                      setError(message);
                  }}
                  onRecovered={() => {
                    if (current.current.sources[index] !== item) return;
                    slotErrors.current.delete(sourceKey(item));
                    if (current.current.active === index) {
                      setError('');
                      setReady(true);
                      setHasFrame(true);
                    }
                  }}
                  onPhase={(next) => {
                    if (current.current.sources[index] === item && current.current.active === index)
                      setPhase(next);
                    else if (replacement.current === sourceKey(item)) setReplacementPhase(next);
                  }}
                />
              ),
          )}
          {poster && showPoster && (
            <div className="playback-poster" aria-hidden="true">
              <CoverImage
                id={poster.id}
                revision={0}
                status={displayStatus(poster)}
                priority="visible"
              />
            </div>
          )}
          {displayNotice && noticeStage !== 'hidden' && (
            <div
              className={`playback-status${presentFrame && !stopped ? ' playback-status--compact' : ''}${noticeStage === 'brief' ? ' playback-status--brief' : ''}${displayNotice.kind === 'error' ? ' form-error' : ''}`}
              data-kind={displayNotice.kind}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <PlaybackNoticeContent
                notice={displayNotice}
                brief={noticeStage === 'brief'}
                onRetry={
                  displayNotice.action === 'import-keys'
                    ? onImportKeys
                    : displayNotice.action === 'choose-cdn'
                      ? onChooseCdn
                      : phase === 'blocked'
                        ? () => void togglePlay()
                        : onRetry
                }
                retryLabel={
                  displayNotice.action === 'import-keys'
                    ? tr('导入密钥')
                    : displayNotice.action === 'choose-cdn'
                      ? tr('更换 CDN')
                      : phase === 'blocked'
                        ? tr('开始播放')
                        : tr('重新连接')
                }
              />
            </div>
          )}
          {!activeSource && !displayNotice && (
            <div
              className="playback-status"
              data-kind="idle"
              role="status"
              aria-label={tr('播放器待机')}
            >
              <PlaybackNoticeContent
                notice={{
                  kind: 'action',
                  title: tr('点击主播播放直播，或拖选时间段回放'),
                  detail: tr('选择主播即可观看直播，也可在时间线上拖选录像范围。'),
                }}
              />
            </div>
          )}
          <div className="player-bottom player-chrome" aria-hidden={!visible || undefined}>
            <div className="player-actions">
              {controlError && (
                <span className="player-control-feedback" role="status">
                  {controlError}
                </span>
              )}
              <button
                className="player-control player-control--primary"
                aria-label={playing ? tr('暂停播放') : tr('开始播放')}
                title={playing ? tr('暂停播放') : tr('开始播放')}
                disabled={busy || !!replacement.current || !activeSource || stopped}
                onClick={() => void togglePlay()}
              >
                <Icon name={playing ? 'pause' : 'play'} />
              </button>
              <div className="player-audio">
                <button
                  className="player-control"
                  aria-label={muted || volume === 0 ? tr('开启声音') : tr('静音')}
                  title={muted || volume === 0 ? tr('开启声音') : tr('静音')}
                  disabled={!activeSource}
                  onClick={() => {
                    const video = activeVideo();
                    if (video) {
                      if (video.muted || video.volume === 0) {
                        if (video.volume === 0) video.volume = 1;
                        video.muted = false;
                      } else video.muted = true;
                    }
                  }}
                >
                  <Icon name={muted || volume === 0 ? 'muted' : 'volume'} />
                </button>
              </div>
              {poster ? (
                <SelectionSummary range={range ?? null} />
              ) : (
                <span className="player-actions-spacer" />
              )}
              {tools}
              <button
                className="player-control fullscreen-button"
                aria-label={fullscreen ? tr('退出全屏') : tr('全屏播放')}
                title={fullscreen ? tr('退出全屏') : tr('全屏播放')}
                disabled={!document.fullscreenEnabled || (!fullscreen && !activeSource)}
                onClick={() => void toggleFullscreen()}
              >
                <Icon name={fullscreen ? 'collapse' : 'expand'} />
              </button>
            </div>
          </div>
        </div>
      </div>
      <div
        ref={review}
        id="player-media-review"
        className="media-review"
        aria-hidden={(fullscreen && reviewCollapsed) || undefined}
      >
        {timeline}
        {snapshots}
      </div>
      <button
        className="review-toggle"
        aria-controls="player-media-review"
        aria-expanded={!reviewCollapsed}
        aria-label={reviewCollapsed ? tr('展开截图面板') : tr('收起截图面板')}
        title={reviewCollapsed ? tr('展开截图面板') : tr('收起截图面板')}
        onClick={() => setReviewCollapsed(!reviewCollapsed)}
      >
        <Icon name={reviewCollapsed ? 'chevron-left' : 'chevron-right'} />
      </button>
    </section>
  );
});
