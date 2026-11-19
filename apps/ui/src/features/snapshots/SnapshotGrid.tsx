import { tr } from '../../shared/lib/i18n';
import { Icon } from '../../design/Icon';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { DeletionObserver, type MediaDeletionEvent } from './media-deletion';
import type {
  SnapshotSession,
  Subject,
  MediaDeletionTarget,
  MediaTimeRange,
  MediaDeletionJob,
} from '@st-vault/api-schema';
import { ApiError, MutationOutcomeUnknown } from '../../shared/lib/api';
import { formatDateTime } from '../timeline/timeline';
import { useSyncRefresh, type SyncReadResult } from '../../shared/lib/sync';
import { overlappingWindows } from './snapshot-page';
import { UnitImage } from './UnitImage';
import { isSnapshotLiked, snapshotKey } from './snapshot-identity';
import { messageFor } from '../../shared/lib/errors';
import { MediaDeleteDialog } from './MediaDeleteDialog';
import { SnapshotNotice } from './SnapshotNotice';
import { snapshotEmptyNotice } from './snapshot-status';
import { clockLabel, dayLabel } from '../../shared/lib/date-label';
import { durationLabel } from '../../shared/lib/duration';
import { useLayoutMotion } from '../../design/use-layout-motion';
import { SnapshotCommands } from './snapshot-commands';
import { newCommandId } from '../../shared/lib/command-id';
import {
  beginDeletionProjection,
  adoptDeletionProjection,
  failDeletionProjection,
  uncertainDeletionProjection,
} from '../../shared/lib/deletion-projection';
import type { FavoritePreview } from './favorite-state';
import { WheelPager } from './wheel-pager';
import { SnapshotToolbar } from './SnapshotToolbar';
import { SnapshotPageMotion } from './snapshot-page-motion';
import { useSnapshotView } from './use-snapshot-view';
import {
  usePlaybackClock,
  usePlaybackPosition,
  type PlaybackClock,
} from '../player/playback-clock';

