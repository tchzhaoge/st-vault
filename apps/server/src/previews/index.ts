import type { BackgroundTask, Segment, SnapshotItem } from '@st-vault/api-schema';
import type { ArchivePort, PreviewsPort } from '../ports.js';
import { createHttp, waitFor } from '../provider/http.js';
import { MediaBudget } from '../provider/media-budget.js';
import { createFfmpegDecoder, jpeg, SnapshotDecodeError, verifyJpeg } from './ffmpeg.js';
import { ScreenshotJobs, SNAPSHOT_REQUEST_PRIORITY } from './jobs.js';
import type { SnapshotDecoder } from './ffmpeg.js';
import { previewImageType } from './image-type.js';
import { PreviewDiskCache } from './disk-cache.js';
import { LibraryImages } from '../library/images.js';
import { createSubjectAvatars } from './avatars.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import path from 'node:path';
import { broadcastCover, coverSource } from '../provider/cover-source.js';
import { SiteRoutes } from '../provider/site-routes.js';
import { broadcastResponse } from '../provider/public-api.js';
import { DerivativeDiagnostics } from './derivative-diagnostics.js';

export class PreviewError extends Error {
  constructor(
    readonly code:
      | 'preview_not_found'
      | 'preview_busy'
      | 'preview_unavailable'
      | 'preview_failed'
      | 'preview_cancelled'
      | 'preview_pending',
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
interface CacheEntry {
  bytes: Uint8Array;
  expires: number;
  mediaIds?: string[];
  throughMs?: number;
}
interface Task {
  controller: AbortController;
  done: Promise<unknown>;
}
interface PreviewLane {
  budget: MediaBudget | null;
  capacity: number;
  admitted: number;
}
export interface PreviewOptions {
  sites?: SiteRoutes;
  clock?: SyncClock;
  archive: Pick<
    ArchivePort,
    | 'listSubjects'
    | 'getSubject'
    | 'locate'
    | 'timeline'
    | 'media'
    | 'hasMedia'
    | 'subscribeMedia'
    | 'subjectPreview'
    | 'snapshotPages'
    | 'snapshotUnit'
    | 'unitSource'
  > &
    Partial<Pick<ArchivePort, 'getSetting' | 'setSetting' | 'withBackgroundReads'>>;
  fetch?: typeof globalThis.fetch;
  ffmpegPath?: string;
  decoder?: SnapshotDecoder;
  now?: () => number;
  timeoutMs?: number;
  cacheBytes?: number;
  cacheRoot?: string;
  mediaRoot?: string;
  canGenerate?: () => boolean;
  validateSnapshot?: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  decoderConcurrency?: number;
  networkConcurrency?: number;
  readConcurrency?: number;
  publishConcurrency?: number;
}
export function createPreviews(options: PreviewOptions): PreviewsPort {
  const sites =
    options.sites ??
    new SiteRoutes({ origins: ['https://stripchat.com'], fetch: options.fetch, timeoutMs: 5000 });
  const avatars =
    options.cacheRoot && options.archive.getSetting && options.archive.setSetting
      ? createSubjectAvatars({
          sites,
          root: options.cacheRoot,
          mediaRoot: options.mediaRoot,
          archive: {
            listSubjects: options.archive.listSubjects.bind(options.archive),
            getSetting: options.archive.getSetting.bind(options.archive),
            setSetting: options.archive.setSetting.bind(options.archive),
            withBackgroundReads: options.archive.withBackgroundReads?.bind(options.archive),
          },
          clock: options.clock,
          fetch: options.fetch,
          concurrency: options.networkConcurrency,
          publishConcurrency: options.publishConcurrency,
        })
      : null;
  const now = options.now ?? Date.now,
    timeoutMs = options.timeoutMs ?? 15000,
    cacheBytes = options.cacheBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(cacheBytes) ||
    cacheBytes < 0 ||
    cacheBytes > 32 * 1024 * 1024
  )
    throw new Error('INVALID_PREVIEW_OPTIONS');
  const coverHttp = createHttp({
    fetch: options.fetch,
    timeoutMs: 5000,
    allow: (url) => coverSource(url.href) !== null,
  });
  const decode = options.decoder ?? createFfmpegDecoder({ ffmpegPath: options.ffmpegPath });
  const cache = new Map<string, CacheEntry>(),
    tasks = new Set<Task>();
  let used = 0,
    closed = false,
    closing: Promise<void> | undefined;
  const emptyWindows = new Map<string, number>();
  const decoderBudget = new MediaBudget(options.decoderConcurrency ?? 1),
    networkBudget = new MediaBudget(options.networkConcurrency ?? 2),
    queryBudget = new MediaBudget(options.readConcurrency ?? 4),
    coverReadBudget = new MediaBudget(options.readConcurrency ?? 4);
  // Bound waiters by their resource class rather than competing for a global
  // request count. Waiting requests retain metadata, not decoded image buffers.
  const lane = (
    budget: MediaBudget | null,
    concurrency = budget?.stats().limit ?? 1,
  ): PreviewLane => ({
    budget,
    capacity: Math.max(24, concurrency * 4),
    admitted: 0,
  });
  const decoderLane = lane(decoderBudget),
    networkLane = lane(networkBudget),
    queryLane = lane(queryBudget),
    imageReadLane = lane(coverReadBudget),
    coverLane = lane(null, networkBudget.stats().limit + coverReadBudget.stats().limit);
  const coverDisk = options.mediaRoot
    ? new LibraryImages(options.mediaRoot, 'cover', options.publishConcurrency)
    : options.cacheRoot
      ? new PreviewDiskCache(path.join(options.cacheRoot, 'covers'), 128 * 1024 ** 2, 2048)
      : null;
  const cached = (key: string): Uint8Array | null => {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    if (entry.expires <= now()) {
      used -= entry.bytes.length;
      return null;
    }
    cache.set(key, entry);
    return entry.bytes;
  };
  const save = (
    key: string,
    bytes: Uint8Array,
    ttl: number,
    cover = false,
    mediaIds?: string[],
    throughMs?: number,
  ): void => {
    if (closed) throw new PreviewError('preview_cancelled');
    if (bytes.length > 512 * 1024 || !(cover ? previewImageType(bytes) : jpeg(bytes)))
      throw new PreviewError('preview_failed');
    const old = cache.get(key);
    if (old) {
      used -= old.bytes.length;
      cache.delete(key);
    }
    if (bytes.length > cacheBytes) return;
    while (cache.size >= 96 || used + bytes.length > cacheBytes) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      used -= cache.get(first)!.bytes.length;
      cache.delete(first);
    }
    cache.set(key, { bytes, expires: now() + ttl, mediaIds, throughMs });
    used += bytes.length;
  };
  const run = async <T>(
    lane: PreviewLane,
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (closed) throw new PreviewError('preview_unavailable');
    if (signal?.aborted) throw new PreviewError('preview_cancelled');
    if (lane.admitted >= lane.capacity) throw new PreviewError('preview_busy');
    lane.admitted++;
    const controller = new AbortController(),
      cancel = (): void => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      const release = lane.budget
        ? await lane.budget.acquire(controller.signal)
        : (): void => undefined;
      timer = setTimeout(cancel, timeoutMs);
      try {
        return await action(controller.signal);
      } finally {
        clearTimeout(timer);
        release();
      }
    })();
    const task: Task = { controller, done: work };
    tasks.add(task);
    void work
      .finally(() => {
        tasks.delete(task);
        lane.admitted--;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      })
      .catch(() => undefined);
    try {
      return await waitFor(work, controller.signal);
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      if (controller.signal.aborted)
        throw new PreviewError(signal?.aborted ? 'preview_cancelled' : 'preview_unavailable');
      throw new PreviewError('preview_failed', { cause: error });
    }
  };
  const subject = async (id: string): Promise<number> => {
    const item = await options.archive.getSubject(id);
    if (!item) throw new PreviewError('preview_not_found');
    return item.providerId;
  };
  const covering = async (id: string, at: number, unitId?: string): Promise<Segment> => {
    const segment =
      unitId && options.archive.unitSource
        ? await options.archive.unitSource(id, unitId, at)
        : await options.archive.locate(id, at, 'report');
    if (
      segment?.wallStartMs == null ||
      segment.wallEndMs === null ||
      segment.wallStartMs > at ||
      segment.wallEndMs <= at
    )
      throw new PreviewError('preview_not_found');
    return segment;
  };
  const ids = (segments: readonly Segment[]): string[] => [
    ...new Set(
      segments.flatMap((segment) =>
        segment.initObjectId
          ? [segment.initObjectId, segment.mediaObjectId]
          : [segment.mediaObjectId],
      ),
    ),
  ];
  const observedSources = new Map<string, string | null>();
  const versions = new Map<string, string>();
  const coverDiagnostics = new DerivativeDiagnostics(now);
  const coverFailures = new Map<string, { source: string; attempts: number; retryAt: number }>();
  const reportCoverFailure = (error: unknown, source: string | null): void =>
    coverDiagnostics.record(
      'cover_refresh_failed',
      error,
      'warn',
      source ? new URL(source).hostname : undefined,
    );
  const failCover = (id: string, qualification: string): void => {
    const previous = coverFailures.get(id);
    const attempts = previous?.source === qualification ? Math.min(previous.attempts + 1, 7) : 1;
    coverFailures.delete(id);
    // These are short-lived retry qualifications, not a second image/version cache.
    if (coverFailures.size >= 2048) coverFailures.delete(coverFailures.keys().next().value!);
    coverFailures.set(id, {
      source: qualification,
      attempts,
      retryAt: now() + Math.min(300000, 5000 * 2 ** (attempts - 1)),
    });
  };
  const fetchCover = async (id: string, abort: AbortSignal, force = false): Promise<Uint8Array> => {
    const providerId = await subject(id),
      key = 'cover:' + providerId;
    const hit = cached(key);
    if (hit && !force) return hit;
    const local = hit ?? (await coverDisk?.get(key));
    const previous = local && previewImageType(local) ? local : null;
    let source: string | null = null;
    let qualification = '',
      cooling = false,
      primaryFailed = false;
    try {
      const storedSource = coverSource(await options.archive.subjectPreview?.(id));
      qualification = JSON.stringify([observedSources.get(id) ?? storedSource, storedSource]);
      const failure = coverFailures.get(id);
      cooling = failure?.source === qualification && now() < failure.retryAt;
      if (cooling) {
        if (previous) return previous;
        throw new PreviewError('preview_not_found');
      }
      if (observedSources.has(id)) source = observedSources.get(id)!;
      else if (storedSource) source = storedSource;
      else {
        const item = await sites.read(
          '/api/front/v2/broadcasts/' + providerId,
          (text) => broadcastResponse(text, providerId),
          abort,
        );
        source = broadcastCover(providerId, item);
      }
      source ??= storedSource;
      if (!source) throw new PreviewError('preview_not_found');
      const setting = 'preview.cover-source.' + providerId;
      const version = versions.get(id) ?? (await options.archive.getSetting?.(setting));
      if (previous && previewImageType(previous) && version === source) {
        versions.set(id, source);
        save(key, previous, 15000, true);
        return previous;
      }
      let bytes: Uint8Array;
      try {
        bytes = await coverHttp.bytes(source, { signal: abort, maxBytes: 512 * 1024 });
        if (!previewImageType(bytes)) throw new PreviewError('preview_failed');
      } catch (error) {
        if (abort.aborted || previous || !storedSource || storedSource === source) throw error;
        // The first live snapshot can be unavailable while the CDN is catching up.
        // The list's real preview is a verified alternative, never a square avatar.
        failCover(id, qualification);
        reportCoverFailure(error, source);
        primaryFailed = true;
        source = storedSource;
        bytes = await coverHttp.bytes(source, { signal: abort, maxBytes: 512 * 1024 });
      }
      if (!previewImageType(bytes)) throw new PreviewError('preview_failed');
      if (await coverDisk?.put(key, bytes)) await options.archive.setSetting?.(setting, source);
      versions.set(id, source);
      save(key, bytes, 15000, true);
      if (!primaryFailed) coverFailures.delete(id);
      return bytes;
    } catch (error) {
      if (abort.aborted) throw new PreviewError('preview_cancelled');
      if (!cooling) {
        if (!primaryFailed) failCover(id, qualification);
        reportCoverFailure(error, source);
      }
      if (previous && previewImageType(previous)) return previous;
      throw new PreviewError('preview_not_found');
    }
  };
  const downloadCover = (id: string, signal?: AbortSignal): Promise<Uint8Array> =>
    run(networkLane, signal, (abort) => fetchCover(id, abort, true));
  const renderSnapshot = (
    id: string,
    at: number,
    signal?: AbortSignal,
    toMs?: number,
    onFrame?: (end: number, mediaIds: string[]) => void,
    cacheResult = true,
    unitId?: string,
    canonical?: SnapshotItem | null,
  ): Promise<Uint8Array> =>
    run(decoderLane, signal, async (abort) => {
      await subject(id);
      if (!Number.isSafeInteger(at) || at < 0) throw new PreviewError('preview_not_found');
      if (toMs !== undefined && (!Number.isSafeInteger(toMs) || toMs <= at || toMs - at > 86460000))
        throw new PreviewError('preview_not_found');
      const unit =
        canonical === undefined ? await options.archive.snapshotUnit?.(id, at, unitId) : canonical;
      unitId ??= unit?.unitId;
      if (unit?.unitId) {
        if (at < unit.slotFromMs || at >= unit.slotToMs)
          throw new PreviewError('preview_not_found');
        toMs = Math.min(toMs ?? unit.slotToMs, unit.slotToMs);
      }
      const initial = await covering(id, at, unitId),
        key = `snapshot:${id}:${unitId ?? ''}:${at}:${toMs ?? ''}:${initial.id}`;
      if (!(await options.archive.hasMedia(ids([initial]))))
        throw new PreviewError('preview_not_found');
      const hit = cacheResult ? cached(key) : null;
      if (hit && (await options.archive.hasMedia(cache.get(key)?.mediaIds ?? []))) {
        onFrame?.(
          cache.get(key)?.throughMs ?? toMs ?? Math.min(at + 500, initial.wallEndMs!),
          cache.get(key)?.mediaIds ?? [],
        );
        return hit;
      }
      const limit = toMs ?? Math.min(at + 500, initial.wallEndMs!);
      let cursor = at;
      while (cursor < limit) {
        const selected =
          unitId && options.archive.unitSource
            ? await options.archive.unitSource(id, unitId, cursor)
            : await options.archive.locate(id, cursor, 'next');
        if (
          selected?.wallStartMs == null ||
          selected.wallEndMs == null ||
          selected.wallStartMs >= limit
        )
          break;
        const target = Math.max(cursor, selected.wallStartMs);
        const segments = [selected];
        let first = selected,
          last = selected;
        // Keep preroll inside the same continuous epoch; bound it by time and actual bytes below.
        while (
          segments.length < 599 &&
          !first.discontinuity &&
          first.wallStartMs !== null &&
          first.wallStartMs > 0 &&
          target - first.wallStartMs < 15000
        ) {
          const previous = await options.archive.locate(id, first.wallStartMs - 1, 'report');
          if (
            !previous ||
            previous.id === first.id ||
            previous.sourceEpoch !== first.sourceEpoch ||
            previous.initObjectId !== first.initObjectId ||
            previous.wallStartMs === null ||
            previous.wallEndMs !== first.wallStartMs ||
            target - previous.wallStartMs > 15000
          )
            break;
          segments.unshift(previous);
          first = previous;
        }
        // One following fragment flushes delayed decoder frames. Do not verify
        // the entire minute before asking for its first image; an empty attempt
        // advances to the next island below, retaining complete minute coverage.
        while (
          last.id === selected.id &&
          segments.length < 599 &&
          last.wallEndMs !== null &&
          last.wallEndMs < limit
        ) {
          const next =
            unitId && options.archive.unitSource
              ? await options.archive.unitSource(id, unitId, last.wallEndMs)
              : await options.archive.locate(id, last.wallEndMs, 'report');
          if (
            !next ||
            next.id === last.id ||
            next.discontinuity ||
            next.sourceEpoch !== last.sourceEpoch ||
            next.initObjectId !== last.initObjectId ||
            next.wallStartMs !== last.wallEndMs
          )
            break;
          segments.push(next);
          last = next;
        }
        let paths: string[] = [],
          usable = false;
        while (segments.length) {
          paths = [];
          let total = 0;
          usable = true;
          for (const objectId of ids(segments)) {
            const object = await options.archive.media(objectId);
            if (
              !object ||
              object.bytes >
                (objectId === selected.initObjectId ? 2 * 1024 * 1024 : 16 * 1024 * 1024) ||
              total + object.bytes > 24 * 1024 * 1024
            ) {
              usable = false;
              break;
            }
            total += object.bytes;
            paths.push(object.path);
          }
          if (usable) break;
          if (segments[0].id !== selected.id) segments.shift();
          else if (segments.length > 1) segments.pop();
          else break;
        }
        first = segments[0]!;
        last = segments.at(-1)!;
        if (usable) {
          const start = first.wallStartMs!,
            end = Math.min(limit, last.wallEndMs!);
          const emptyKey = JSON.stringify([id, target, start, end, ids(segments)]),
            emptyUntil = emptyWindows.get(emptyKey);
          let bytes: Uint8Array | undefined;
          if (emptyUntil === undefined || emptyUntil <= now()) {
            emptyWindows.delete(emptyKey);
            try {
              bytes = await decode({
                paths,
                offsetSeconds: (target - start) / 1000,
                endSeconds: (end - start) / 1000,
                signal: abort,
              });
            } catch (error) {
              if (abort.aborted) throw error;
              if (!(error instanceof SnapshotDecodeError) || error.code !== 'no_frame') {
                const code = error instanceof SnapshotDecodeError ? error.code : 'failed';
                console.warn(`Snapshot decoder error: ${code}`);
                throw new PreviewError(
                  code === 'unavailable' ? 'preview_unavailable' : 'preview_failed',
                );
              }
              while (emptyWindows.size >= 96)
                emptyWindows.delete(emptyWindows.keys().next().value!);
              emptyWindows.set(emptyKey, now() + 30000);
            }
          }
          if (bytes) {
            if (
              (await covering(id, at, unitId)).id !== initial.id ||
              !(await options.archive.hasMedia(ids(segments)))
            )
              throw new PreviewError('preview_not_found');
            if (cacheResult) save(key, bytes, 30 * 60000, false, ids(segments), end);
            onFrame?.(end, ids(segments));
            return bytes;
          }
        }
        cursor = Math.max(target + 1, last.wallEndMs!);
      }
      throw new PreviewError('preview_not_found');
    });
  let screenshotJobs: Promise<ScreenshotJobs> | undefined;
  // Readers observe the published instance; opening/recovery remains heartbeat-owned.
  let readyScreenshotJobs: ScreenshotJobs | undefined;
  let screenshotOpening = false;
  let coverStartedAt: number | null = null,
    coverSucceededAt: number | null = null,
    coverUnexpectedFailures = 0;
  let screenshotRetryAt = Infinity;
  let detachScreenshotRecovery: (() => void) | undefined;
  const preview: PreviewsPort = {
    backgroundTasks: () => {
      const failed = coverFailures.size + coverUnexpectedFailures;
      const rows: BackgroundTask[] = [
        {
          id: 'cover-sync',
          group: 'sync',
          state: backgroundWork
            ? 'running'
            : failed
              ? 'retrying'
              : pendingCovers.size
                ? 'waiting'
                : options.cacheRoot
                  ? 'idle'
                  : 'disabled',
          pending: pendingCovers.size,
          failed,
          lastRunAtMs: coverStartedAt,
          lastSuccessAtMs: coverSucceededAt,
          error: failed ? 'cover_refresh_partial' : null,
          nextRunAtMs: coverFailures.size
            ? Math.min(...[...coverFailures.values()].map((value) => value.retryAt))
            : null,
        },
      ];
      if (avatars) rows.push(avatars.status());
      if (readyScreenshotJobs) rows.push(readyScreenshotJobs.maintenanceStatus());
      else if (screenshotJobs)
        rows.push({
          id: 'snapshot-maintenance',
          group: 'processing',
          state: screenshotOpening ? 'waiting' : 'retrying',
          error: screenshotOpening ? null : 'screenshot_storage_unavailable',
          detail: screenshotOpening ? 'screenshot-storage-opening' : undefined,
          nextRunAtMs: Number.isFinite(screenshotRetryAt) ? screenshotRetryAt : null,
        });
      return Promise.resolve(rows);
    },
    avatar: async (id) => {
      const bytes = await avatars?.read(id);
      if (!bytes) throw new PreviewError('preview_not_found');
      return bytes;
    },
    snapshotPages: (id, at, page = 1, limit = 30, signal, window, followLive, unitId) =>
      run(queryLane, signal, async (abort) => {
        if (!options.archive.snapshotPages) throw new PreviewError('preview_unavailable');
        return options.archive.snapshotPages(
          id,
          at,
          page,
          limit,
          window,
          followLive,
          abort,
          unitId,
        );
      }),
    cover: (id, signal, cachedOnly = false) =>
      run(coverLane, signal, async (abort) => {
        const releaseRead = await coverReadBudget.acquire(abort);
        let local: { bytes: Uint8Array; stale: boolean } | null;
        try {
          const providerId = await subject(id),
            key = `cover:${providerId}`,
            hit = cached(key);
          if (hit) local = { bytes: hit, stale: false };
          else {
            const fresh = await coverDisk?.get(key, 15000);
            if (fresh && previewImageType(fresh)) local = { bytes: fresh, stale: false };
            else {
              const stale = await coverDisk?.get(key);
              local = stale && previewImageType(stale) ? { bytes: stale, stale: true } : null;
            }
          }
        } finally {
          releaseRead();
        }
        if (local) {
          if (local.stale && !cachedOnly && !observedSources.has(id)) {
            pendingCovers.add(id);
            schedule();
          }
          return local.bytes;
        }
        if (cachedOnly) throw new PreviewError('preview_not_found');
        const releaseNetwork = await networkBudget.acquire(abort);
        try {
          return await fetchCover(id, abort);
        } finally {
          releaseNetwork();
        }
      }),
    snapshotPoint: (id, atMs, signal) =>
      run(queryLane, signal, async () => {
        if (!options.archive.snapshotUnit) throw new PreviewError('preview_unavailable');
        return options.archive.snapshotUnit(id, atMs);
      }),
    snapshot: async (id, at, signal, toMs, unitId) => {
      let canonical: SnapshotItem | null | undefined;
      if (unitId) {
        canonical = await options.archive.snapshotUnit?.(id, at, unitId);
        if (canonical?.atMs !== at) throw new PreviewError('preview_not_found');
      }
      if (!screenshotJobs) {
        if (options.cacheRoot) throw new PreviewError('preview_unavailable');
        return renderSnapshot(id, at, signal, toMs, undefined, true, unitId, canonical);
      }
      return run(imageReadLane, signal, async (abort) => {
        if (
          !Number.isSafeInteger(at) ||
          at < 0 ||
          (toMs !== undefined &&
            (!Number.isSafeInteger(toMs) || toMs <= at || toMs - at > 86460000))
        )
          throw new PreviewError('preview_not_found');
        if (canonical === undefined)
          canonical = await options.archive.snapshotUnit?.(id, at, unitId);
        unitId ??= canonical?.unitId;
        const initial = await covering(id, at, unitId);
        if (!(await options.archive.hasMedia(ids([initial]))))
          throw new PreviewError('preview_not_found');
        const jobs = await screenshotJobs!;
        if (abort.aborted) throw new PreviewError('preview_cancelled');
        const end = toMs ?? Math.min(at + 500, initial.wallEndMs!),
          hit = await jobs.read(id, at, end, unitId);
        if (hit) return hit;
        if (canonical?.atMs !== at || (await jobs.hasCompleted(id, at, unitId)))
          return renderSnapshot(id, at, abort, toMs, undefined, true, unitId, canonical);
        await jobs.enqueue(id, canonical, SNAPSHOT_REQUEST_PRIORITY);
        throw new PreviewError('preview_pending');
      });
    },
    jobs: () => {
      if (readyScreenshotJobs) return Promise.resolve(readyScreenshotJobs.status());
      return Promise.resolve(
        screenshotJobs
          ? {
              mode: screenshotOpening ? 'initializing' : 'unavailable',
              pending: 0,
              failed: 0,
              completed: 0,
              averageMs: 0,
              error: screenshotOpening ? undefined : 'screenshot_storage_unavailable',
            }
          : null,
      );
    },
    observeCover: (id, source) => {
      if (closed || !coverDisk || !/^stripchat:[1-9]\d*$/.test(id)) return;
      const safe = coverSource(source);
      if (
        observedSources.has(id) &&
        observedSources.get(id) === safe &&
        (safe === null ? versions.has(id) : versions.get(id) === safe)
      )
        return;
      observedSources.set(id, safe);
      pendingCovers.add(id);
      schedule();
    },
    warmCovers: async (subjects) => {
      if (closed || !coverDisk) return;
      let ids = subjects;
      if (!ids) {
        ids = [];
        // Startup only fills holes. Existing live images wait for a real status
        // observation instead of briefly reverting to an older list preview.
        for (const row of await options.archive.listSubjects()) {
          const bytes = await coverDisk.get(`cover:${row.providerId}`);
          if (!bytes || !previewImageType(bytes)) ids.push(row.id);
        }
      }
      if (closed) return;
      const done = Promise.all(
        [...new Set(ids)].slice(0, 2048).map((id) => {
          pendingCovers.add(id);
          return new Promise<void>((resolve) => {
            const waiters = warmWaiters.get(id) ?? new Set<() => void>();
            waiters.add(resolve);
            warmWaiters.set(id, waiters);
          });
        }),
      ).then(() => undefined);
      backgroundTimer?.ref();
      schedule();
      return done;
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      if (!options.sites) sites.close();
      detachScreenshotRecovery?.();
      clearTimeout(backgroundTimer);
      pendingCovers.clear();
      for (const waiters of warmWaiters.values()) for (const resolve of waiters) resolve();
      warmWaiters.clear();
      observedSources.clear();
      versions.clear();
      for (const task of tasks) task.controller.abort();
      cache.clear();
      emptyWindows.clear();
      used = 0;
      closing = Promise.allSettled(
        [...tasks]
          .map((task) => task.done)
          .concat(
            backgroundWork ?? [],
            screenshotJobs ? screenshotJobs.then((jobs) => jobs.close()) : [],
          ),
      ).then(async () => {
        try {
          await coverDisk?.close();
          await avatars?.close();
        } finally {
          coverFailures.clear();
          coverDiagnostics.close();
        }
      });
      return closing;
    },
  };
  const pendingCovers = new Set<string>();
  const warmWaiters = new Map<string, Set<() => void>>();
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined,
    backgroundWork: Promise<void> | undefined;
  const schedule = (): void => {
    if (closed || backgroundTimer || backgroundWork) return;
    if (!pendingCovers.size) {
      return;
    }
    backgroundTimer = setTimeout(() => {
      backgroundTimer = undefined;
      const ids = [...pendingCovers].slice(0, options.networkConcurrency ?? 2);
      coverStartedAt = now();
      coverUnexpectedFailures = 0;
      for (const id of ids) {
        pendingCovers.delete(id);
      }
      const download = () => Promise.allSettled(ids.map((id) => downloadCover(id)));
      backgroundWork = (options.archive.withBackgroundReads?.(download) ?? download())
        .then((results) => {
          for (const id of ids) {
            for (const resolve of warmWaiters.get(id) ?? []) resolve();
            warmWaiters.delete(id);
          }
          for (const result of results) {
            if (result.status !== 'rejected' || closed) continue;
            // fetchCover owns source failures. Preserve diagnostics for admission,
            // subject/RPC failures before it enters that boundary; deleted subjects
            // and caller cancellation are normal, not background I/O failures.
            if (
              result.reason instanceof PreviewError &&
              ['preview_not_found', 'preview_cancelled'].includes(result.reason.code)
            )
              continue;
            coverDiagnostics.record(
              'cover_background_failed',
              result.reason instanceof Error
                ? (result.reason.cause ?? result.reason)
                : result.reason,
            );
            coverUnexpectedFailures++;
          }
          if (!coverFailures.size && !coverUnexpectedFailures && !closed) coverSucceededAt = now();
        })
        .finally(() => {
          backgroundWork = undefined;
          schedule();
        });
    }, 20);
    // Explicit synchronization callers own this work until their images settle.
    if (!warmWaiters.size) backgroundTimer.unref();
  };
  function openScreenshotStorage(): void {
    if (closed || !options.cacheRoot || !options.archive.snapshotUnit) return;
    screenshotRetryAt = Infinity;
    screenshotOpening = true;
    screenshotJobs = ScreenshotJobs.open({
      root: path.join(options.cacheRoot, 'screenshots'),
      mediaRoot: options.mediaRoot,
      archive: options.archive,
      canGenerate: options.canGenerate,
      concurrency: options.decoderConcurrency,
      render: async (job, signal) => {
        let throughMs = job.end,
          mediaIds: string[] = [];
        const bytes = await renderSnapshot(
          job.subject,
          job.at,
          signal,
          job.end,
          (end, dependencies) => {
            throughMs = end;
            mediaIds = dependencies;
          },
          false,
          job.unit,
        );
        return { bytes, throughMs, mediaIds };
      },
      validate:
        options.validateSnapshot ??
        ((bytes, signal) => verifyJpeg(bytes, signal, { ffmpegPath: options.ffmpegPath })),
    });
    void screenshotJobs.then(
      (jobs) => {
        readyScreenshotJobs = jobs;
        screenshotOpening = false;
      },
      (error: unknown) => {
        screenshotOpening = false;
        screenshotRetryAt = now() + 30000;
        console.error(
          'Screenshot jobs unavailable; retry in 30s',
          error instanceof Error ? error.name : 'unknown',
        );
      },
    );
  }
  function retryScreenshotStorage(): void {
    if (!closed && now() >= screenshotRetryAt) openScreenshotStorage();
  }
  if (options.cacheRoot && options.archive.snapshotUnit) {
    openScreenshotStorage();
    detachScreenshotRecovery = options.clock?.subscribe(
      'screenshot-storage-recovery',
      retryScreenshotStorage,
    );
  }
  if (options.cacheRoot)
    void preview
      .warmCovers?.()
      .catch((error) =>
        console.warn(
          'Cover startup warming failed',
          error instanceof Error ? error.name : 'unknown',
        ),
      );
  return preview;
}
