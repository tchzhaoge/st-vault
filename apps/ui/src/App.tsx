import type {
  EventMeta,
  LivePlaybackResponse,
  LiveProgress,
  MediaDeletionJob,
  PlaybackResponse,
  RecordingBoundsResponse,
  SessionInfo,
  SnapshotSession,
  Subject,
} from '@st-vault/api-schema';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { calendarSpan, setTimeZone } from './shared/lib/time';
import { Icon } from './design/Icon';
import { AccountTools } from './features/account/AccountTools';
import { AuthGate } from './features/auth/AuthGate';
import { DirectoryControls } from './features/directory/DirectoryControls';
import { GlobalRecordingSettings } from './features/directory/RecordingMode';
import {
  reconcileSubjects,
  subjectCounts,
  subjectGroup,
  visibleSubjects,
} from './features/directory/subjects';
import { HistoryPanel } from './features/history/HistoryPanel';
import { KeyTools, type KeyInfo } from './features/keys/KeyTools';
import { RoutingOptions } from './features/network/RoutingOptions';
import { FocusTimeline } from './features/player/FocusTimeline';
import { useDeletionProjections, clearDeletionProjections } from './shared/lib/deletion-projection';
import { Player, type PlayerHandle, type PlayerSource } from './features/player/Player';
import { closeSource } from './features/player/MediaSlot';
import { PlaybackCoordinator } from './features/player/playback-coordinator';
import { archiveRange, archiveRequest } from './features/player/archive-request';
import { RowConnection } from './features/player/RowConnection';
import { RowAnchorStore } from './features/player/row-anchor';
import { loadPlayerEngine } from './features/player/player-engine';
import { requestNotice, type PlaybackNotice } from './features/player/player-status';
import { playbackWindow, REPLAY_SPAN_MS, replayWindow } from './features/player/replay-window';
import { SnapshotGrid } from './features/snapshots/SnapshotGrid';
import {
  deletionAffectsPlayback,
  type MediaDeletionEvent,
} from './features/snapshots/media-deletion';
import { systemHealthStatus } from './features/status/display';
import { TrackBoard } from './features/timeline/TrackBoard';
import {
  calendarWindow,
  DEFAULT_RANGE_MS,
  moveWindow,
  restoreViewWindow,
  type ViewWindow,
} from './features/timeline/range-control';
import {
  clearPreferences,
  preferenceKey,
  readPreferences,
  writePreferences,
} from './features/timeline/view-preferences';
import { ApiError, request } from './shared/lib/api';
import { messageFor } from './shared/lib/errors';
import { tr } from './shared/lib/i18n';
import { coverImages, snapshotImages } from './shared/lib/image-loader';
import {
  useDisplayClock,
  usePageSync,
  useSyncClock,
  useSyncRefresh,
  syncReadFailure,
  type SyncReadResult,
} from './shared/lib/sync';
import {
  readWorkspace,
  writeWorkspace,
  type ListPosition,
  type WorkspaceState,
} from './shared/lib/workspace-state';
import { BrandName } from './shared/ui/BrandName';
import { PanelFeedback } from './shared/ui/PanelContent';
import { ProgressRing } from './shared/ui/ProgressRing';
import { ToolPopover } from './shared/ui/ToolPopover';

import { HeaderTools, type Tool } from './app/HeaderTools';
import { RuntimeSettingsForm } from './features/settings/RuntimeSettingsForm';
import { backgroundTaskAlert } from './features/status/BackgroundTasks';
import { SystemSummary } from './features/status/SystemSummary';
import { PlaybackClock } from './features/player/playback-clock';
import { mediaTimePosition } from './features/timeline/timeline';
import type { SystemInfo } from './features/status/system';

