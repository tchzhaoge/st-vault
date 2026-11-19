import { randomUUID } from 'node:crypto';
import type { LiveProgress, PublicStatus, SourceCheckpoint, Subject } from '@st-vault/api-schema';
import type { CaptureSink, CommitInput, ProviderPort } from '../ports.js';
import { createLiveSource } from '../provider/live-source.js';
import type { LiveSource, LiveSourceOptions } from '../provider/live-source.js';
import type { Playlist } from '../provider/hls.js';
import { aborted, pause, ProviderError, waitFor } from '../provider/http.js';
import { MediaBudget } from '../provider/media-budget.js';
import { MemoryAdmission, type MemoryReservation } from './memory-admission.js';
import { ByteLedger } from './byte-ledger.js';
import { StatusEvidence } from '../provider/status-evidence.js';
export class PublicStreamError extends ProviderError {
  constructor(readonly publicStatus: PublicStatus) {
    super('live_not_public');
  }
}

export interface IngressSnapshot {
  playlist: Playlist;
  quality: LiveSource['quality'];
}
export interface IngressLease {
  snapshot(): IngressSnapshot;
  media(key: string): Uint8Array;
  retainMedia?(key: string): { bytes: Uint8Array; release(): void };
  release(): void;
}
export interface IngressHub {
  progress?(subjectId: string): LiveProgress | null;
  subscribe?(listener: () => void): () => void;
  acquire(subject: Subject, signal?: AbortSignal): Promise<IngressLease>;
  capture(subject: Subject, sink: CaptureSink, signal: AbortSignal): Promise<void>;
  changeCdn(): void;
  stats(): { subjects: number; retainedBytes: number; maxBytes: number };
  close(): Promise<void>;
}
export interface IngressOptions extends LiveSourceOptions {
  onCdnStopped?: (id: number) => void;
  evidence?: StatusEvidence;
  provider: Pick<ProviderPort, 'status'>;
  sourceCheckpoint?: (subjectId: string, signal?: AbortSignal) => Promise<SourceCheckpoint | null>;
  reloadMs?: number;
  publicCheckMs?: number;
  publicLeaseMs?: number;
  ringSegments?: number;
  ringBytes?: number;
  maxBytes?: number;
  recordingQueueSegments?: number;
  recordingQueueBytes?: number;
  firstSegmentDeadlineMs?: number;
  stallTimeoutMs?: number;
}
interface Frame {
  key: string;
  initKey: string | null;
  liveSequence: string;
  input: CommitInput;
  cost: number;
  committed: boolean;
  publishedOrder: number;
}
interface Recorder {
  queue: Frame[];
  bytes: number;
  error?: Error;
  wake?: () => void;
  active?: Frame;
}
interface Entry {
  progress: LiveProgress;
  publicStatus?: PublicStatus;
  subject: Subject;
  controller: AbortController;
  route: AbortController;
  refs: number;
  frames: Frame[];
  bytes: number;
  ready: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  done: Promise<void>;
  source?: LiveSource;
  error?: Error;
  ended: boolean;
  recorders: Set<Recorder>;
  initUrl: string | null;
  initKey: string | null;
  init: Uint8Array | null;
  discontinuitySequence: bigint;
  recordingRequested: boolean;
}
const MAX_SEGMENT = 16 * 1024 * 1024,
  MAX_INIT = 2 * 1024 * 1024;
const windowDeadline = (playlist: Playlist): number =>
  Math.max(
    1500,
    Math.min(
      10000,
      playlist.segments.reduce((total, segment) => total + segment.durationSeconds * 1000, 0),
    ),
  );
const transient = (error: unknown): boolean =>
  error instanceof ProviderError &&
  (error.code === 'upstream-request' ||
    error.code === 'request-deadline' ||
    error.code === 'site-deadline' ||
    (error.code === 'upstream-http' &&
      (error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        (error.status !== undefined && error.status >= 500 && error.status <= 599))));
const staleSource = (error: unknown): error is ProviderError =>
  error instanceof ProviderError &&
  error.code === 'upstream-http' &&
  [401, 403, 404, 410].includes(error.status ?? 0);
