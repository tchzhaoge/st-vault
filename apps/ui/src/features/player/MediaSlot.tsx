import { tr } from '../../shared/lib/i18n';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type Hls from 'hls.js';
import type { PlayerSource } from './Player';
import { request, ApiError } from '../../shared/lib/api';
import { loadPlayerEngine } from './player-engine';
import { archiveMediaEnd } from './playback-continuation';
import type { MediaPhase } from './player-status';
import { LiveClock } from './live-clock';
import { createMediaTimeIndex, playbackEndUtc, utcToMediaTime } from '../timeline/timeline';

export function sourceKey(source: PlayerSource): string {
  return `${source.kind}:${source.kind === 'live' ? source.stream.sessionId : `${source.playback.sessionId}:${source.unitId ?? ''}`}`;
}
export function closeSource(source: PlayerSource, keepalive = false): Promise<void> {
  return request<void>(
    source.kind === 'live'
      ? `/api/live/${encodeURIComponent(source.stream.sessionId)}`
      : `/api/playback/${encodeURIComponent(source.playback.sessionId)}/close`,
    { method: source.kind === 'live' ? 'DELETE' : 'POST', keepalive, operation: 'session' },
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  });
}
export interface MediaSlotHandle {
  video: HTMLVideoElement | null;
  play: () => Promise<void>;
  seek: (utc: number, unitId?: string) => boolean;
  liveEdge: () => number | null;
  suspend?: () => void;
}
interface Props {
  source: PlayerSource;
  active: boolean;
  muted: boolean;
  volume: number;
  bufferAheadSeconds?: number;
  onProgress: (utc: number, mediaTime: number, unitId?: string) => void;
  onReady: () => void;
  onBuffering: () => void;
  onEnded: () => void;
  onPlaying: (playing: boolean) => void;
  onAudio: (muted: boolean, volume: number) => void;
  onError: (message: string) => void;
  onRecovered: () => void;
  onPhase?: (phase: MediaPhase) => void;
}