export function SnapshotGrid({
  subject,
  referenceMs,
  window: range,
  queryWindow = range,
  followLive,
  playingLive = false,
  navigation,
  atMs: requestedAtMs,
  playbackClock,
  onSeek,
  onSession,
  onDeletion,
  onJobs,
}: {
  subject: Subject | null;
  referenceMs: number;
  window: MediaTimeRange;
  // Display seconds move the shared frame; only heartbeat bounds read metadata.
  queryWindow?: MediaTimeRange;
  followLive: boolean;
  playingLive?: boolean;
  navigation: { id: number; atMs: number | null };
  atMs: number | null;
  playbackClock?: PlaybackClock;
  onSeek: (utc: number, window: MediaTimeRange, unitId: string) => void;
  onSession: (id: string, session: SnapshotSession | null, window: MediaTimeRange) => void;
  onDeletion: (event: MediaDeletionEvent) => void;
  onJobs?: (jobs: MediaDeletionJob[]) => void;
}): JSX.Element {
  const atMs = usePlaybackClock(playbackClock, requestedAtMs);
  const { unitId: playingUnitId } = usePlaybackPosition(playbackClock);
  const section = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const commandsRef = useRef<SnapshotCommands | null>(null);
  commandsRef.current ??= new SnapshotCommands();
  const commands = commandsRef.current;
  const {
    scope,
    page,
    setPage,
    error,
    retry,
    retryRead,
    invalidatePresentation,
    current,
    shown,
    catalog,
    pagePending,
    acceptPersonal,
    acceptUnitFavorite,
    navigate,
    markers,
    displayMarkers,
    items,
    occupiedPages,
    pages,
    pageIndex,
    displayRange,
    playing,
    slots,
    favoritesReady,
  } = useSnapshotView({
    subject,
    referenceMs,
    range,
    queryWindow,
    followLive,
    playingLive,
    navigation,
    atMs,
    playingUnitId,
    onSession,
    commands,
  });
  const [activity, setActivity] = useState<'favorite' | null>(null),
    [feedback, setFeedback] = useState('');

  const [pendingFavorites, setPendingFavorites] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const busy = activity !== null || pendingFavorites.size > 0;
  const [favoritePreview, setFavoritePreview] = useState<FavoritePreview | null>(null);
  useEffect(() => {
    if (
      favoritePreview &&
      (favoritePreview.scope !== scope ||
        (favoritePreview.revision !== undefined &&
          favoritesReady &&
          markers &&
          markers.revision >= favoritePreview.revision))
    )
      setFavoritePreview(null);
  }, [favoritePreview, scope, favoritesReady, markers]);
  const observedJobs = useRef(new DeletionObserver());
  const [deletion, setDeletion] = useState<{
    scope: string;
    target: MediaDeletionTarget;
    ranges: MediaTimeRange[];
    protectedIds: string[];
    protectedRanges: MediaTimeRange[];
  } | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    setActivity(null);
    return () => {
      commands.cancelPreparation();
    };
  }, [scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      commands.dispose();
    };
  }, []);
  const jobsCallback = useRef(onJobs);
  jobsCallback.current = onJobs;
  const deletedCallback = useRef(onDeletion);
  deletedCallback.current = onDeletion;
  function publishJobs(update: { jobs: MediaDeletionJob[]; accepted: MediaDeletionJob[] }): void {
    update.jobs.forEach(adoptDeletionProjection);
    if (update.accepted.length && mounted.current) invalidatePresentation();
    jobsCallback.current?.(update.jobs);
    for (const value of update.accepted)
      deletedCallback.current({
        commandId: value.id,
        subjectId: value.subjectId,
        plan: { fromMs: value.fromMs, toMs: value.toMs },
      });
  }
  useSyncRefresh(
    ['system', 'timeline'],
    async (signal): Promise<SyncReadResult> => {
      const values = await commands.jobs(signal);
      if (signal.aborted) return;
      const update = observedJobs.current.update(values);
      publishJobs(update);
    },
    true,
    String(retry),
    true,
  );
  const wheel = useRef(new WheelPager());
  const wheelState = useRef({ pageIndex, occupiedPages, setPage });
  wheelState.current = { pageIndex, occupiedPages, setPage };
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const turn = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const current = wheelState.current;
      if (current.pageIndex < 0) return;
      const step = wheel.current.step(
        event.deltaY,
        event.deltaMode,
        node.clientHeight,
        performance.now(),
      );
      const next = current.occupiedPages[current.pageIndex + step];
      if (step && next !== undefined) current.setPage(next);
    };
    node.addEventListener('wheel', turn, { passive: false });
    return () => node.removeEventListener('wheel', turn);
  }, []);
  const motionTo = followLive ? queryWindow.toMs : displayRange.toMs;
  const motionRevision = useMemo(
    () => ({ items, page, from: displayRange.fromMs, to: motionTo }),
    [items, page, displayRange.fromMs, motionTo],
  );
  useLayoutMotion(grid, `${subject?.id ?? ''}:${page}`, motionRevision);
  const pageMotion = useRef<SnapshotPageMotion | null>(null);
  pageMotion.current ??= new SnapshotPageMotion();
  useLayoutEffect(() => {
    if (grid.current) pageMotion.current!.update(grid.current, scope, page);
  });
  useEffect(() => () => pageMotion.current!.clear(), []);
  const changed = () =>
    window.dispatchEvent(
      new CustomEvent('stv-sync', { detail: ['personal', 'timeline', 'subjects'] }),
    );
  const priorWindow = useRef({ id: subject?.id, range });
  useEffect(() => {
    const previous = priorWindow.current;
    priorWindow.current = { id: subject?.id, range };
    if (previous.id !== subject?.id || !overlappingWindows(previous.range, range)) {
      setFeedback('');

      commands.cancelPreparation();
      setActivity(null);
    }
  }, [subject?.id, range.fromMs, range.toMs]);
  useEffect(() => {
    setDeletion(null);
  }, [scope, page]);
  function openDeletion(): void {
    if (!subject || commands.busy || commands.hasFavoriteWrites || !catalog?.total) return;
    setFeedback('');
    setDeletion({
      scope,
      target: { kind: 'range', ...displayRange, mode: 'unliked' },
      // Optimistically remove only known non-favorites. Unseen pages stay owned
      // by the server's frozen selection rather than guessing their protection.
      ranges: favoritesReady
        ? items
            .filter((item) => !isSnapshotLiked(item, markers?.favorites ?? []))
            .map((item) => ({ fromMs: item.slotFromMs, toMs: item.slotToMs }))
        : [],
      protectedIds: markers?.favorites.map((item) => item.id) ?? [],
      protectedRanges: markers?.favorites.map(({ fromMs, toMs }) => ({ fromMs, toMs })) ?? [],
    });
  }
  async function confirmDeletion(): Promise<void> {
    const draft = deletion;
    if (draft?.scope !== scope || !subject) return;
    // This request owns an immutable target, not the browser preparation promise.
    const commandId = newCommandId();
    observedJobs.current.submit(commandId);
    const result = commands.admitDeletion(subject.id, commandId, draft.target);
    flushSync(() => {
      beginDeletionProjection(
        commandId,
        subject.id,
        draft.target,
        draft.ranges,
        draft.protectedIds,
        draft.protectedRanges,
      );
      setDeletion(null);
      setFeedback('');
    });
    deletedCallback.current({
      commandId,
      subjectId: subject.id,
      plan: { fromMs: draft.target.fromMs, toMs: draft.target.toMs },
      optimisticRanges: draft.ranges,
      knownEmpty:
        favoritesReady && shown?.total === items.length && draft.ranges.length === items.length,
    });
    try {
      const job = await result;
      adoptDeletionProjection(job);
      publishJobs(observedJobs.current.remember(job));
    } catch (cause) {
      if (cause instanceof MutationOutcomeUnknown) {
        try {
          const accepted = (await commands.jobs(AbortSignal.timeout(15000))).find(
            (job) => job.id === commandId,
          );
          if (accepted) {
            publishJobs(observedJobs.current.remember(accepted));
            return;
          }
        } catch (error) {
          console.warn(
            'Media operation reconciliation unavailable',
            error instanceof Error ? error.name : 'unknown',
          );
        }
        uncertainDeletionProjection(commandId, messageFor(cause));
        return;
      }
      failDeletionProjection(commandId, messageFor(cause));
    } finally {
      changed();
    }
  }
  function favoriteId(subjectId: string, unitId: string): string {
    return `${subjectId}/${unitId}`;
  }
  async function setFavorite(item: (typeof items)[number], liked: boolean): Promise<void> {
    if (!subject || !favoritesReady || !markers || commands.busy) return;
    const subjectId = subject.id;
    const ownerScope = scope;
    const id = favoriteId(subjectId, item.unitId);
    if (pendingFavorites.has(id)) return;
    setPendingFavorites((pending) => new Map(pending).set(id, liked));
    setFeedback('');
    try {
      const result = await commands.setFavorite(subjectId, item, liked, markers.revision);
      if (mounted.current) acceptUnitFavorite(subjectId, item.unitId, result);
    } catch (cause) {
      if (mounted.current && scopeRef.current === ownerScope) setFeedback(messageFor(cause));
    } finally {
      if (mounted.current)
        setPendingFavorites((pending) => {
          const next = new Map(pending);
          next.delete(id);
          return next;
        });
      queueMicrotask(() => {
        if (!commands.hasFavoriteWrites) changed();
      });
    }
  }
  async function clearFavorites(): Promise<void> {
    if (!subject || commands.hasFavoriteWrites || !catalog?.total) return;
    const operation = commands.begin(scope);
    if (!operation) return;
    let retainPreview = false;
    setFavoritePreview({
      owner: operation.revision,
      scope,
      ids: new Set(items.map(snapshotKey)),
      liked: false,
    });
    const ownsUI = () => mounted.current && commands.current(operation, scopeRef.current);
    setActivity('favorite');
    setFeedback('');
    try {
      const result = await commands.unlikeRange(subject.id, displayRange, operation.signal);
      if (ownsUI()) {
        retainPreview = true;
        setFavoritePreview((old) =>
          old?.owner === operation.revision ? { ...old, revision: result.revision } : old,
        );
        acceptPersonal(null);
      }
    } catch (cause) {
      if (ownsUI()) {
        setFeedback(messageFor(cause));
        if (
          (cause instanceof ApiError && cause.status === 409) ||
          cause instanceof MutationOutcomeUnknown
        )
          acceptPersonal(null);
      }
    } finally {
      if (!retainPreview)
        setFavoritePreview((old) => (old?.owner === operation.revision ? null : old));
      changed();
      if (commands.current(operation)) {
        commands.release(operation);
        if (mounted.current) setActivity(null);
      }
    }
  }
  const toolbar = (
    <SnapshotToolbar
      total={followLive ? items.length : (catalog?.total ?? 0)}
      pageIndex={pageIndex}
      pages={pages}
      live={followLive}
      connected={!!subject}
      busy={busy}
      status={feedback}
      onPrevious={() => setPage(occupiedPages[pageIndex - 1])}
      onNext={() => setPage(occupiedPages[pageIndex + 1])}
      onUnlike={() => void clearFavorites()}
      onDelete={openDeletion}
    />
  );

  return (
    <section
      ref={section}
      className="snapshot-section"
      aria-label={tr('时间段截图')}
      data-from={displayRange.fromMs}
      data-to={displayRange.toMs}
    >
      {toolbar}
      {deletion?.scope === scope && (
        <MediaDeleteDialog
          anchor={section.current}
          onClose={() => {
            setDeletion(null);
          }}
          onConfirm={() => void confirmDeletion()}
        />
      )}
      {(error !== null || (!items.length && !pagePending)) && (
        <SnapshotNotice
          scope={subject?.id ?? 'snapshots'}
          notice={
            error ??
            snapshotEmptyNotice(
              !subject
                ? 'idle'
                : !shown
                  ? 'loading'
                  : current?.total
                    ? 'page-empty'
                    : followLive &&
                        subject.providerStatus !== 'OFFLINE' &&
                        ['QUEUED', 'RESOLVING', 'CAPTURING'].includes(subject.captureState ?? '')
                      ? 'recording'
                      : 'empty',
              subject
                ? {
                    subjectName: subject.handle,
                    window: displayRange,
                    following: followLive,
                    offline: subject.providerStatus === 'OFFLINE',
                  }
                : undefined,
            )
          }
          compact={items.length > 0}
          onRetry={retryRead}
        />
      )}
      <div className="snapshot-viewport">
        <div
          className="snapshot-grid"
          ref={grid}
          data-total-slots={slots.length}
          aria-busy={busy || pagePending || (!!subject && !shown)}
        >
          {slots.map((item, index) => {
            if (!item)
              return (
                <div
                  key={`empty:${index}`}
                  data-slot={index}
                  className={`snapshot-slot-empty${pagePending ? ' is-loading' : ''}`}
                  aria-hidden="true"
                />
              );
            if ('kind' in item)
              return (
                <div
                  data-slot={index}
                  key={
                    item.kind === 'pending'
                      ? `pending:${item.fromMs}`
                      : `gap:${item.fromMs}:${item.toMs}:${item.part}`
                  }
                  className={`snapshot-gap snapshot-gap--${item.kind}${playing?.kind === 'pending' && playing.fromMs === item.fromMs ? ' is-playing' : ''}`}
                  aria-current={
                    playing?.kind === 'pending' && playing.fromMs === item.fromMs
                      ? 'time'
                      : undefined
                  }
                  data-gap-from={item.fromMs}
                  data-gap-to={item.toMs}
                >
                  {item.part === Math.floor((item.parts ?? 1) / 2) && (
                    <span>
                      {item.kind === 'pending'
                        ? tr('等待落盘')
                        : tr('无录像 {{v0}}', { v0: durationLabel(item.toMs - item.fromMs) })}
                    </span>
                  )}
                </div>
              );
            const from = item.slotFromMs,
              to = item.slotToMs;
            const preview =
              favoritePreview?.scope === scope && favoritePreview.ids.has(item.unitId)
                ? favoritePreview
                : null;
            const pending = pendingFavorites.get(favoriteId(subject!.id, item.unitId));
            const liked =
              pending ?? preview?.liked ?? isSnapshotLiked(item, displayMarkers?.favorites ?? []);
            return (
              <div
                className="snapshot-cell"
                key={snapshotKey(item)}
                data-at={item.atMs}
                data-key={snapshotKey(item)}
                data-motion-key={snapshotKey(item)}
                data-slot={index}
                title={`${dayLabel(from)} ${clockLabel(from)} — ${dayLabel(to)} ${clockLabel(to)}`}
              >
                <button
                  data-unit-index={index}
                  data-at={item.atMs}
                  data-key={snapshotKey(item)}
                  aria-current={
                    playing?.kind === 'unit' && playing.item === item ? 'time' : undefined
                  }
                  className={playing?.kind === 'unit' && playing.item === item ? 'selected' : ''}
                  disabled={pagePending}
                  onClick={() => {
                    navigate(item.atMs);
                    onSeek(item.atMs, displayRange, item.unitId);
                  }}
                  aria-label={tr('播放 {{v0}}{{v1}}', {
                    v0: formatDateTime(item.atMs),
                    v1: liked ? tr(' · 有喜欢标记') : '',
                  })}
                >
                  <div>
                    <UnitImage
                      src={item.url}
                      subjectId={subject!.id}
                      unitId={item.unitId}
                      toMs={item.slotToMs}
                    />
                  </div>
                  <time>{formatDateTime(item.atMs).slice(-5)}</time>
                </button>
                <button
                  className="snapshot-favorite"
                  aria-label={tr(liked ? '取消喜欢' : '喜欢')}
                  aria-pressed={liked}
                  aria-busy={
                    pending !== undefined ||
                    (preview?.revision === undefined && !!preview) ||
                    undefined
                  }
                  disabled={
                    activity !== null || pending !== undefined || pagePending || !favoritesReady
                  }
                  onClick={() => void setFavorite(item, !liked)}
                >
                  <Icon name="heart" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