const reconnectable = (error: unknown): boolean =>
  transient(error) ||
  staleSource(error) ||
  (error instanceof ProviderError && error.code === 'live-source-unavailable' && error.retryable);

/** One upstream producer per subject. Durable commits are bounded consumers of its memory ring. */
export function createIngressHub(options: IngressOptions): IngressHub {
  const listeners = new Set<() => void>();
  const stage = (entry: Entry, progress: LiveProgress): void => {
    if (entry.progress.phase === progress.phase && entry.progress.reason === progress.reason)
      return;
    entry.progress = progress;
    console.info(JSON.stringify({ event: 'live_stage', subjectId: entry.subject.id, ...progress }));
    for (const listener of listeners) listener();
  };
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024,
    ringBytes = options.ringBytes ?? 48 * 1024 * 1024;
  const ringSegments = options.ringSegments ?? 12;
  const queueSegments = options.recordingQueueSegments ?? 16,
    queueBytes = options.recordingQueueBytes ?? 32 * 1024 * 1024;
  const reloadMs = options.reloadMs ?? 500,
    publicCheckMs = options.publicCheckMs ?? 2000;
  const publicLeaseMs = options.publicLeaseMs ?? 15000;
  const firstSegmentDeadlineMs = options.firstSegmentDeadlineMs ?? 180000,
    stallTimeoutMs = options.stallTimeoutMs ?? 60000;
  if (
    [
      maxBytes,
      ringBytes,
      ringSegments,
      queueSegments,
      queueBytes,
      reloadMs,
      publicCheckMs,
      publicLeaseMs,
      firstSegmentDeadlineMs,
      stallTimeoutMs,
    ].some((value) => !Number.isSafeInteger(value) || value < 1) ||
    maxBytes < MAX_SEGMENT + MAX_INIT ||
    ringBytes < MAX_SEGMENT + MAX_INIT
  )
    throw new Error('invalid-ingress-options');
  const sources = createLiveSource(options),
    entries = new Map<string, Entry>(),
    retained = new Set<Entry>(),
    tasks = new Set<Promise<void>>(),
    captures = new Set<Promise<void>>();
  const evidence =
    options.evidence ??
    new StatusEvidence({
      provider: options.provider,
      now: options.now,
      intervalMs: () => publicCheckMs,
      leaseMs: () => publicLeaseMs,
    });
  let closed = false,
    closing: Promise<void> | undefined;
  let publishedOrder = 0;
  const ledger = new ByteLedger();
  const holdFrame = (frame: Frame): void => {
    ledger.retain(frame.input.bytes);
    if (frame.input.init) ledger.retain(frame.input.init);
  };
  const dropFrame = (frame: Frame): void => {
    ledger.release(frame.input.bytes);
    if (frame.input.init) ledger.release(frame.input.init);
  };
  const clearRing = (entry: Entry): void => {
    entry.frames.forEach(dropFrame);
    entry.frames = [];
    entry.bytes = 0;
    if (entry.init) ledger.release(entry.init);
    entry.init = null;
  };
  const cost = (): number => ledger.bytes;
  const evict = (entry: Entry): void => {
    const frame = entry.frames.shift();
    if (frame) {
      dropFrame(frame);
      entry.bytes -= frame.cost;
      if (frame.input.discontinuity) entry.discontinuitySequence++;
    }
  };
  const room = (bytes: number): boolean => {
    // Evicting ready media cannot free an in-flight reservation. In particular,
    // preserve a recording's first frame until its durable consumer attaches.
    if (memory.reserved + bytes > maxBytes) return false;
    while (cost() + memory.reserved + bytes > maxBytes) {
      // Source PDT can rewind. Local publication order makes pressure fair
      // across producers instead of always draining the first registered room.
      let oldest: Entry | undefined;
      for (const entry of retained) {
        const head = entry.frames[0];
        if (!head || (entry.recordingRequested && !head.committed)) continue;
        if (!oldest || head.publishedOrder < oldest.frames[0].publishedOrder) oldest = entry;
      }
      if (!oldest) return false;
      evict(oldest);
    }
    return true;
  };
  const memory = new MemoryAdmission(room);
  const stopRecorder = (recorder: Recorder, error: Error, drain = false): void => {
    recorder.error ??= error;
    if (!drain) {
      recorder.queue.forEach(dropFrame);
      recorder.queue = [];
      recorder.bytes = recorder.active?.cost ?? 0;
    }
    recorder.wake?.();
    memory.changed();
  };
  const failure = (entry: Entry, error: unknown): void => {
    const first = !entry.error;
    entry.controller.abort();
    entry.error ??= error instanceof Error ? error : new ProviderError('ingress-failed');
    const code = entry.error.message;
    stage(entry, {
      phase: 'stopped',
      reason:
        code === 'live_not_public'
          ? entry.publicStatus === 'PRIVATE'
            ? 'private'
            : entry.publicStatus === 'OFFLINE'
              ? 'offline'
              : 'status-unknown'
          : code === 'public-evidence-expired' || entry.progress.phase === 'checking'
            ? 'status-unknown'
            : code.includes('deadline') || code.includes('stalled')
              ? 'timeout'
              : code === 'live-key-required'
                ? 'keys'
                : 'source',
    });
    if (first && entry.error.message !== 'cancelled')
      console.warn(
        JSON.stringify({
          event: 'live_ingress_stopped',
          subjectId: entry.subject.id,
          code: entry.error instanceof ProviderError ? entry.error.code : 'ingress-failed',
          status: entry.error instanceof ProviderError ? entry.error.status : undefined,
        }),
      );
    clearRing(entry);
    entry.reject(entry.error);
    for (const recorder of entry.recorders) stopRecorder(recorder, entry.error);
    memory.changed();
  };
  const release = (entry: Entry): void => {
    entry.refs--;
    if (entry.refs === 0) {
      entry.controller.abort();
      clearRing(entry);
      memory.changed();
      // Keep the subject reservation until actual upstream work has drained.
      void entry.done
        .finally(() => {
          retained.delete(entry);
          if (entries.get(entry.subject.id) === entry) entries.delete(entry.subject.id);
        })
        .catch(() => undefined);
    }
  };
  const produce = async (entry: Entry): Promise<void> => {
    const signal = entry.controller.signal;
    // Isolate upstream transfers by subject; viewers and recorders share this producer.
    const budget = new MediaBudget(1);
    const started = Date.now();
    let firstPublished = false,
      initialStatusMs = 0,
      sourceMs = 0;
    const retry = async <T>(
      work: () => Promise<T>,
      before?: () => Promise<void>,
      scope = signal,
      liveWindow = false,
    ): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        aborted(scope);
        await before?.();
        try {
          return await work();
        } catch (error) {
          aborted(scope);
          const pendingFragment =
            liveWindow &&
            error instanceof ProviderError &&
            error.code === 'upstream-http' &&
            [404, 410].includes(error.status ?? 0);
          if (
            (!transient(error) && !pendingFragment) ||
            (liveWindow && error instanceof ProviderError && error.code === 'request-deadline') ||
            attempt >= 2
          )
            throw error;
          // Retry the same operation without advancing the source cursor or discarding the ring.
          await pause(
            Math.max(
              250 * 2 ** attempt,
              error instanceof ProviderError ? (error.retryAfterMs ?? 0) : 0,
            ),
            scope,
          );
        }
      }
    };
    let timedOut = false;
    const stall = (): void => {
      timedOut = true;
      entry.controller.abort();
    };
    let progressTimer = setTimeout(stall, firstSegmentDeadlineMs);
    let releaseEvidence: (() => void) | undefined;
    interface Download {
      done: Promise<Uint8Array>;
      readonly networkMs: number;
      readonly queueMs: number;
      handoff(): void;
      dispose(): Promise<void>;
    }
    const downloads = new Set<Download>();
    const download = (
      url: string,
      max: number,
      timeoutMs?: number,
      parent: AbortSignal = signal,
    ): Download => {
      const controller = new AbortController(),
        scope = AbortSignal.any([signal, parent, controller.signal]);
      let held: MemoryReservation | undefined;
      let disposed = false,
        networkMs = 0,
        queueMs = 0;
      const done = retry(
        async () => {
          const queuedAt = performance.now();
          const unlock = await budget.acquire(scope);
          queueMs += performance.now() - queuedAt;
          let reservation: MemoryReservation | undefined;
          let startedAt: number | undefined;
          try {
            const waitingAt = performance.now();
            reservation = await memory.acquire(max, scope);
            queueMs += performance.now() - waitingAt;
            startedAt = performance.now();
            const bytes = await sources.bytes(url, max, scope, timeoutMs);
            reservation.resize(bytes.length);
            held = reservation;
            reservation = undefined;
            return bytes;
          } finally {
            if (startedAt !== undefined) networkMs += performance.now() - startedAt;
            reservation?.release();
            unlock();
          }
        },
        undefined,
        scope,
        true,
      );
      void done.catch(() => undefined);
      const task: Download = {
        done,
        get networkMs() {
          return networkMs;
        },
        get queueMs() {
          return queueMs;
        },
        handoff: () => {
          held?.release();
          held = undefined;
        },
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          controller.abort();
          await Promise.allSettled([done]);
          task.handoff();
          downloads.delete(task);
        },
      };
      downloads.add(task);
      return task;
    };
    try {
      let checkpoint = await waitFor(
        options.sourceCheckpoint?.(entry.subject.id, signal) ?? null,
        signal,
      );
      if (
        checkpoint &&
        (!checkpoint.epoch ||
          checkpoint.epoch.length > 200 ||
          !/^(0|[1-9]\d{0,19})$/.test(checkpoint.highestSequence) ||
          BigInt(checkpoint.highestSequence) > 0xffffffffffffffffn ||
          !(
            checkpoint.lastWallStartMs === null ||
            (Number.isSafeInteger(checkpoint.lastWallStartMs) && checkpoint.lastWallStartMs >= 0)
          ))
      )
        throw new ProviderError('invalid-source-checkpoint');
      let epoch = checkpoint?.epoch ?? randomUUID(),
        highest = -1n,
        lastWall: number | null = null,
        lastEnd: number | null = null,
        resumeFrom: number | null = null;
      let liveSequence: bigint | undefined;
      let discontinuity = false;
      const authorize = (): void => {
        const permission = evidence.snapshot(entry.subject.id);
        entry.publicStatus = permission.revocation ?? 'UNKNOWN';
        if (!evidence.public(entry.subject.id)) {
          if (permission.revocation) throw new PublicStreamError(permission.revocation);
          throw new ProviderError('public-evidence-expired');
        }
      };
      releaseEvidence = evidence.retain(entry.subject, () => {
        const permission = evidence.snapshot(entry.subject.id);
        // The first observation has not granted permission yet. acquire() owns
        // this initial decision; subsequent revocation/expiry reaches everyone.
        if (permission.lastPublicAtMs === null && !permission.revocation) return;
        try {
          authorize();
        } catch (error) {
          if (!signal.aborted) failure(entry, error);
        }
      });
      const observed = await evidence.observe(
        entry.subject,
        signal,
        options.evidence ? publicCheckMs / 2 : 0,
        'active',
      );
      if (!evidence.public(entry.subject.id)) throw new PublicStreamError(observed.status);
      authorize();
      stage(entry, { phase: 'resolving' });
      initialStatusMs = Date.now() - started;
      const representation = (source: LiveSource): string =>
        // BANDWIDTH is an estimate that can change while the same rendition continues.
        JSON.stringify([new URL(source.url).pathname, source.quality.height]);
      let previousRepresentation: string | undefined;
      let initial = true;
      let reconnects = 0,
        failedUrl: string | undefined;
      let route = entry.route,
        resolveRoute = true,
        retryDelay = 0;
      let transfer = { samples: 0, mediaMs: 0, networkMs: 0, queueMs: 0, bytes: 0 };
      let transferReportedAt = 0;
      while (!signal.aborted) {
        const nextRoute = entry.route;
        const scope = AbortSignal.any([signal, nextRoute.signal]);
        try {
          authorize();
          if (route !== nextRoute) {
            route = nextRoute;
            resolveRoute = true;
            entry.ended = false;
            discontinuity = firstPublished;
            failedUrl = undefined;
            reconnects = 0;
            retryDelay = 0;
            clearTimeout(progressTimer);
            progressTimer = setTimeout(
              stall,
              firstPublished ? stallTimeoutMs : firstSegmentDeadlineMs,
            );
          }
          if (entry.ended) {
            await pause(reloadMs, scope);
            continue;
          }
          if (retryDelay) await pause(retryDelay, scope);
          if (resolveRoute || !entry.source || failedUrl) {
            transfer = { samples: 0, mediaMs: 0, networkMs: 0, queueMs: 0, bytes: 0 };
            stage(entry, { phase: firstPublished ? 'reconnecting' : 'resolving' });
            const resolvingAt = Date.now();
            entry.source = await sources.resolve(entry.subject.providerId, scope, failedUrl, {
              preferredCdn: options.preferredCdn?.() ?? null,
            });
            resolveRoute = false;
            stage(entry, { phase: firstPublished ? 'reconnecting' : 'buffering' });
            if (!firstPublished) sourceMs += Date.now() - resolvingAt;
            if (previousRepresentation === undefined)
              entry.discontinuitySequence = entry.source.playlist.discontinuitySequence;
            failedUrl = undefined;
          } else if (!initial)
            entry.source = await retry(
              () => sources.reload(entry.source!, scope, windowDeadline(entry.source!.playlist)),
              undefined,
              scope,
              true,
            );
          const coldViewer = initial && !entry.recordingRequested;
          initial = false;
          const source = entry.source;
          // A segment can take longer than its own duration while bounded prefetch catches up.
          // Use the actual advertised retention horizon, rather than aborting useful transfers.
          const deadlineMs = windowDeadline(source.playlist);
          const nextRepresentation = representation(source);
          if (
            previousRepresentation !== undefined &&
            nextRepresentation !== previousRepresentation
          ) {
            // Renditions have independent sequence counters; archive identity must change too.
            epoch = randomUUID();
            checkpoint = null;
            highest = -1n;
            resumeFrom = lastEnd;
            lastWall = null;
            discontinuity = true;
          }
          previousRepresentation = nextRepresentation;
          const durable = checkpoint;
          // The first cached window may contain only the checkpoint PDT. Keep the
          // durable cursor independent until later PDT establishes a counter reset.
          if (
            typeof durable?.lastWallStartMs === 'number' &&
            source.playlist.segments.some(
              (segment) =>
                BigInt(segment.sequence) <= BigInt(durable.highestSequence) &&
                segment.wallStartMs !== null &&
                segment.wallStartMs > durable.lastWallStartMs!,
            )
          ) {
            epoch = randomUUID();
            checkpoint = null;
            highest = -1n;
            lastWall = null;
            resumeFrom = durable.lastWallStartMs + 1;
            discontinuity = true;
          }
          if (
            lastWall !== null &&
            source.playlist.segments.some(
              (segment) =>
                BigInt(segment.sequence) <= highest &&
                segment.wallStartMs !== null &&
                segment.wallStartMs > lastWall!,
            )
          ) {
            epoch = randomUUID();
            highest = -1n;
            lastWall = null;
            resumeFrom = null;
            checkpoint = null;
            discontinuity = true;
          }
          const incoming = coldViewer
            ? source.playlist.segments.slice(-3)
            : source.playlist.segments;
          if (coldViewer)
            entry.discontinuitySequence += BigInt(
              source.playlist.segments.slice(0, -3).filter((segment) => segment.discontinuity)
                .length,
            );
          const eligible = incoming.filter(
            (segment) =>
              BigInt(segment.sequence) > highest &&
              !(
                resumeFrom !== null &&
                segment.wallStartMs !== null &&
                segment.wallStartMs < resumeFrom
              ),
          );
          let prefetched: Download | undefined;
          try {
            for (let index = 0; index < eligible.length; index++) {
              aborted(scope);
              const segment = eligible[index];
              const sequence = BigInt(segment.sequence);
              if (
                sequence <= highest ||
                (resumeFrom !== null &&
                  segment.wallStartMs !== null &&
                  segment.wallStartMs < resumeFrom)
              )
                continue;
              // Live needs the current producer window even if an earlier recording already committed it.
              const alreadyCommitted =
                checkpoint?.epoch === epoch && sequence <= BigInt(checkpoint.highestSequence);
              const initDownload =
                segment.initUrl !== entry.initUrl && segment.initUrl
                  ? download(segment.initUrl, MAX_INIT, deadlineMs, scope)
                  : undefined;
              const current =
                prefetched ??
                download(
                  sources.segmentUrl(source, segment.address),
                  MAX_SEGMENT,
                  deadlineMs,
                  scope,
                );
              prefetched = undefined;
              const next = eligible[index + 1];
              if (next && cost() + memory.reserved + 2 * MAX_SEGMENT + MAX_INIT <= maxBytes)
                prefetched = download(
                  sources.segmentUrl(source, next.address),
                  MAX_SEGMENT,
                  deadlineMs,
                  scope,
                );
              try {
                const completed = await Promise.all([current.done, initDownload?.done]);
                let init = entry.init,
                  initKey = entry.initKey;
                if (segment.initUrl !== entry.initUrl) {
                  init = completed[1] ?? null;
                  initKey = init ? randomUUID() : null;
                }
                const bytes = completed[0];
                authorize();
                aborted(scope);
                // Transfer staged byte ownership to the ring before reserving its frame.
                current.handoff();
                initDownload?.handoff();
                liveSequence = liveSequence === undefined ? sequence : liveSequence + 1n;
                const frame: Frame = {
                  key: randomUUID(),
                  initKey,
                  liveSequence: liveSequence.toString(),
                  cost: bytes.byteLength + (init?.byteLength ?? 0),
                  committed: alreadyCommitted,
                  publishedOrder: ++publishedOrder,
                  input: {
                    subjectId: entry.subject.id,
                    sourceEpoch: epoch,
                    sourceSequence: segment.sequence,
                    init,
                    bytes,
                    durationSeconds: segment.durationSeconds,
                    wallStartMs: segment.wallStartMs,
                    timeBasis: segment.wallStartMs === null ? 'unknown' : 'source-pdt',
                    uncertaintyMs: null,
                    discontinuity:
                      segment.discontinuity ||
                      discontinuity ||
                      (highest >= 0n && sequence > highest + 1n),
                  },
                };
                if (entry.init) ledger.release(entry.init);
                entry.init = init;
                if (init) ledger.retain(init);
                entry.initKey = initKey;
                entry.initUrl = segment.initUrl;
                entry.frames.push(frame);
                holdFrame(frame);
                entry.bytes += frame.cost;
                while (entry.frames.length > ringSegments || entry.bytes > ringBytes) evict(entry);
                for (const recorder of entry.recorders) {
                  if (recorder.error || alreadyCommitted) continue;
                  if (
                    recorder.queue.length >= queueSegments ||
                    recorder.bytes + frame.cost > queueBytes
                  ) {
                    stopRecorder(recorder, new ProviderError('recording-backpressure'), true);
                    continue;
                  }
                  recorder.queue.push(frame);
                  holdFrame(frame);
                  recorder.bytes += frame.cost;
                  recorder.wake?.();
                }
                memory.changed();
                if (highest >= 0n && sequence > highest + 1n)
                  console.warn(
                    JSON.stringify({
                      event: 'live_ingress_source_gap',
                      subjectId: entry.subject.id,
                      sourceEpoch: epoch,
                      previousSequence: highest.toString(),
                      nextSequence: sequence.toString(),
                      missingSegments: (sequence - highest - 1n).toString(),
                      previousEndMs: lastEnd,
                      nextStartMs: segment.wallStartMs,
                    }),
                  );
                highest = sequence;
                lastWall = segment.wallStartMs;
                lastEnd =
                  lastWall === null ? null : lastWall + Math.round(segment.durationSeconds * 1000);
                discontinuity = false;
                reconnects = 0;
                retryDelay = 0;
                clearTimeout(progressTimer);
                progressTimer = setTimeout(stall, stallTimeoutMs);
                if (!firstPublished) {
                  firstPublished = true;
                  console.info(
                    JSON.stringify({
                      event: 'live_ingress_ready',
                      subjectId: entry.subject.id,
                      elapsedMs: Date.now() - started,
                      statusMs: initialStatusMs,
                      sourceMs,
                      height: source.quality.height,
                      bandwidth: source.quality.bandwidth,
                    }),
                  );
                }
                entry.resolve();
                stage(entry, { phase: 'ready' });
                transfer.samples++;
                transfer.mediaMs += segment.durationSeconds * 1000;
                transfer.networkMs += current.networkMs;
                transfer.queueMs += current.queueMs;
                transfer.bytes += bytes.byteLength;
                if (transfer.samples >= 3) {
                  const slow = transfer.networkMs > transfer.mediaMs * 1.5;
                  if (Date.now() - transferReportedAt >= 30000) {
                    console.info(
                      JSON.stringify({
                        event: 'live_ingress_transfer',
                        subjectId: entry.subject.id,
                        host: new URL(source.url).hostname,
                        ...transfer,
                        networkMs: Math.round(transfer.networkMs),
                        queueMs: Math.round(transfer.queueMs),
                        slow,
                      }),
                    );
                    transferReportedAt = Date.now();
                  }
                  transfer = { samples: 0, mediaMs: 0, networkMs: 0, queueMs: 0, bytes: 0 };
                }
              } finally {
                await current.dispose();
                await initDownload?.dispose();
              }
            }
          } finally {
            await prefetched?.dispose();
          }
          if (source.playlist.ended) {
            entry.ended = true;
            stage(entry, { phase: 'ended' });
            clearTimeout(progressTimer);
            // Recorders drain ENDLIST normally; retained viewer bytes still require public-state checks.
            for (const recorder of entry.recorders) recorder.wake?.();
          }
          await pause(reloadMs, scope);
        } catch (error) {
          aborted(signal);
          if (nextRoute.signal.aborted || entry.route !== nextRoute) continue;
          if (!reconnectable(error)) throw error;
          failedUrl = entry.source?.url;
          reconnects++;
          stage(entry, { phase: 'reconnecting', reason: 'network' });
          console.warn(
            JSON.stringify({
              event: 'live_reconnecting',
              subjectId: entry.subject.id,
              attempt: reconnects,
              code: error instanceof ProviderError ? error.code : 'unknown',
              status: error instanceof ProviderError ? error.status : undefined,
            }),
          );
          retryDelay = Math.min(4000, 250 * 2 ** Math.min(reconnects - 1, 4));
        }
      }
      aborted(signal);
    } catch (error) {
      failure(entry, timedOut ? new ProviderError('capture-stalled') : error);
    } finally {
      clearTimeout(progressTimer);
      releaseEvidence?.();
      options.onCdnStopped?.(entry.subject.providerId);
      await Promise.allSettled([...downloads].map((task) => task.dispose()));
    }
  };
  const acquire = async (
    subject: Subject,
    signal?: AbortSignal,
    recordingRequested = false,
  ): Promise<IngressLease> => {
    aborted(signal);
    if (closed) throw new ProviderError('ingress-closed');
    if (
      subject.id !== `stripchat:${subject.providerId}` ||
      !Number.isSafeInteger(subject.providerId) ||
      subject.providerId < 1
    )
      throw new ProviderError('invalid-subject');
    let entry = entries.get(subject.id);
    while (entry?.controller.signal.aborted) {
      await waitFor(entry.done, signal);
      if (entries.get(subject.id) === entry) entries.delete(subject.id);
      entry = entries.get(subject.id);
    }
    if (closed) throw new ProviderError('ingress-closed');
    if (!entry) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const ready = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void ready.catch(() => undefined);
      entry = {
        progress: { phase: 'checking' },
        subject,
        refs: 0,
        frames: [],
        bytes: 0,
        controller: new AbortController(),
        route: new AbortController(),
        ready,
        resolve,
        reject,
        done: Promise.resolve(),
        ended: false,
        recorders: new Set(),
        initUrl: null,
        initKey: null,
        init: null,
        discontinuitySequence: 0n,
        recordingRequested,
      };
      entries.set(subject.id, entry);
      for (const listener of listeners) listener();
      retained.add(entry);
      entry.done = produce(entry);
      tasks.add(entry.done);
      void entry.done.finally(() => tasks.delete(entry!.done)).catch(() => undefined);
    }
    entry.recordingRequested ||= recordingRequested;
    entry.refs++;
    try {
      await waitFor(entry.ready, signal);
    } catch (error) {
      release(entry);
      if (entry.refs === 0) await entry.done;
      throw error;
    }
    let released = false;
    const current = (): Entry => {
      if (released || closed) throw new ProviderError('live_not_found');
      if (entry.error) throw entry.error;
      return entry;
    };
    const readMedia = (key: string): Uint8Array => {
      const state = current();
      for (const frame of state.frames) {
        if (frame.key === key) return frame.input.bytes;
        if (frame.initKey === key && frame.input.init) return frame.input.init;
      }
      throw new ProviderError('live_not_found');
    };
    return {
      snapshot: () => {
        const state = current();
        return {
          quality: state.source!.quality,
          playlist: {
            mediaSequence: BigInt(state.frames[0]?.liveSequence ?? '0'),
            discontinuitySequence: state.discontinuitySequence,
            protectedMode: false,
            ended: state.ended,
            segments: state.frames.map((frame) => ({
              sequence: frame.liveSequence,
              address: frame.key,
              initUrl: frame.initKey,
              durationSeconds: frame.input.durationSeconds,
              wallStartMs: frame.input.wallStartMs,
              discontinuity: frame.input.discontinuity,
            })),
          },
        };
      },
      media: readMedia,
      retainMedia: (key) => {
        const bytes = readMedia(key);
        ledger.retain(bytes);
        let borrowed = true;
        return {
          bytes,
          release: () => {
            if (!borrowed) return;
            borrowed = false;
            ledger.release(bytes);
            memory.changed();
          },
        };
      },
      release: () => {
        if (!released) {
          released = true;
          release(entry);
        }
      },
    };
  };
  const record = async (
    subject: Subject,
    sink: CaptureSink,
    signal: AbortSignal,
  ): Promise<void> => {
    const lease = await acquire(subject, signal, true),
      entry = entries.get(subject.id)!;
    const recorder: Recorder = { queue: [], bytes: 0 };
    entry.recorders.add(recorder);
    try {
      for (const frame of [...entry.frames]) {
        if (frame.committed) continue;
        if (recorder.queue.length >= queueSegments || recorder.bytes + frame.cost > queueBytes) {
          stopRecorder(recorder, new ProviderError('recording-backpressure'), true);
          break;
        }
        recorder.queue.push(frame);
        holdFrame(frame);
        recorder.bytes += frame.cost;
      }
      while (true) {
        aborted(signal);
        if (entry.error) throw entry.error;
        const frame = recorder.queue.shift();
        if (!frame) {
          if (recorder.error) throw recorder.error;
          if (entry.ended) return;
          await waitFor(
            new Promise<void>((resolve) => {
              recorder.wake = resolve;
            }),
            signal,
          );
          recorder.wake = undefined;
          continue;
        }
        recorder.active = frame;
        // Only this consumer waits for disk. The producer can continue publishing live bytes.
        await sink.commit(frame.input);
        frame.committed = true;
        dropFrame(frame);
        recorder.active = undefined;
        recorder.bytes -= frame.cost;
        memory.changed();
      }
    } finally {
      entry.recorders.delete(recorder);
      recorder.queue.forEach(dropFrame);
      if (recorder.active) dropFrame(recorder.active);
      recorder.queue = [];
      recorder.bytes = 0;
      memory.changed();
      lease.release();
    }
  };
  return {
    progress: (id) => entries.get(id)?.progress ?? null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire,
    capture: (subject, sink, signal) => {
      const task = record(subject, sink, signal);
      captures.add(task);
      void task.finally(() => captures.delete(task)).catch(() => undefined);
      return task;
    },
    changeCdn: () => {
      for (const entry of entries.values()) {
        const previous = entry.route;
        entry.route = new AbortController();
        previous.abort();
      }
    },
    stats: () => ({ subjects: entries.size, retainedBytes: cost() + memory.reserved, maxBytes }),
    close: () => {
      if (closing) return closing;
      closed = true;
      for (const entry of retained) {
        entry.controller.abort();
        failure(entry, new ProviderError('ingress-closed'));
      }
      closing = Promise.allSettled([...tasks, ...captures]).then(async () => {
        entries.clear();
        retained.clear();
        if (!options.evidence) await evidence.close();
      });
      return closing;
    },
  };
}