// Delaying release one task lets React StrictMode cancel its simulated teardown.
const releases = new Map<string, ReturnType<typeof setTimeout>>();
export const MediaSlot = forwardRef<MediaSlotHandle, Props>(function MediaSlot(props, ref) {
  const { source, active, muted, volume } = props;
  const videoRef = useRef<HTMLVideoElement>(null),
    engine = useRef<Hls | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const seek = useRef<(utc: number, unitId?: string) => boolean>(() => false);
  const start = useRef<() => Promise<void>>(() => Promise.resolve());
  useImperativeHandle(
    ref,
    () => ({
      get video() {
        return videoRef.current;
      },
      play: () => start.current(),
      seek: (utc, unitId) => seek.current(utc, unitId),
      liveEdge: () => engine.current?.liveSyncPosition ?? null,
      suspend: () => {
        videoRef.current?.pause();
        engine.current?.stopLoad();
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = active ? muted : true;
    video.volume = volume;
    if (!active) {
      video.pause();
    } else if (video.readyState >= 2) void start.current();
  }, [active]);
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = active ? muted : true;
      video.volume = volume;
    }
  }, [active, muted, volume]);
  useEffect(() => {
    const video = videoRef.current!;
    const key = sourceKey(source),
      previousRelease = releases.get(key);
    if (previousRelease !== undefined) clearTimeout(previousRelease);
    releases.delete(key);
    const manifestUrl =
      source.kind === 'live' ? source.stream.manifestUrl : source.playback.manifestUrl;
    const mediaEnd = source.kind === 'archive' ? archiveMediaEnd(source.playback) : Infinity;
    let cancelled = false,
      hls: Hls | null = null,
      positioned = false,
      resumeOnMetadata = true,
      reportedReady = false,
      awaitingSeek = false,
      ended = false;
    let failureShown = false,
      terminalFailure = '',
      healthyMediaTime: number | null = null,
      healthyClock = -Infinity;
    let networkRecoveries = 0,
      mediaRecoveries = 0,
      recoveryMediaTime = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const recover = (kind: 'network' | 'media'): boolean => {
      if (!isCurrent() || source.kind !== 'live' || !hls) return false;
      if (recoveryTimer !== undefined) return true;
      if (kind === 'network' ? networkRecoveries >= 2 : mediaRecoveries >= 1) return false;
      const attempt = kind === 'network' ? ++networkRecoveries : ++mediaRecoveries;
      terminalFailure = '';
      callbacks.current.onPhase?.(kind === 'network' ? 'network' : 'decoder');
      recoveryMediaTime = video.currentTime;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (!isCurrent() || !hls) return;
        if (kind === 'network') hls.startLoad(-1);
        else {
          resumeOnMetadata = !video.paused;
          positioned = false;
          reportedReady = false;
          hls.recoverMediaError();
        }
      }, 500 * attempt);
      return true;
    };
    let frame = 0,
      lastRender = -Infinity;
    const isCurrent = (): boolean => !cancelled && callbacks.current.source === source;
    const fail = (message: string): void => {
      if (isCurrent()) {
        failureShown = true;
        callbacks.current.onError(message);
      }
    };
    start.current = async () => {
      if (!isCurrent() || !callbacks.current.active) return;
      try {
        await video.play();
      } catch (error: unknown) {
        // pause(), load(), and source teardown intentionally cancel pending play().
        if (
          !isCurrent() ||
          !callbacks.current.active ||
          (error instanceof Error && error.name === 'AbortError')
        )
          return;
        callbacks.current.onPhase?.(
          error instanceof Error && error.name === 'NotAllowedError' ? 'blocked' : 'decoding',
        );
        fail(
          error instanceof Error && error.name === 'NotAllowedError'
            ? tr('浏览器阻止了自动播放，请点击播放。')
            : tr('浏览器未能启动视频播放，请点击播放重试。'),
        );
      }
    };
    const liveClock = new LiveClock();
    const archivePosition =
      source.kind === 'archive' ? createMediaTimeIndex(source.playback.segments) : null;
    const observeClock = (): LiveClock => {
      liveClock.observe(
        hls?.latestLevelDetails?.fragments ?? [],
        video.seekable.length ? video.seekable.start(0) : -Infinity,
      );
      return liveClock;
    };
    const utc = (): number | null =>
      source.kind === 'live'
        ? observeClock().toUtc(video.currentTime)
        : (archivePosition!(video.currentTime)?.atMs ?? null);
    const publishProgress = (at: number, media: number, unitId?: string): void => {
      if (unitId) callbacks.current.onProgress(at, media, unitId);
      else callbacks.current.onProgress(at, media);
    };
    const reset = (): void => {
      healthyMediaTime = null;
      healthyClock = -Infinity;
    };
    const finish = (): void => {
      if (!isCurrent() || ended || !callbacks.current.active) return;
      ended = true;
      if (source.kind === 'archive') {
        const end = playbackEndUtc(source.playback.segments);
        if (end !== null)
          publishProgress(
            Math.min(end, source.playback.rangeToMs ?? end),
            mediaEnd,
            source.playback.segments.at(-1)?.recordingUnitId,
          );
      }
      video.pause();
      reset();
      callbacks.current.onEnded();
    };
    const checkReady = (): void => {
      if (!isCurrent() || reportedReady || !positioned || video.seeking) return;
      if (video.readyState < 2) return;
      const target =
        source.kind === 'archive'
          ? Math.min(
              mediaEnd,
              video.currentTime +
                (callbacks.current.active ? 0 : (callbacks.current.bufferAheadSeconds ?? 2)),
            )
          : video.currentTime;
      if (
        !Array.from({ length: video.buffered.length }, (_, index) => index).some(
          (index) =>
            video.buffered.start(index) <= video.currentTime + 0.05 &&
            video.buffered.end(index) >= target - 0.05,
        )
      )
        return;
      reportedReady = true;
      callbacks.current.onReady();
    };
    const progress = (): void => {
      if (!isCurrent()) return;
      checkReady();
      // Loading/seeking events can still carry the previous decoded position.
      if (!positioned || video.seeking || awaitingSeek) return;
      const position = archivePosition?.(video.currentTime),
        actual = archivePosition ? (position?.atMs ?? null) : utc(),
        clock = performance.now();
      const healthy =
        callbacks.current.active &&
        !video.paused &&
        !video.seeking &&
        video.readyState >= 2 &&
        !video.error;
      if (healthy && healthyMediaTime !== null && video.currentTime > healthyMediaTime) {
        healthyClock = clock;
        // Renew the recovery budget only after ten seconds of actual media progress.
        if (video.currentTime - recoveryMediaTime >= 10) {
          networkRecoveries = 0;
          mediaRecoveries = 0;
        }
        if (failureShown) {
          failureShown = false;
          callbacks.current.onRecovered();
        }
      }
      healthyMediaTime = healthy ? video.currentTime : null;
      if (!callbacks.current.active) {
        return;
      }
      const at =
        actual === null
          ? null
          : source.kind === 'archive' && source.playback.rangeToMs !== undefined
            ? Math.min(
                source.playback.rangeToMs,
                Math.max(source.playback.rangeFromMs ?? actual, actual),
              )
            : actual;
      if (at !== null && Number.isFinite(at)) {
        if (clock - lastRender >= 100) {
          publishProgress(at, video.currentTime, position?.unitId);
          lastRender = clock;
        }
      }
      if (source.kind === 'archive' && video.currentTime >= mediaEnd) finish();
    };
    const animate = (): void => {
      if (!isCurrent()) return;
      if (!video.paused && document.visibilityState === 'visible') progress();
      frame = requestAnimationFrame(animate);
    };
    const loaded = (): void => {
      if (!isCurrent() || positioned) return;
      positioned = true;
      awaitingSeek = false;
      callbacks.current.onPhase?.('decoding');
      if (source.kind === 'archive') {
        const target = Math.max(0, source.playback.seekOffsetSeconds);
        if (video.currentTime !== target) {
          awaitingSeek = true;
          video.currentTime = target;
        }
      }
      if (callbacks.current.active && resumeOnMetadata) void start.current();
    };
    const seeking = (): void => {
      awaitingSeek = true;
      ended = false;
      reset();
    };
    const seeked = (): void => {
      if (video.seeking) return;
      awaitingSeek = false;
      lastRender = -Infinity;
      progress();
    };
    const buffering = (): void => {
      if (!isCurrent()) return;
      reset();
      reportedReady = false;
      callbacks.current.onBuffering();
      callbacks.current.onPhase?.(recoveryTimer !== undefined ? 'network' : 'buffering');
      // A fatal HLS error stops loading, but buffered frames can still play.
      // Keep its cause until depletion rather than leaving an endless spinner.
      if (terminalFailure) fail(terminalFailure);
    };
    const nativeError = (): void => {
      if (!video.error || video.error.code === 1) return;
      if (video.error.code === 2 && recover('network')) return;
      if (video.error.code === 3 && recover('media')) return;
      fail(
        video.error.code === 2
          ? tr('播放分片请求失败，自动重连未能恢复连接。')
          : video.error.code === 3
            ? tr('视频解码失败，解码器恢复未能完成。')
            : tr('当前视频格式或编码不受浏览器支持。'),
      );
    };
    seek.current = (target, unitId) => {
      if (!positioned) return false;
      if (unitId && source.kind === 'live') return false;
      if (
        source.kind === 'archive' &&
        source.playback.rangeFromMs !== undefined &&
        (target < source.playback.rangeFromMs || target >= source.playback.rangeToMs!)
      )
        return false;
      const media =
        source.kind === 'archive'
          ? utcToMediaTime(source.playback.segments, target, unitId)
          : observeClock().toMedia(target);
      if (media === null || !Number.isFinite(media)) return false;
      if (
        source.kind === 'live' &&
        !Array.from({ length: video.seekable.length }, (_, index) => index).some(
          (index) => media >= video.seekable.start(index) && media < video.seekable.end(index),
        )
      )
        return false;
      reset();
      ended = false;
      if (video.currentTime !== media) {
        awaitingSeek = true;
        video.currentTime = media;
      }
      publishProgress(
        target,
        media,
        source.kind === 'archive' ? archivePosition!(media)?.unitId : undefined,
      );
      return true;
    };
    const listeners: [string, () => void][] = [
      ['loadedmetadata', loaded],
      ['loadeddata', checkReady],
      ['canplay', checkReady],
      ['progress', checkReady],
      ['seeked', seeked],
      ['timeupdate', progress],
      ['ended', finish],
      ['pause', reset],
      ['waiting', buffering],
      ['seeking', seeking],
      ['error', nativeError],
    ];
    for (const [name, listener] of listeners) video.addEventListener(name, listener);
    document.addEventListener('visibilitychange', reset);
    const leaving = (): void => {
      reset();
      void closeSource(source, true).catch((error) =>
        console.warn('Page playback release failed', error),
      );
    };
    window.addEventListener('pagehide', leaving);
    frame = requestAnimationFrame(animate);
    callbacks.current.onPhase?.('engine');
    void loadPlayerEngine()
      .then(({ default: Engine }) => {
        if (!isCurrent()) return;
        if (Engine.isSupported()) {
          hls = new Engine({
            startFragPrefetch: source.kind === 'archive',
            startPosition: source.kind === 'archive' ? source.playback.seekOffsetSeconds : -1,
            maxBufferLength: source.kind === 'live' ? 12 : 20,
            maxMaxBufferLength: 30,
            backBufferLength: 30,
            lowLatencyMode: source.kind === 'live',
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 8,
            maxLiveSyncPlaybackRate: 1.05,
          });
          engine.current = hls;
          hls.on(Engine.Events.ERROR, (_event, data) => {
            if (!isCurrent() || !data.fatal) return;
            if (data.type === Engine.ErrorTypes.NETWORK_ERROR && recover('network')) return;
            if (data.type === Engine.ErrorTypes.MEDIA_ERROR && recover('media')) return;
            terminalFailure =
              data.type === Engine.ErrorTypes.NETWORK_ERROR
                ? tr('播放分片请求失败，自动重连未能恢复连接。')
                : data.type === Engine.ErrorTypes.MEDIA_ERROR
                  ? tr('视频解码失败，解码器恢复未能完成。')
                  : tr('播放引擎无法继续处理当前媒体，请重新连接。');
            if (
              !callbacks.current.active ||
              video.paused ||
              video.readyState < 2 ||
              performance.now() - healthyClock > 1000
            )
              fail(terminalFailure);
          });
          hls.attachMedia(video);
          callbacks.current.onPhase?.('manifest');
          hls.loadSource(manifestUrl);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          callbacks.current.onPhase?.('manifest');
          video.src = manifestUrl;
        } else fail(tr('此浏览器不支持 HLS 播放。'));
      })
      .catch(() => fail(tr('播放器模块加载失败。')));
    return () => {
      reset();
      cancelled = true;
      clearTimeout(recoveryTimer);
      cancelAnimationFrame(frame);
      seek.current = () => false;
      start.current = () => Promise.resolve();
      engine.current = null;
      for (const [name, listener] of listeners) video.removeEventListener(name, listener);
      document.removeEventListener('visibilitychange', reset);
      window.removeEventListener('pagehide', leaving);
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
      releases.set(
        key,
        setTimeout(() => {
          releases.delete(key);
          void closeSource(source).catch((error) =>
            console.warn('Playback session release failed', error),
          );
        }, 0),
      );
    };
  }, [source]);
  return (
    <video
      ref={videoRef}
      playsInline
      preload="auto"
      muted={active ? muted : true}
      tabIndex={-1}
      aria-hidden={!active}
      data-media-slot={active ? 'active' : 'prepared'}
      style={{
        position: 'absolute',
        inset: 0,
        visibility: active ? 'visible' : 'hidden',
      }}
      onPlay={() => {
        if (callbacks.current.active) callbacks.current.onPlaying(true);
      }}
      onPause={() => {
        if (callbacks.current.active) callbacks.current.onPlaying(false);
      }}
      onVolumeChange={(event) => {
        if (callbacks.current.active)
          callbacks.current.onAudio(event.currentTarget.muted, event.currentTarget.volume);
      }}
    />
  );
});