export default function App(): JSX.Element {
  useTranslation();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [tool, setTool] = useState<Tool | null>(null);
  const [eventMeta, setEventMeta] = useState<EventMeta | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const subjectsVersion = useRef(0);
  const systemVersion = useRef(0);
  const [directoryStatus, setDirectoryStatus] = useState('ONLINE');
  const [revealSubject, setRevealSubject] = useState<{ id: string; token: number } | null>(null);
  const counts = useMemo(() => subjectCounts(subjects), [subjects]);
  const filtered = useMemo(
    () => visibleSubjects(subjects, directoryStatus),
    [subjects, directoryStatus],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selected = subjects.find((subject) => subject.id === selectedId) ?? null;
  const [view, setView] = useState<ViewWindow>(() => calendarWindow(Date.now(), DEFAULT_RANGE_MS));
  const [targetMs, setNavigationTarget] = useState<number | null>(null);
  const playbackClockRef = useRef<PlaybackClock | null>(null);
  playbackClockRef.current ??= new PlaybackClock();
  const playbackClock = playbackClockRef.current;
  const explicitUnitId = useRef<string | undefined>(undefined);
  const setTargetMs = (at: number | null, unitId?: string): void => {
    explicitUnitId.current = unitId;
    playbackClock.set(at, unitId);
    setNavigationTarget(at);
  };
  const [playbackNavigation, setPlaybackNavigation] = useState<{ id: number; atMs: number | null }>(
    {
      id: 0,
      atMs: null,
    },
  );
  const player = useRef<PlayerHandle>(null);
  const playbackKind = useRef<'live' | 'archive'>('live');
  const coordinatorRef = useRef<PlaybackCoordinator<PlayerSource> | null>(null);
  coordinatorRef.current ??= new PlaybackCoordinator(closeSource);
  const coordinator = coordinatorRef.current;
  const [preferencesReady, setPreferencesReady] = useState<string | null>(null);
  const [requestedSpan, setRequestedSpan] = useState(DEFAULT_RANGE_MS);
  const [nowMs, setNowMs] = useState(Date.now);
  const [dataNowMs, setDataNowMs] = useState(Date.now);
  const timelineStartFallback = useRef(nowMs);
  const timelineStartMs = session?.timelineStartMs ?? timelineStartFallback.current;
  const [selectionEndMs, setSelectionEndMs] = useState<number | null>(null);
  const [selectionDurationMs, setSelectionDurationMs] = useState(REPLAY_SPAN_MS);
  const hasSelection = selectionEndMs !== null;
  const [broadcast, setBroadcast] = useState<{
    id: string;
    session: SnapshotSession | null;
    window: ViewWindow;
  } | null>(null);
  const broadcastRef = useRef(broadcast);
  broadcastRef.current = broadcast;
  const [snapshotReference, setSnapshotReference] = useState(Date.now);
  const snapshotBoundary = useRef('');
  const { selection, requestedSelection, dataWindow } = useMemo(() => {
    const windowAt = (at: number): ViewWindow => {
      if (selectionEndMs !== null)
        // Resolved unit bounds are fixed media coordinates, not a rolling
        // wall-clock window. An open unit can extend beyond the last UI tick;
        // clamping only its end would incorrectly move the left edge backward.
        return { fromMs: selectionEndMs - selectionDurationMs, toMs: selectionEndMs };
      return replayWindow(at, timelineStartMs, at);
    };
    const requestedSelection = windowAt(nowMs);
    const selection = { ...requestedSelection };
    const anchor = broadcast?.id === selectedId ? broadcast.window.fromMs : undefined;
    if (selectionEndMs === null && anchor !== undefined && anchor < selection.toMs)
      selection.fromMs = anchor;
    return {
      selection,
      requestedSelection,
      dataWindow: selectionEndMs === null ? windowAt(dataNowMs) : requestedSelection,
    };
  }, [
    selectionEndMs,
    timelineStartMs,
    nowMs,
    dataNowMs,
    selectionDurationMs,
    broadcast,
    selectedId,
  ]);
  const selectionRef = useRef(selection);
  const snapshotWindow = dataWindow;
  selectionRef.current = selection;
  const onSnapshotSession = useCallback(
    (id: string, value: SnapshotSession | null, window: ViewWindow) => {
      if (selectedIdRef.current === id) {
        setBroadcast((current) =>
          current?.id === id &&
          current.session === value &&
          current.window.fromMs === window.fromMs &&
          current.window.toMs === window.toMs
            ? current
            : { id, session: value, window },
        );
      }
    },
    [],
  );
  useEffect(() => {
    const end = broadcast?.id === selectedId ? broadcast.session?.selectionToMs : undefined;
    if (selectionEndMs !== null && end !== undefined && end > selectionEndMs) {
      setSelectionDurationMs((duration) => duration + end - selectionEndMs);
      setSelectionEndMs(end);
    }
  }, [broadcast, selectedId, selectionEndMs]);
  const updateSnapshotReference = (id: string, at: number): void => {
    const current = broadcastRef.current;
    if (
      current?.id !== id ||
      !current.session ||
      at < current.session.fromMs ||
      (current.session.ended && at >= current.session.toMs)
    )
      setSnapshotReference(Math.round(at));
  };
  useEffect(() => {
    const active = broadcast?.id === selectedId ? broadcast.session : null;
    if (selectionEndMs === null || !active || targetMs === null) return;
    if (targetMs >= active.fromMs && (!active.ended || targetMs < active.toMs)) {
      snapshotBoundary.current = '';
      return;
    }
    const key = `${selectedId}:${active.fromMs}:${active.toMs}`;
    if (snapshotBoundary.current !== key) {
      snapshotBoundary.current = key;
      setSnapshotReference(Math.round(targetMs));
    }
  }, [broadcast, selectedId, targetMs, selectionEndMs]);
  const workspace = useRef<HTMLDivElement>(null),
    viewer = useRef<HTMLElement>(null);
  const [anchor] = useState(() => new RowAnchorStore());
  const [source, setSource] = useState<PlayerSource | null>(null);
  const [serverDeletionJobs, setDeletionJobs] = useState<MediaDeletionJob[]>([]);
  const deletionProjections = useDeletionProjections();
  const deletionJobs = [
    ...serverDeletionJobs,
    ...deletionProjections
      .map((entry) => entry.job)
      .filter((job) => !serverDeletionJobs.some((server) => server.id === job.id)),
  ];
  useEffect(() => {
    if (!session?.authenticated) {
      setDeletionJobs([]);
      clearDeletionProjections();
    }
  }, [session?.authenticated]);
  const [playBusy, setPlayBusy] = useState(false);
  const [playerNotice, setPlayerNotice] = useState<PlaybackNotice | null>(null);
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  useSyncRefresh(
    ['playback'],
    async (signal) => {
      if (!selectedId) return;
      const version = coordinator.stamp();
      const progress = await request<LiveProgress | null>(
        `/api/subjects/${encodeURIComponent(selectedId)}/live-progress`,
        { signal },
      );
      if (!signal.aborted && progress && version === coordinator.stamp()) setLiveProgress(progress);
    },
    session?.authenticated === true &&
      !!selectedId &&
      (playBusy || source?.kind === 'live') &&
      playbackKind.current === 'live',
    selectedId ?? '',
  );
  const [error, setError] = useState('');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState('');
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const keyBusy = keySaving;
  const subjectsRequest = useRef<Promise<SyncReadResult> | null>(null);
  const storageKey = preferenceKey(session);
  const [subjectsLoaded, setSubjectsLoaded] = useState(false);
  const [restorePosition, setRestorePosition] = useState<ListPosition | null>(null);
  const workspaceState = useRef<WorkspaceState>({ list: null, playback: null });
  const workspaceRestored = useRef(false);
  const pendingWorkspace = useRef<WorkspaceState | null>(null);
  useEffect(() => {
    if (!storageKey) {
      setPreferencesReady(null);
      return;
    }
    const saved = readPreferences(storageKey),
      now = Date.now();
    pendingWorkspace.current = readWorkspace(storageKey);
    workspaceRestored.current = false;
    workspaceState.current = pendingWorkspace.current;
    setRestorePosition(pendingWorkspace.current.list);
    setDirectoryStatus(saved.filter);
    setRequestedSpan(saved.durationMs);
    setView(restoreViewWindow(saved.viewToMs, saved.durationMs, now, timelineStartMs));
    setPreferencesReady(storageKey);
  }, [storageKey, timelineStartMs]);
  useEffect(() => {
    if (
      !storageKey ||
      preferencesReady !== storageKey ||
      !subjectsLoaded ||
      workspaceRestored.current
    )
      return;
    workspaceRestored.current = true;
    const saved = pendingWorkspace.current?.playback;
    const subject = subjects.find((row) => row.id === saved?.subjectId);
    if (!saved || !subject) return;
    if (saved.view === 'selection') {
      setSelectionEndMs(saved.range.toMs);
      setSelectionDurationMs(saved.range.toMs - saved.range.fromMs);
    }
    void open(subject, saved.kind === 'archive' ? saved.atMs! : undefined, saved.range, {
      restoring: true,
      intent: saved.view === 'selection' ? 'select' : 'seek',
      unitId: saved.explicitUnitId,
    });
  }, [storageKey, preferencesReady, subjectsLoaded, subjects]);
  if (workspaceRestored.current)
    workspaceState.current.playback = selectedId
      ? {
          subjectId: selectedId,
          kind: playbackKind.current,
          atMs: playbackClock.snapshot() === null ? null : Math.round(playbackClock.snapshot()!),
          range: selection,
          view: hasSelection ? 'selection' : 'following',
          explicitUnitId: explicitUnitId.current,
        }
      : null;
  useEffect(() => {
    if (!storageKey) return;
    const save = (): void => {
      if (!workspaceRestored.current) return;
      writeWorkspace(storageKey, workspaceState.current);
      writePreferences(storageKey, {
        filter: directoryStatus,
        durationMs: requestedSpan,
        viewToMs: storedViewTo,
      });
    };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [storageKey, directoryStatus, requestedSpan, view.toMs]);
  const storedViewTo = view.toMs;
  useEffect(() => {
    if (!storageKey || preferencesReady !== storageKey) return;
    const timer = window.setTimeout(
      () =>
        writePreferences(storageKey, {
          filter: directoryStatus,
          durationMs: requestedSpan,
          viewToMs: storedViewTo,
        }),
      200,
    );
    return () => window.clearTimeout(timer);
  }, [storageKey, preferencesReady, directoryStatus, requestedSpan, storedViewTo]);

  usePageSync(session?.authenticated === true, system?.settings?.pollMs ?? 5000);
  useDisplayClock((at) => setNowMs(at), session?.authenticated === true);
  useSyncClock((at) => setDataNowMs(at), session?.authenticated === true);
  useEffect(() => {
    // Restoration installs span and position together. Do not normalize that
    // window using the default span from the render that started restoration.
    if (!storageKey || preferencesReady !== storageKey) return;
    setView((current) => {
      const next = calendarWindow(current.fromMs, requestedSpan, timelineStartMs, nowMs);
      return next.fromMs === current.fromMs && next.toMs === current.toMs ? current : next;
    });
  }, [nowMs, timelineStartMs, requestedSpan, storageKey, preferencesReady]);
  const invalidatePlayback = useCallback((keepSource = false) => {
    coordinator.invalidate();
    if (!keepSource) setSource(null);
    setPlayBusy(false);
    setPlayerNotice(null);
    setLiveProgress(null);
  }, []);
  const closePlayer = useCallback(() => {
    if (document.fullscreenElement)
      void document
        .exitFullscreen()
        .catch((cause) => console.warn('Player fullscreen exit failed', cause));
    // Revoke media ownership before React commits the disconnected view.
    selectedIdRef.current = null;
    player.current?.stop();
    invalidatePlayback();
    setSelectedId(null);
    setTargetMs(null);
    setSelectionEndMs(null);
    setBroadcast(null);
  }, [invalidatePlayback]);
  const handleUnauthorized = useCallback(() => {
    coverImages.clear();
    snapshotImages.clear();
    clearPreferences(preferenceKey(session));
    if (storageKey) writeWorkspace(storageKey, null);
    workspaceRestored.current = false;
    closePlayer();
    setSession({ authenticated: false, setupRequired: false });
  }, [closePlayer, session]);
  useEffect(() => {
    const cleared = (event: StorageEvent): void => {
      if (storageKey && event.key === storageKey && event.newValue === null) handleUnauthorized();
    };
    window.addEventListener('storage', cleared);
    return () => window.removeEventListener('storage', cleared);
  }, [storageKey, handleUnauthorized]);
  useEffect(() => {
    const controller = new AbortController();
    void request<SessionInfo>('/api/session', { signal: controller.signal })
      .then((next) => {
        setTimeZone(next.timeZone ?? 'Asia/Shanghai');
        setSession(next);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setSessionError(messageFor(cause));
      });
    return () => {
      controller.abort();
      coordinator.invalidate();
    };
  }, []);
  const loadSubjects = useCallback(
    async (force = false, signal?: AbortSignal): Promise<SyncReadResult> => {
      if (subjectsRequest.current) {
        const previous = await subjectsRequest.current;
        if (force) return loadSubjects(true);
        return previous;
      }
      const running = (async (): Promise<SyncReadResult> => {
        const version = subjectsVersion.current;
        try {
          const data = await request<Subject[]>('/api/subjects', { signal });
          if (signal?.aborted || version !== subjectsVersion.current) return;
          setSubjects((current) => reconcileSubjects(current, data));
          setSubjectsLoaded(true);
          setError('');
          if (
            selectedIdRef.current &&
            !data.some((subject) => subject.id === selectedIdRef.current)
          ) {
            closePlayer();
          }
        } catch (cause) {
          const result = syncReadFailure(cause, signal);
          if (signal?.aborted && result.status !== 'retry') return result;
          if (cause instanceof ApiError && cause.status === 401) handleUnauthorized();
          else setError(tr('主播清单读取失败：{{v0}}', { v0: messageFor(cause) }));
          return result;
        }
      })();
      subjectsRequest.current = running;
      const result = await running;
      if (subjectsRequest.current === running) subjectsRequest.current = null;
      return result;
    },
    [handleUnauthorized, closePlayer],
  );
  const loadSystem = useCallback(
    async (signal?: AbortSignal): Promise<SyncReadResult> => {
      const version = systemVersion.current;
      try {
        const value = await request<SystemInfo>('/api/system', { signal });
        if (signal?.aborted || version !== systemVersion.current) return;
        setSystem(value);
        setSystemError('');
      } catch (cause) {
        const result = syncReadFailure(cause, signal);
        if (signal?.aborted && result.status !== 'retry') return result;
        if (cause instanceof ApiError && cause.status === 401) handleUnauthorized();
        else setSystemError(messageFor(cause));
        return result;
      }
    },
    [handleUnauthorized],
  );
  const loadKeys = useCallback(
    async (signal?: AbortSignal): Promise<SyncReadResult> => {
      try {
        const value = await request<KeyInfo>('/api/keys', { signal });
        setKeyInfo(value);
      } catch (cause) {
        const result = syncReadFailure(cause, signal);
        if (signal?.aborted && result.status !== 'retry') return result;
        if (cause instanceof ApiError && cause.status === 401) handleUnauthorized();
        return result;
      }
    },
    [handleUnauthorized],
  );
  useSyncRefresh(
    ['subjects'],
    (signal) => loadSubjects(false, signal),
    session?.authenticated === true,
  );
  useSyncRefresh(['keys'], loadKeys, session?.authenticated === true);
  useSyncRefresh(['system'], loadSystem, session?.authenticated === true, '', true);
  useSyncRefresh(
    ['events'],
    async (signal) => {
      setEventMeta(await request<EventMeta>('/api/events/meta', { signal }));
    },
    session?.authenticated === true && tool !== 'history',
  );
  async function setGlobalRecording(enabled: boolean): Promise<void> {
    systemVersion.current++;
    subjectsVersion.current++;
    try {
      await request('/api/subjects/recording-default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      setSystem((current) => (current ? { ...current, recordAll: enabled } : current));
      setSubjects((rows) =>
        rows.map((row) =>
          row.archived ? row : { ...row, autoRecord: enabled, monitorEnabled: true },
        ),
      );
    } finally {
      systemVersion.current++;
      subjectsVersion.current++;
      void loadSystem();
      void loadSubjects(true).catch((cause: unknown) => setError(messageFor(cause)));
    }
  }
  async function setRecording(id: string, record: boolean): Promise<void> {
    subjectsVersion.current++;
    try {
      const updated = await request<Subject>(`/api/subjects/${encodeURIComponent(id)}/policy`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoRecord: record, monitorEnabled: true }),
      });
      setSubjects((rows) => rows.map((row) => (row.id === id ? updated : row)));
    } finally {
      subjectsVersion.current++;
      void loadSubjects(true).catch((cause: unknown) => setError(messageFor(cause)));
    }
  }
  function resize(next: ViewWindow): void {
    const duration = calendarSpan(next.fromMs, next.toMs);
    setRequestedSpan(duration);
    setView(calendarWindow(next.fromMs, duration, timelineStartMs));
  }
  function move(direction: -1 | 1): void {
    setView((current) =>
      moveWindow(current, direction, timelineStartMs, Date.now(), requestedSpan),
    );
  }
  function applyRange(next: ViewWindow): void {
    setSelectionEndMs(next.toMs);
    setSelectionDurationMs(next.toMs - next.fromMs);
    selectionRef.current = next;
    if (next.toMs <= view.fromMs || next.fromMs >= view.toMs)
      setView(calendarWindow(next.fromMs, requestedSpan, timelineStartMs));
  }
  async function selectRange(
    subject: Subject,
    next: ViewWindow,
    signal?: AbortSignal,
  ): Promise<ViewWindow | null> {
    const controller = coordinator.begin('range');
    const cancel = (): void => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const value = await request<RecordingBoundsResponse>(
        `/api/subjects/${encodeURIComponent(subject.id)}/recording-bounds?from=${Math.round(next.fromMs)}&to=${Math.round(next.toMs)}`,
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        !coordinator.owns('range', controller) ||
        value.fromMs === null ||
        value.toMs === null
      )
        return null;
      const range = { fromMs: value.fromMs, toMs: value.toMs };
      coordinator.settled('range', controller);
      applyRange(range);
      void open(subject, range.fromMs, range, { intent: 'select' });
      return range;
    } finally {
      signal?.removeEventListener('abort', cancel);
      coordinator.settled('range', controller);
    }
  }
  async function open(
    subject: Subject,
    utc?: number,
    requestedRange = selectionRef.current,
    options: {
      restart?: boolean;
      restoring?: boolean;
      preserveWindow?: boolean;
      intent?: 'select' | 'seek';
      resolved?: PlaybackResponse;
      unitId?: string;
    } = {},
  ): Promise<void> {
    const { restart = false, restoring = false, preserveWindow = false } = options;
    const selecting = options.intent === 'select';
    const changingSubject = selectedIdRef.current !== subject.id;
    const following = !selecting && (selectionEndMs === null || changingSubject);
    setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: utc ?? null }));
    const range =
      utc === undefined ? requestedRange : playbackWindow(utc, requestedRange, timelineStartMs);
    coordinator.cancel('range');
    if (
      !options.resolved &&
      !restart &&
      utc !== undefined &&
      selectedIdRef.current === subject.id &&
      source?.kind === 'archive' &&
      source.playback.rangeFromMs === range.fromMs &&
      source.playback.rangeToMs === range.toMs &&
      utc >= range.fromMs &&
      utc < range.toMs &&
      player.current?.seek(utc, false, options.unitId)
    ) {
      setTargetMs(utc, options.unitId);
      if (!following) updateSnapshotReference(subject.id, utc);
      return;
    }
    invalidatePlayback(preserveWindow && source?.subject.id === subject.id);
    playbackKind.current = utc === undefined ? 'live' : 'archive';
    selectedIdRef.current = subject.id;
    setSelectedId(subject.id);
    if (utc === undefined) {
      const now = Date.now();
      setSelectionEndMs(null);
      setSelectionDurationMs(REPLAY_SPAN_MS);
      setBroadcast(null);
      setSnapshotReference(now);
      if (!restoring) setView(calendarWindow(now, requestedSpan, timelineStartMs));
    } else if (selecting) {
      // Selection metadata drives the timeline and snapshot requests independently
      // of manifest creation, decoder initialization and the first video frame.
      setSelectionEndMs(range.toMs);
      setSelectionDurationMs(range.toMs - range.fromMs);
      selectionRef.current = range;
      updateSnapshotReference(subject.id, utc);
    } else if (changingSubject) {
      setSelectionEndMs(null);
      setSelectionDurationMs(REPLAY_SPAN_MS);
      setBroadcast(null);
      setSnapshotReference(Date.now());
    }
    setTargetMs(utc ?? null, options.unitId);
    setPlayBusy(true);
    void loadPlayerEngine().catch((error) =>
      console.warn('Playback engine preparation failed', error),
    );
    const controller = coordinator.begin('playback');
    const version = coordinator.stamp();
    try {
      let result: PlayerSource;
      if (utc === undefined) {
        result = {
          kind: 'live',
          subject,
          stream: await request<LivePlaybackResponse>(
            `/api/subjects/${encodeURIComponent(subject.id)}/live`,
            {
              method: 'POST',
              operation: 'session',
              signal: controller.signal,
              headers:
                source?.kind === 'live'
                  ? { 'x-stv-replace-live': source.stream.sessionId }
                  : undefined,
            },
          ),
        };
      } else {
        result = {
          kind: 'archive',
          subject,
          unitId: options.unitId,
          playback:
            options.resolved ??
            (await request<PlaybackResponse>('/api/playback', {
              method: 'POST',
              operation: 'session',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                archiveRequest(subject.id, utc, following ? null : range, options.unitId),
              ),
              signal: controller.signal,
            })),
        };
      }
      if (!coordinator.adopt(version, controller.signal, result)) return;
      setSource(result);
      if (result.kind === 'archive') {
        const actualRange = archiveRange(result.playback, range);
        if (selecting && restoring) {
          setSelectionEndMs(actualRange.toMs);
          setSelectionDurationMs(actualRange.toMs - actualRange.fromMs);
        } else if (selecting) applyRange(preserveWindow ? range : actualRange);
        if (!following) updateSnapshotReference(subject.id, result.playback.actualAtMs);
        setTargetMs(
          result.playback.actualAtMs,
          options.unitId ??
            mediaTimePosition(result.playback.segments, result.playback.seekOffsetSeconds)?.unitId,
        );
      }
    } catch (cause) {
      if (controller.signal.aborted || version !== coordinator.stamp()) return;
      if (cause instanceof ApiError && cause.status === 401) handleUnauthorized();
      else setPlayerNotice(requestNotice(cause, utc === undefined));
    } finally {
      if (version === coordinator.stamp()) setPlayBusy(false);
      coordinator.settled('playback', controller);
    }
  }
  async function prepareNext(
    current: Extract<PlayerSource, { kind: 'archive' }>,
    signal: AbortSignal,
  ): Promise<Extract<PlayerSource, { kind: 'archive' }> | null> {
    const end = current.playback.rangeToMs ?? current.playback.windowEndMs;
    if (end === undefined || selectedIdRef.current !== current.subject.id) return null;
    const target = current.playback.nextAtMs;
    if (target == null) return null;
    const from = current.playback.rangeFromMs ?? selectionRef.current.fromMs;
    const to = current.playback.openUnitId ? Math.max(target + 1, selectionRef.current.toMs) : end;
    if (hasSelection && (to <= from || target >= to)) return null;
    try {
      const playback = await request<PlaybackResponse>('/api/playback', {
        method: 'POST',
        operation: 'session',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...archiveRequest(
            current.subject.id,
            target,
            hasSelection ? { fromMs: from, toMs: to } : null,
          ),
          ...(current.playback.openUnitId ? { openUnitId: current.playback.openUnitId } : {}),
        }),
        signal,
      });
      return { kind: 'archive', subject: current.subject, playback };
    } catch (cause) {
      if (signal.aborted || (cause instanceof ApiError && cause.message === 'coverage_gap'))
        return null;
      throw cause;
    }
  }
  function advancePlayback(next: Extract<PlayerSource, { kind: 'archive' }>): void {
    if (selectedIdRef.current !== next.subject.id) return;
    const range = archiveRange(next.playback, selectionRef.current);
    if (hasSelection) {
      applyRange(range);
      updateSnapshotReference(next.subject.id, next.playback.actualAtMs);
    }
    setSource(next);
    setTargetMs(
      next.playback.actualAtMs,
      mediaTimePosition(next.playback.segments, next.playback.seekOffsetSeconds)?.unitId,
    );
    if (hasSelection && (range.toMs <= view.fromMs || range.fromMs >= view.toMs))
      setView(calendarWindow(range.fromMs, requestedSpan, timelineStartMs));
  }
  async function logout(): Promise<void> {
    setRevealSubject(null);
    coverImages.clear();
    snapshotImages.clear();
    clearPreferences(storageKey);
    if (storageKey) writeWorkspace(storageKey, null);
    workspaceRestored.current = false;
    setSubjectsLoaded(false);
    setPreferencesReady(null);
    closePlayer();
    try {
      await request('/api/logout', { method: 'POST' });
    } finally {
      setSession({ authenticated: false, setupRequired: false });
    }
  }
  const deletionRecovery = useRef<{
    commandId: string | undefined;
    at: number;
    stamp: number;
  } | null>(null);
  function onMediaDeletion(event: MediaDeletionEvent): void {
    if (event.subjectId === selectedIdRef.current && event.knownEmpty) {
      closePlayer();
      return;
    }
    // Optimistic projection can already trim the removed edge from the visible
    // range. Its owned recovery still needs the durable acceptance to resume.
    const recovering =
      deletionRecovery.current?.commandId === event.commandId &&
      deletionRecovery.current?.stamp === coordinator.stamp();
    const window =
      !hasSelection && source?.kind === 'archive'
        ? archiveRange(source.playback, selectionRef.current)
        : selectionRef.current;
    if (
      !selected ||
      (!recovering &&
        !deletionAffectsPlayback(event, {
          subjectId: selectedIdRef.current,
          kind: playBusy ? playbackKind.current : (source?.kind ?? playbackKind.current),
          range: window,
        }))
    )
      return;
    const owner = selected;
    if (event.optimisticRanges) {
      const at =
        playbackClock.snapshot() ??
        (source?.kind === 'archive' ? source.playback.actualAtMs : window.fromMs);
      if (event.optimisticRanges.some((range) => range.fromMs <= at && range.toMs > at)) {
        player.current?.stop();
        invalidatePlayback(true);
        setSource(null);
        setTargetMs(null);
        setPlayBusy(false);
        deletionRecovery.current = { commandId: event.commandId, at, stamp: coordinator.stamp() };
      }
      return;
    }
    const recovery = deletionRecovery.current;
    const recoveryAt =
      recovery?.commandId === event.commandId && recovery?.stamp === coordinator.stamp()
        ? recovery.at
        : null;
    const target =
      recoveryAt ??
      playbackClock.snapshot() ??
      (source?.kind === 'archive' ? source.playback.actualAtMs : window.fromMs);
    player.current?.suspend();
    invalidatePlayback(true);
    if (recoveryAt !== null && deletionRecovery.current)
      deletionRecovery.current.stamp = coordinator.stamp();
    setBroadcast(null);
    setPlayBusy(true);
    const version = coordinator.stamp();
    const controller = coordinator.begin('range');
    void request<PlaybackResponse>('/api/playback', {
      method: 'POST',
      operation: 'session',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...archiveRequest(owner.id, target, hasSelection ? window : null),
        gapPolicy: 'next-or-previous',
      }),
    })
      .then(async (playback) => {
        if (
          !coordinator.adopt(version, controller.signal, {
            kind: 'archive',
            subject: owner,
            playback,
          })
        )
          return;
        const next = archiveRange(playback, window);
        if (hasSelection) applyRange(next);
        // The same server resolution supplies the range, surviving cursor and
        // playlist. Keep the paused decoded frame until its replacement is ready.
        await open(owner, playback.actualAtMs, next, {
          preserveWindow: true,
          resolved: playback,
          intent: 'seek',
        });
      })
      .catch((cause) => {
        if (controller.signal.aborted || version !== coordinator.stamp()) return;
        player.current?.stop();
        setSource(null);
        setTargetMs(null);
        if (cause instanceof ApiError && cause.message === 'coverage_gap') {
          // Release the complete playback owner, not just its range (which
          // would otherwise fall back to live mode for the same subject).
          closePlayer();
        } else setPlayerNotice(requestNotice(cause, false));
      })
      .finally(() => {
        if (version === coordinator.stamp()) setPlayBusy(false);
        coordinator.settled('range', controller);
      });
  }
  function playSnapshot(at: number, range: ViewWindow, unitId: string): void {
    if (!selected) return;
    if (source?.kind === 'archive' && player.current?.seek(at, true, unitId)) {
      setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: at }));
      setTargetMs(at, unitId);
      return;
    }
    // A thumbnail changes media position, never the presentation mode or range.
    void open(selected, at, range, { preserveWindow: true, intent: 'seek', unitId });
  }
  async function scrubPlayback(at: number): Promise<void> {
    if (!selected) return;
    const owner = selected;
    await coordinator.scrub(
      at,
      async (target) => {
        setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: target }));
        if (player.current?.seek(target)) setTargetMs(target);
        else
          await open(owner, target, selectionRef.current, { preserveWindow: true, intent: 'seek' });
      },
      () => selectedIdRef.current === owner.id,
    );
  }
  const health =
    system || systemError
      ? systemHealthStatus({
          diskError: system?.disk.error,
          lowSpace: system?.disk.lowSpace ?? false,
          maintenanceError: system?.maintenanceError,
          archiveError: system?.archiveHealth?.error,
          restarting: system?.archiveHealth?.recovery === 'restart-requested',
          snapshotUnavailable:
            system?.snapshotJobs?.mode === 'unavailable' &&
            system.snapshotJobs.error !== 'task_status_unavailable',
          serviceError: !!systemError,
        })
      : null;
  if (!session)
    return (
      <main className="loading-page">
        <span className="spinner" />
        <p>{sessionError || tr('连接本地归档…')}</p>
      </main>
    );
  if (!session.authenticated)
    return (
      <AuthGate
        session={session}
        onDone={(next) => {
          setTimeZone(next.timeZone ?? 'Asia/Shanghai');
          setSession(next);
        }}
      />
    );
  const content = (
    <main className="app-shell studio-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/assets/st-vault-mark.png" alt={tr('ST-Vault 标识')} />
          <BrandName />
        </div>
        <HeaderTools
          statusAlert={
            health && health.kind !== 'ok' && health.kind !== 'checking'
              ? health.title
              : backgroundTaskAlert(system?.backgroundTasks ?? [])
          }
          open={tool}
          setOpen={setTool}
          unread={eventMeta?.unreadCount ?? 0}
          history={
            <HistoryPanel
              meta={eventMeta}
              onMeta={setEventMeta}
              subjects={subjects}
              onReveal={(id) => {
                const subject = subjects.find((row) => row.id === id);
                if (!subject) return;
                setDirectoryStatus(subjectGroup(subject));
                setRevealSubject((previous) => ({ id, token: (previous?.token ?? 0) + 1 }));
                setTool(null);
              }}
            />
          }
          deletionBusy={deletionJobs.some((job) => !['completed', 'failed'].includes(job.state))}
          onLogout={() => void logout()}
          status={
            <SystemSummary
              health={health}
              system={system}
              deletions={deletionJobs}
              subjects={subjects}
              autoRecordingCount={subjects.filter((subject) => subject.autoRecord).length}
            />
          }
          settings={
            system?.settings ? (
              <RuntimeSettingsForm
                settings={system.settings}
                recording={
                  <GlobalRecordingSettings
                    value={system.recordAll ?? false}
                    onChange={setGlobalRecording}
                  />
                }
                onSaved={async (settings) => {
                  setSystem((current) => (current ? { ...current, settings } : current));
                  await loadSystem();
                }}
              />
            ) : (
              <PanelFeedback kind={systemError ? 'error' : 'info'}>
                {systemError || tr('正在读取状态')}
              </PanelFeedback>
            )
          }
        />
      </header>
      <div className="studio-workspace" id="top" ref={workspace}>
        <aside className="studio-viewer" ref={viewer}>
          <Player
            siteOrigin={system?.siteRoutes?.selectedOrigin}
            ref={player}
            range={source || hasSelection || playBusy ? selection : null}
            controlsPinned={tool === 'keys' || tool === 'cdn'}
            tools={
              <>
                <ToolPopover
                  title={tr('视频 CDN')}
                  className="cdn-tool"
                  open={tool === 'cdn'}
                  onToggle={() => setTool((current) => (current === 'cdn' ? null : 'cdn'))}
                  onClose={() => setTool((current) => (current === 'cdn' ? null : current))}
                  trigger={<Icon name="network" />}
                >
                  <RoutingOptions
                    kind="cdn"
                    subjectId={selected?.id}
                    onCdnChanged={() => {
                      if (
                        selected &&
                        playbackKind.current === 'live' &&
                        (playerNotice?.action === 'choose-cdn' ||
                          (liveProgress?.phase === 'stopped' &&
                            (liveProgress.reason === 'timeout' ||
                              liveProgress.reason === 'source' ||
                              liveProgress.reason === 'network')))
                      ) {
                        setTool(null);
                        void open(selected, undefined, selection, { restart: true });
                      }
                    }}
                  />
                </ToolPopover>
                <ToolPopover
                  title={tr('密钥')}
                  className={`key-tool${(keyInfo?.keyCount ?? 0) > 0 ? ' has-keys' : ''}${keyBusy ? ' is-busy' : ''}`}
                  busy={keyBusy}
                  open={tool === 'keys'}
                  onToggle={() => setTool((current) => (current === 'keys' ? null : 'keys'))}
                  onClose={() => setTool((current) => (current === 'keys' ? null : current))}
                  trigger={keyBusy ? <ProgressRing /> : <Icon name="key" />}
                >
                  <KeyTools onChanged={setKeyInfo} onBusyChange={setKeySaving} />
                </ToolPopover>
              </>
            }
            source={source}
            busy={playBusy}
            subject={selected}
            notice={playerNotice}
            liveProgress={liveProgress}
            live={playbackKind.current === 'live'}
            onImportKeys={() => setTool('keys')}
            onChooseCdn={() => setTool('cdn')}
            onRetry={() => {
              if (selected)
                void open(
                  selected,
                  playbackKind.current === 'archive'
                    ? (playbackClock.snapshot() ?? selection.fromMs)
                    : undefined,
                  selection,
                  {
                    restart: true,
                    intent: 'seek',
                    unitId: playbackKind.current === 'archive' ? explicitUnitId.current : undefined,
                  },
                );
            }}
            timeline={
              <>
                <FocusTimeline
                  subjectId={selectedId}
                  window={selection}
                  queryWindow={dataWindow}
                  timelineStartMs={timelineStartMs}
                  atMs={targetMs}
                  playbackClock={playbackClock}
                  onSeek={(utc) => {
                    void scrubPlayback(utc);
                  }}
                />
              </>
            }
            onSeek={(utc) => void scrubPlayback(utc)}
            snapshots={
              <SnapshotGrid
                subject={selected}
                referenceMs={snapshotReference}
                window={requestedSelection}
                queryWindow={snapshotWindow}
                followLive={selectionEndMs === null}
                playingLive={source?.kind === 'live' && source.subject.id === selectedId}
                navigation={playbackNavigation}
                atMs={targetMs}
                playbackClock={playbackClock}
                onSession={onSnapshotSession}
                onSeek={playSnapshot}
                onDeletion={onMediaDeletion}
                onJobs={setDeletionJobs}
              />
            }
            onCursor={(at, unitId) => {
              if (selectedId !== null && selectedIdRef.current === selectedId && !playBusy) {
                explicitUnitId.current = unitId;
                playbackClock.set(at, unitId);
                if (workspaceState.current.playback) {
                  workspaceState.current.playback.atMs = Math.round(at);
                  workspaceState.current.playback.explicitUnitId = unitId;
                }
              }
            }}
            onFollowLive={() => {
              setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: null }));
              setSelectionEndMs(null);
              setSelectionDurationMs(REPLAY_SPAN_MS);
            }}
            onPrepareNext={prepareNext}
            onAdvance={advancePlayback}
          />
        </aside>
        <section className="aligned-arrangement">
          <TrackBoard
            key={storageKey}
            restorePosition={restorePosition}
            onPosition={(position) => {
              workspaceState.current.list = position;
            }}
            reveal={revealSubject}
            subjects={filtered}
            filterKey={directoryStatus}
            selectedId={selectedId}
            fromMs={view.fromMs}
            toMs={view.toMs}
            selection={selection}
            timelineStartMs={timelineStartMs}
            nowMs={nowMs}
            controls={
              <DirectoryControls
                account={
                  <AccountTools
                    onImported={async () => {
                      await loadSubjects();
                    }}
                    open={tool === 'account'}
                    onToggle={() =>
                      setTool((current) => (current === 'account' ? null : 'account'))
                    }
                    onClose={() => setTool((current) => (current === 'account' ? null : current))}
                  />
                }
                statusFilter={directoryStatus}
                counts={counts}
                setStatusFilter={setDirectoryStatus}
              />
            }
            onChoose={(subject, utc, range) => void open(subject, utc, range)}
            onRangeChoose={selectRange}
            onAnchor={anchor.set}
            onViewChange={resize}
            onMove={move}
            onRecordingChange={(subject, record) => setRecording(subject.id, record)}
          />
          {error && (
            <p className="form-error" role="status">
              {error}
            </p>
          )}
        </section>
        <RowConnection
          anchor={anchor}
          workspace={workspace}
          viewer={viewer}
          name={selected?.handle ?? ''}
          onClose={closePlayer}
        />
      </div>
    </main>
  );
  return content;
}
