import { randomUUID } from 'node:crypto';
import type { LivePlaybackResponse, LiveProgress } from '@st-vault/api-schema';
import type { ArchivePort, ProviderPort } from '../ports.js';
import type { LiveSourceOptions } from '../provider/live-source.js';
import { createIngressHub, PublicStreamError } from '../ingest/index.js';
import type { IngressHub, IngressLease, IngressSnapshot } from '../ingest/index.js';
import { MediaBudget } from '../provider/media-budget.js';
import { waitFor } from '../provider/http.js';

export class LiveError extends Error {
  constructor(
    readonly code:
      'live_not_public' | 'live_not_found' | 'live_busy' | 'live_unavailable' | 'live_cancelled',
    readonly reason?: LiveProgress['reason'],
  ) {
    super(code);
  }
}
export interface LiveProxy {
  progress?(owner: string, subjectId: string): LiveProgress | null;
  subscribe?(listener: () => void): () => void;
  create(
    owner: string,
    subjectId: string,
    signal?: AbortSignal,
    previousSessionId?: string,
  ): Promise<LivePlaybackResponse>;
  manifest(owner: string, id: string, signal?: AbortSignal): Promise<string>;
  media(
    owner: string,
    id: string,
    token: string,
    deliver: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
  destroy(owner: string, id: string): Promise<void>;
  destroyOwner(owner: string): Promise<void>;
  close(): Promise<void>;
}
export interface LiveProxyOptions extends LiveSourceOptions {
  archive: Pick<ArchivePort, 'getSubject'>;
  provider: Pick<ProviderPort, 'status'>;
  ingress?: IngressHub;
  idleMs?: number;
  maxSessions?: number;
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxOwnerSessions?: number;
  maxRequests?: number;
  openConcurrency?: number;
  manifestConcurrency?: number;
  mediaConcurrency?: number;
}
interface Asset {
  url: string;
  init: boolean;
}
interface Session {
  subjectId: string;
  id: string;
  owner: string;
  providerId: number;
  lease?: IngressLease;
  source?: IngressSnapshot;
  controller: AbortController;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  assets: Map<string, Asset>;
  byUrl: Map<string, string>;
  notPublic?: 'offline' | 'private' | 'status-unknown';
  mediaSlots: MediaBudget;
}
function publicStopReason(error: unknown): NonNullable<Session['notPublic']> {
  if (error instanceof PublicStreamError)
    return error.publicStatus === 'PRIVATE'
      ? 'private'
      : error.publicStatus === 'OFFLINE'
        ? 'offline'
        : 'status-unknown';
  if (error instanceof LiveError && (error.reason === 'offline' || error.reason === 'private'))
    return error.reason;
  return 'status-unknown';
}
interface Job {
  controller: AbortController;
  done: Promise<unknown>;
  session: Session;
}
interface ActualTask {
  session: Session;
  done: Promise<unknown>;
}
export function createLiveProxy(options: LiveProxyOptions): LiveProxy {
  const now = options.now ?? Date.now,
    idleMs = options.idleMs ?? 90000,
    maxSessions = options.maxSessions ?? 8,
    maxOwnerSessions = options.maxOwnerSessions ?? 2,
    maxRequests = options.maxRequests ?? 24,
    requestTimeoutMs = options.requestTimeoutMs ?? 30000,
    openTimeoutMs = options.openTimeoutMs ?? 180000;
  if (
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 1024 ||
    !Number.isSafeInteger(maxOwnerSessions) ||
    maxOwnerSessions < 1 ||
    maxOwnerSessions > 1024 ||
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 4096 ||
    [idleMs, requestTimeoutMs, openTimeoutMs].some((value) => !Number.isFinite(value) || value < 1)
  )
    throw new Error('INVALID_LIVE_OPTIONS');
  const ingress = options.ingress ?? createIngressHub(options),
    sessions = new Map<string, Session>(),
    jobs = new Set<Job>();
  const actualTasks = new Set<ActualTask>();
  // Keep the final cause briefly after releasing media resources, so the UI can
  // read it even when the failing manifest request has already closed the session.
  const finalProgress = new Map<
    string,
    { owner: string; subjectId: string; value: LiveProgress; expires: number }
  >();
  const remember = (session: Session): void => {
    const value = ingress.progress?.(session.subjectId);
    if (value?.phase !== 'stopped' && value?.phase !== 'ended') return;
    for (const [key, item] of finalProgress) if (item.expires <= now()) finalProgress.delete(key);
    if (finalProgress.size >= 32) finalProgress.delete(finalProgress.keys().next().value!);
    finalProgress.set(session.id, {
      owner: session.owner,
      subjectId: session.subjectId,
      value,
      expires: now() + idleMs,
    });
  };
  const opening = new MediaBudget(options.openConcurrency ?? 2),
    manifests = new MediaBudget(options.manifestConcurrency ?? 4),
    mediaBudget = new MediaBudget(options.mediaConcurrency ?? 2);
  let closed = false,
    closing: Promise<void> | undefined;
  const remove = (session: Session): void => {
    remember(session);
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    clearTimeout(session.timer);
    session.controller.abort();
    session.lease?.release();
    session.assets.clear();
    session.byUrl.clear();
  };
  const touch = (session: Session, duration = idleMs): void => {
    clearTimeout(session.timer);
    session.expiresAtMs = now() + duration;
    session.timer = setTimeout(() => remove(session), duration);
    session.timer.unref();
  };
  const owned = (owner: string, id: string): Session => {
    const session = sessions.get(id);
    if (
      closed ||
      !owner ||
      session?.owner !== owner ||
      session.controller.signal.aborted ||
      now() >= session.expiresAtMs
    ) {
      if (session?.owner === owner) remove(session);
      throw new LiveError('live_not_found');
    }
    touch(session);
    return session;
  };
  const actual = <T>(session: Session, done: Promise<T>): Promise<T> => {
    const task: ActualTask = { session, done };
    actualTasks.add(task);
    void done.finally(() => actualTasks.delete(task)).catch(() => undefined);
    return done;
  };
  const drainSession = async (session: Session): Promise<void> => {
    await Promise.allSettled(
      [...actualTasks].filter((task) => task.session === session).map((task) => task.done),
    );
  };
  const run = async <T>(
    session: Session,
    budget: MediaBudget,
    duration: number,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
    local?: MediaBudget,
  ): Promise<T> => {
    if (closed || session.controller.signal.aborted || signal?.aborted)
      throw new LiveError('live_cancelled');
    if (jobs.size >= maxRequests) throw new LiveError('live_busy');
    const controller = new AbortController(),
      cancel = (): void => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    session.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, duration);
    const task = (async () => {
      // Wait for a viewer's local slot before taking shared response capacity.
      // Slow clients can retain their own pair without monopolizing other viewers.
      const releaseLocal = await local?.acquire(controller.signal);
      let release: (() => void) | undefined;
      try {
        release = await budget.acquire(controller.signal);
        return await work(controller.signal);
      } finally {
        await drainSession(session);
        release?.();
        releaseLocal?.();
      }
    })();
    const job = { controller, done: task, session };
    jobs.add(job);
    void task
      .finally(() => {
        jobs.delete(job);
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        session.controller.signal.removeEventListener('abort', cancel);
      })
      .catch(() => undefined);
    try {
      return await waitFor(task, controller.signal);
    } catch (error) {
      if (session.notPublic || (error instanceof Error && error.message === 'live_not_public')) {
        remove(session);
        throw new LiveError('live_not_public', session.notPublic ?? publicStopReason(error));
      }
      if (error instanceof LiveError) throw error;
      if (error instanceof Error && error.message === 'live-key-required')
        throw new LiveError('live_unavailable', 'keys');
      if (controller.signal.aborted)
        throw new LiveError(
          signal?.aborted ? 'live_cancelled' : 'live_unavailable',
          signal?.aborted ? undefined : 'timeout',
        );
      throw new LiveError('live_unavailable', ingress.progress?.(session.subjectId)?.reason);
    }
  };
  const load = (session: Session): IngressSnapshot => {
    if (!session.lease) throw new LiveError('live_unavailable');
    try {
      session.source = session.lease.snapshot();
      return session.source;
    } catch (error) {
      if (error instanceof Error && error.message === 'live_not_public') {
        // Preserve the cause before aborting: cancellation can win waitFor's race.
        session.notPublic = publicStopReason(error);
        remove(session);
        throw new LiveError('live_not_public', session.notPublic);
      }
      throw error;
    }
  };
  const token = (session: Session, url: string, init: boolean): string => {
    const existing = session.byUrl.get(url);
    if (existing) return existing;
    while (session.assets.size >= 256) {
      const first = session.assets.keys().next().value;
      if (first === undefined) break;
      session.byUrl.delete(session.assets.get(first)!.url);
      session.assets.delete(first);
    }
    const value = randomUUID();
    session.assets.set(value, { url, init });
    session.byUrl.set(url, value);
    return value;
  };
  return {
    progress: (owner, subjectId) =>
      [...sessions.values()].some(
        (session) => session.owner === owner && session.subjectId === subjectId,
      )
        ? (ingress.progress?.(subjectId) ?? { phase: 'queued' })
        : ([...finalProgress.values()].find(
            (item) => item.owner === owner && item.subjectId === subjectId && item.expires > now(),
          )?.value ?? null),
    subscribe: (listener) => ingress.subscribe?.(listener) ?? (() => undefined),
    create: async (owner, subjectId, signal, previousSessionId) => {
      if (closed || !owner || owner.length > 256) throw new LiveError('live_unavailable');
      if (previousSessionId) {
        const previous = sessions.get(previousSessionId);
        if (previous?.owner === owner) {
          remove(previous);
          console.info(JSON.stringify({ event: 'live_session_replaced', subjectId }));
        }
      }
      for (const [key, item] of finalProgress)
        if (item.owner === owner && item.subjectId === subjectId) finalProgress.delete(key);
      if (
        sessions.size >= maxSessions ||
        [...sessions.values()].filter((session) => session.owner === owner).length >=
          maxOwnerSessions
      ) {
        console.warn(
          JSON.stringify({
            event: 'live_admission_rejected',
            subjectId,
            reason: 'session_limit',
            sessions: sessions.size,
            ownerSessions: [...sessions.values()].filter((session) => session.owner === owner)
              .length,
          }),
        );
        throw new LiveError('live_busy');
      }
      const requestedAt = Date.now();
      console.info(JSON.stringify({ event: 'live_open_requested', subjectId }));
      const id = randomUUID(),
        session: Session = {
          subjectId,
          id,
          owner,
          providerId: 0,
          controller: new AbortController(),
          expiresAtMs: 0,
          timer: setTimeout(() => undefined, 0),
          assets: new Map(),
          byUrl: new Map(),
          mediaSlots: new MediaBudget(2),
        };
      sessions.set(id, session);
      touch(session, openTimeoutMs);
      try {
        return await run(session, opening, openTimeoutMs, signal, async (abort) => {
          const subject = await options.archive.getSubject(subjectId);
          if (!subject) throw new LiveError('live_not_found');
          session.providerId = subject.providerId;
          session.lease = await actual(
            session,
            ingress.acquire(subject, session.controller.signal),
          );
          if (session.controller.signal.aborted) {
            session.lease.release();
            throw new LiveError('live_cancelled');
          }
          const source = load(session);
          if (abort.aborted || closed) throw new LiveError('live_cancelled');
          touch(session);
          return {
            sessionId: id,
            manifestUrl: `/api/live/${id}/manifest.m3u8`,
            expiresAtMs: session.expiresAtMs,
            quality: source.quality,
          };
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'live_open_failed',
            subjectId,
            elapsedMs: Date.now() - requestedAt,
            code: error instanceof Error ? error.message : 'unknown',
          }),
        );
        remove(session);
        throw error;
      }
    },
    manifest: async (owner, id, signal) => {
      const session = owned(owner, id);
      return await run(session, manifests, requestTimeoutMs, signal, (abort) => {
        const source = load(session),
          all = source.playlist.segments,
          list = all.slice(-12),
          skipped = all.length - list.length;
        if (!list.length) throw new LiveError('live_unavailable');
        const sequence =
          source.playlist.discontinuitySequence +
          BigInt(all.slice(0, skipped).filter((segment) => segment.discontinuity).length);
        const lines = [
          '#EXTM3U',
          '#EXT-X-VERSION:7',
          `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...list.map((segment) => segment.durationSeconds)))}`,
          `#EXT-X-MEDIA-SEQUENCE:${list[0].sequence}`,
          `#EXT-X-DISCONTINUITY-SEQUENCE:${sequence}`,
        ];
        let init: string | null = null;
        for (const segment of list) {
          if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
          if (segment.initUrl && segment.initUrl !== init) {
            const value = token(session, segment.initUrl, true);
            lines.push(`#EXT-X-MAP:URI="/api/live/${id}/media/${value}.mp4"`);
            init = segment.initUrl;
          }
          if (segment.wallStartMs !== null)
            lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.wallStartMs).toISOString()}`);
          const value = token(session, segment.address, false);
          lines.push(
            `#EXTINF:${segment.durationSeconds.toFixed(6)},`,
            `/api/live/${id}/media/${value}.mp4`,
          );
        }
        if (source.playlist.ended) lines.push('#EXT-X-ENDLIST');
        if (abort.aborted) throw new LiveError('live_cancelled');
        touch(session);
        return Promise.resolve(lines.join('\n') + '\n');
      });
    },
    media: async (owner, id, assetId, deliver, signal) => {
      const session = owned(owner, id),
        asset = session.assets.get(assetId);
      if (!asset) throw new LiveError('live_not_found');
      await run(
        session,
        mediaBudget,
        requestTimeoutMs,
        signal,
        async (abort) => {
          load(session);
          const borrowed = session.lease!.retainMedia?.(asset.url);
          try {
            const bytes = borrowed?.bytes ?? session.lease!.media(asset.url);
            if (abort.aborted) throw new LiveError('live_cancelled');
            await deliver(bytes, abort);
            if (abort.aborted) throw new LiveError('live_cancelled');
            touch(session);
          } finally {
            // Socket delivery can outlive the ring frame, including abort-ignoring
            // consumers. Keep its bytes charged until the actual work settles.
            borrowed?.release();
          }
        },
        session.mediaSlots,
      );
    },
    destroy: async (owner, id) => {
      const session = owned(owner, id);
      remove(session);
      finalProgress.delete(id);
      await drainSession(session);
    },
    destroyOwner: async (owner) => {
      const ownedSessions = new Set(
        [
          ...sessions.values(),
          ...[...actualTasks].map((task) => task.session),
          ...[...jobs].map((job) => job.session),
        ].filter((session) => session.owner === owner),
      );
      for (const session of ownedSessions) remove(session);
      for (const [key, item] of finalProgress) if (item.owner === owner) finalProgress.delete(key);
      const pendingJobs = [...jobs].filter((job) => job.session.owner === owner);
      for (const job of pendingJobs) job.controller.abort();
      await Promise.allSettled(
        pendingJobs
          .map((job) => job.done)
          .concat(
            [...actualTasks]
              .filter((task) => task.session.owner === owner)
              .map((task) => task.done),
          ),
      );
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      for (const session of sessions.values()) remove(session);
      finalProgress.clear();
      for (const job of jobs) job.controller.abort();
      closing = Promise.allSettled(
        [...jobs].map((job) => job.done).concat([...actualTasks].map((task) => task.done)),
      ).then(async () => {
        if (!options.ingress) await ingress.close();
      });
      return closing;
    },
  };
}
