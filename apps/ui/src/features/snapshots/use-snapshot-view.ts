import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PersonalTimeline,
  SnapshotPagesResponse,
  SnapshotSession,
  Subject,
  MediaTimeRange,
} from '@st-vault/api-schema';
import { request } from '../../shared/lib/api';
import {
  useDeletionProjections,
  pendingProjection,
  projectionDeletesUnit,
} from '../../shared/lib/deletion-projection';
import { useSyncRefresh, syncReadFailure, type SyncReadResult } from '../../shared/lib/sync';
import {
  snapshotGridSlots,
  overlappingWindows,
  projectSnapshotPacket,
  snapshotPageAt,
  snapshotPlaybackPage,
  nearestSnapshotPage,
  liveSnapshotPresentation,
  projectRemovedUnits,
  type SnapshotPosition,
} from './snapshot-page';
import { snapshotPlaybackTarget } from './snapshot-playing';
import { snapshotKey } from './snapshot-identity';
import { snapshotFailure } from './snapshot-status';
import type { PlaybackNotice } from '../player/player-status';
import { SnapshotViewController } from './snapshot-view';
import type { SnapshotCommands } from './snapshot-commands';
import { mergeFavoriteResult } from './favorite-state';
/** Owns page reads, immutable view snapshots and navigation; commands and DOM motion have separate lifetimes. */
export function useSnapshotView({
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
}: {
  subject: Subject | null;
  referenceMs: number;
  range: MediaTimeRange;
  queryWindow: MediaTimeRange;
  followLive: boolean;
  playingLive: boolean;
  navigation: { id: number; atMs: number | null };
  atMs: number | null;
  playingUnitId?: string;
  commands: SnapshotCommands;
  onSession: (id: string, session: SnapshotSession | null, window: MediaTimeRange) => void;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [data, setData] = useState<{
    scope: string;
    value: SnapshotPagesResponse;
    range: MediaTimeRange;
    authority: MediaTimeRange[];
    playbackUnitId?: string;
  } | null>(null);
  const scope = `${subject?.id}:${referenceMs}:${followLive ? 'following' : range.fromMs}`;
  const [position, setPosition] = useState<SnapshotPosition | null>(null);
  const pageAnchors = useRef<number[]>([]);
  const viewController = useRef(new SnapshotViewController()).current;
  // Mode/reference changes do not change the identity or chronology of a card.
  const currentPosition =
    position && position.subjectId === subject?.id && overlappingWindows(position.range, range)
      ? position
      : null;
  const followTail = followLive;
  const page = followTail
    ? Math.max(1, pageAnchors.current.length)
    : snapshotPageAt(
        currentPosition,
        subject?.id ?? null,
        range,
        data?.scope === scope ? pageAnchors.current : [],
      );
  const browsing = currentPosition?.browsing && currentPosition.navigationId === navigation.id;
  const setPage = (next: number, manual = true) => {
    // Revoke an earlier heartbeat before React schedules the new page read.
    viewController.invalidate();
    setPosition({
      subjectId: subject?.id ?? null,
      atMs: pageAnchors.current[next - 1] ?? range.fromMs,
      page: next,
      pageAnchors: pageAnchors.current,
      browsing: manual,
      navigationId: navigation.id,
      range,
    });
  };
  const [failure, setFailure] = useState<{ scope: string; notice: PlaybackNotice } | null>(null);
  const [retry, setRetry] = useState(0);
  const failureScope = `${scope}:${page}`;
  const error = failure?.scope === failureScope ? failure.notice : null;

  const sessionCallback = useRef(onSession);
  sessionCallback.current = onSession;

  const invalidatePresentation = (): void => {
    viewController.invalidate();
    setRetry((value) => value + 1);
  };

  const current = useMemo(
    () =>
      projectSnapshotPacket(
        data,
        subject?.id ?? null,
        range,
        page,
        data?.scope !== scope ? currentPosition?.atMs : undefined,
      ),
    [data, subject?.id, range.fromMs, range.toMs, page, followLive, scope, currentPosition?.atMs],
  );
  // A page intent changes the visible surface immediately. Heartbeats retain
  // same-page pixels; the motion layer alone owns pixels from the outgoing page.
  const shown = current ?? (data?.scope === scope && data.value.page === page ? data.value : null);
  const staleWindow =
    !followLive &&
    shown === data?.value &&
    (data.range.fromMs !== range.fromMs || data.range.toMs !== range.toMs);
  const pagePending = staleWindow || (!shown && data?.scope === scope && data.value.page !== page);
  const personalScope = `${scope}:${page}:${shown?.items.map(snapshotKey).join(',') ?? ''}`;
  const personalScopeRef = useRef(personalScope);
  personalScopeRef.current = personalScope;
  const [pagePersonal, setPagePersonal] = useState<{
    scope: string;
    value: PersonalTimeline;
    stale?: boolean;
  } | null>(null);
  useSyncRefresh(
    ['personal'],
    async (signal): Promise<SyncReadResult> => {
      if (!subject || !shown?.items.length) return;
      try {
        const value = await commands.personal(subject.id, shown.items, signal);
        if (signal.aborted) return;
        setPagePersonal((old) =>
          old?.scope === personalScope && old.value.revision > value.revision
            ? old
            : {
                scope: personalScope,
                value,
              },
        );
      } catch (cause) {
        if (!signal.aborted) console.warn('Snapshot favorites unavailable', cause);
        return syncReadFailure(cause, signal);
      }
    },
    !!subject && !!shown?.items.length,
    personalScope,
  );
  const markers = pagePersonal?.scope === personalScope ? pagePersonal.value : null;
  // Unit identities survive page/window changes. Keep known display facts while
  // fetching the new page; mutations still require the exact markers scope below.
  const displayMarkers =
    pagePersonal && pagePersonal.value.subjectId === subject?.id ? pagePersonal.value : null;
  const deletions = useDeletionProjections();
  const packetItems = useMemo(
    () =>
      (shown?.items ?? []).filter(
        (item) =>
          !deletions.some(
            (entry) =>
              pendingProjection(entry, subject?.id, shown?.deletionRevision) &&
              projectionDeletesUnit(entry, item),
          ),
      ),
    [shown?.items, shown?.deletionRevision, deletions, subject?.id],
  );
  const presentation = useMemo(
    () =>
      followLive
        ? liveSnapshotPresentation(packetItems, range)
        : projectRemovedUnits(
            packetItems,
            shown?.items ?? [],
            shown?.cells ?? [],
            shown?.pageOffset ?? (page - 1) * 30,
          ),
    [
      packetItems,
      followLive,
      range.fromMs,
      range.toMs,
      shown?.cells,
      shown?.items,
      shown?.pageOffset,
      page,
    ],
  );
  const { items, cells } = presentation;
  // The directory belongs to the selected window, not the page's pending pixels.
  // Keep navigation usable while a different page in that same window is loading.
  const catalog =
    shown ??
    (data?.scope === scope && data.range.fromMs === range.fromMs && data.range.toMs === range.toMs
      ? data.value
      : null);
  const occupiedPages = catalog?.occupiedPages ?? [];
  const pages = occupiedPages.length;
  const pageIndex = occupiedPages.indexOf(page);
  const retainedRange = !followLive && shown === data?.value ? data.range : range;
  const displayFrom = followLive && items.length ? items[0].slotFromMs : retainedRange.fromMs;
  const displayRange = useMemo(
    () => ({ fromMs: displayFrom, toMs: retainedRange.toMs }),
    [displayFrom, retainedRange.toMs],
  );
  // Reserving the live tail can evict an old unit before the next metadata read.
  // Publish that same boundary to the timeline and whole-range media commands.
  useEffect(() => {
    if (subject && shown && followLive)
      sessionCallback.current(subject.id, shown.session, displayRange);
  }, [subject?.id, shown?.session, followLive, displayFrom, range.fromMs, displayRange]);
  const playing = snapshotPlaybackTarget(
    items,
    cells,
    atMs,
    playingLive,
    displayRange.toMs,
    playingUnitId,
  );
  const playbackPage = playingUnitId
    ? items.some((item) => item.unitId === playingUnitId)
      ? (shown?.page ?? null)
      : data?.playbackUnitId === playingUnitId
        ? (data.value.playbackUnitPage ?? null)
        : null
    : snapshotPlaybackPage(
        atMs,
        displayRange,
        data?.scope === scope ? occupiedPages : [],
        data?.value.pageAnchors,
      );
  useEffect(() => {
    if (browsing || followTail) return;
    // Only a new playback intent releases manual browsing. Partition changes
    // and background progress are observations, never navigation commands.
    if (playbackPage !== null && page !== playbackPage) setPage(playbackPage, false);
  }, [playbackPage, page, browsing, followTail]);
  const slots = useMemo(
    () =>
      snapshotGridSlots(
        items,
        queryWindow,
        shown?.page ?? page,
        30,
        cells,
        followLive ? 0 : shown?.pageOffset,
      ),
    [
      items,
      queryWindow.fromMs,
      queryWindow.toMs,
      page,
      shown?.page,
      shown?.slotCount,
      cells,
      shown?.pageOffset,
      followLive,
    ],
  );

  useSyncRefresh(
    ['timeline', 'subjects'],
    async (signal): Promise<SyncReadResult> => {
      if (!subject) return;
      const generation = viewController.invalidate();
      try {
        const value = await request<SnapshotPagesResponse>(
          `/api/subjects/${encodeURIComponent(subject.id)}/snapshot-pages?at=${referenceMs}&from=${queryWindow.fromMs}&to=${queryWindow.toMs}&page=${followTail ? 'last' : page}&limit=30${followLive ? '&follow=1' : ''}${playingUnitId ? `&unitId=${encodeURIComponent(playingUnitId)}` : ''}`,
          { signal },
        );
        if (signal.aborted || !viewController.accept(generation, value)) return;
        pageAnchors.current = value.pageAnchors ?? [];
        if (!followTail && currentPosition) {
          const next = nearestSnapshotPage(
            snapshotPageAt(currentPosition, subject.id, range, pageAnchors.current),
            value.occupiedPages,
          );
          if (next !== value.page) {
            // Page ordinals can change with partitioning or deletions. Keep the
            // anchored card visible until its newly resolved page is available.
            setPosition({
              ...currentPosition,
              range,
              page: next,
              pageAnchors: pageAnchors.current,
            });
            return;
          }
        }
        // Unit metadata advances independently; surviving images retain their DOM nodes.
        setData({
          scope,
          value,
          playbackUnitId: playingUnitId,
          range: followLive ? (value.displayWindow ?? queryWindow) : range,
          authority: value.items.length
            ? [
                {
                  fromMs: Math.min(...value.items.map((item) => item.slotFromMs)),
                  toMs: Math.max(...value.items.map((item) => item.slotToMs)),
                },
              ]
            : value.total === 0
              ? [range]
              : [],
        });
        setFailure(null);
        if (!followTail) {
          const next = nearestSnapshotPage(value.page, value.occupiedPages);
          if (next !== page) setPage(next, !!browsing);
        }
        sessionCallback.current(subject.id, value.session, value.displayWindow ?? queryWindow);
      } catch (cause) {
        if (
          mounted.current &&
          viewController.current(generation) &&
          (!signal.aborted ||
            (signal.reason instanceof Error && signal.reason.name === 'TimeoutError'))
        ) {
          setFailure({
            scope: failureScope,
            notice: snapshotFailure(signal.aborted ? signal.reason : cause),
          });
          console.warn('Snapshot page unavailable', cause);
        }
        return syncReadFailure(cause, signal);
      }
    },
    !!subject,
    `${scope}:${queryWindow.fromMs}:${queryWindow.toMs}:${page}:${retry}:${playingUnitId ?? ''}`,
  );

  const favoritesReady = pagePersonal?.scope === personalScope && !pagePersonal.stale;
  const acceptPersonal = (value: PersonalTimeline | null): void => {
    if (personalScopeRef.current !== personalScope) return;
    setPagePersonal((old) =>
      !value
        ? old
          ? { ...old, stale: true }
          : null
        : old?.scope === personalScope && old.value.revision > value.revision
          ? old
          : { scope: personalScope, value },
    );
  };
  const acceptUnitFavorite = (
    subjectId: string,
    unitId: string,
    result: Pick<PersonalTimeline, 'favorites' | 'revision'>,
  ): void => {
    setPagePersonal((old) =>
      old?.value.subjectId === subjectId && old.scope === personalScopeRef.current
        ? { ...old, value: mergeFavoriteResult(old.value, result, [unitId]) }
        : old,
    );
  };
  const navigate = (atMs: number): void => {
    if (followLive) return;
    viewController.invalidate();
    setPosition({
      subjectId: subject?.id ?? null,
      atMs,
      page: shown?.page ?? page,
      pageAnchors: pageAnchors.current,
      browsing: false,
      navigationId: navigation.id,
      range: displayRange,
    });
  };
  const retryRead = (): void => {
    setFailure(null);
    invalidatePresentation();
  };
  return {
    scope,
    data,
    page,
    setPage,
    error,
    retry,
    retryRead,
    invalidatePresentation,
    current:
      current && shown && packetItems.length < shown.items.length
        ? {
            ...current,
            total: Math.max(0, current.total - (shown.items.length - packetItems.length)),
          }
        : current,
    shown,
    catalog:
      catalog && shown && packetItems.length < shown.items.length
        ? {
            ...catalog,
            total: Math.max(0, catalog.total - (shown.items.length - packetItems.length)),
          }
        : catalog,
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
  };
}
