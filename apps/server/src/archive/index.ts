import type { UnitSeenEvidence } from '@st-vault/api-schema';
import type {
  MediaSelection,
  MediaSelectionMode,
  MediaSelectionOptions,
  MediaSelectionPatch,
  MediaSelectionResult,
} from '@st-vault/api-schema';
import type { BackgroundTask, MediaDeletionJob, MediaDeletionTarget } from '@st-vault/api-schema';
import type { PendingDeletion } from './deletion-store.js';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Metadata } from './metadata.js';
import { orphanCandidates } from './orphan-candidates.js';
import { TaskPool, TaskWakeup } from './task-pool.js';
import type {
  CoverageResponse,
  EventMeta,
  EventsResponse,
  GapPolicy,
  PublicStatus,
  RunHistoryResponse,
  Segment,
  SourceCheckpoint,
  StatusHistoryResponse,
  Subject,
  TimelineResponse,
} from '@st-vault/api-schema';
import type {
  FavoriteRemovalResult,
  MediaDeletePlan,
  MediaTimeRange,
  PersonalTimeline,
  SnapshotPagesResponse,
  SnapshotItem,
} from '@st-vault/api-schema';
import type { ArchivePort, CommitInput, MediaChange, MediaObject, SubjectInput } from '../ports.js';
import { ARCHIVE_MEDIA_BATCH_LIMIT } from '../ports.js';
import { MAX_SNAPSHOT_SELECTION, MAX_SNAPSHOT_PAGE_SIZE } from '@st-vault/api-schema';

export type ArchiveFaultPoint =
  | 'after-object-rename'
  | 'after-journal-sync'
  | 'after-index-commit'
  | 'after-tombstone-sync'
  | 'after-tombstone-commit'
  | 'after-unlink'
  | 'before-object-write'
  | 'before-journal-write'
  | 'before-unlink'
  | 'before-deletion-prepare'
  | 'before-orphan-batch';
export interface ArchiveOptions {
  root: string;
  mediaRoot?: string;
  backgroundConcurrency?: number;
  gcConcurrency?: number;
  hashConcurrency?: number;
  /** Deterministic failure injection, for isolated test archives only. */
  fault?: (point: ArchiveFaultPoint) => void | Promise<void>;
}
export interface ArchiveHandle extends ArchivePort {
  /** Bounded integrity maintenance. Pass nextCursor to continue a later batch. */
  scrub(options?: {
    limit?: number;
    delayMs?: number;
    cursor?: string;
  }): Promise<{ checked: number; nextCursor: string | null }>;
  recoveryStats(): {
    cleanStartup: boolean;
    journalRecordsRead: number;
    journalRecordsApplied: number;
    journalBytesRead: number;
    objectsVerified: number;
  };
}
export interface ObjectRecord {
  id: string;
  subjectId: string;
  filename: string;
  bytes: number;
  hash: string;
  kind: 'init' | 'fragment';
}
interface BaseRecord {
  version: 1;
  revision: number;
  subject: SubjectInput;
}
export type JournalRecord = BaseRecord &
  (
    | { kind: 'commit'; segment: Segment; objects: ObjectRecord[] }
    | { kind: 'delete'; segmentIds: string[] }
  );
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_WINDOW = 9 * 86400000;
function failure(code: string): never {
  throw new Error(code);
}
function code(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
function subjectId(id: string): number {
  if (!/^stripchat:[1-9]\d*$/.test(id)) failure('INVALID_SUBJECT_ID');
  const value = Number(id.slice(10));
  if (!Number.isSafeInteger(value)) failure('INVALID_SUBJECT_ID');
  return value;
}
function inputSubject(s: SubjectInput): void {
  if (
    subjectId(s.id) !== s.providerId ||
    typeof s.handle !== 'string' ||
    !s.handle.trim() ||
    s.handle.length > 200
  )
    failure('INVALID_SUBJECT');
  if (
    [s.previewSourceUrl, s.avatarSourceUrl].some(
      (value) => value !== undefined && (typeof value !== 'string' || value.length > 2048),
    )
  )
    failure('INVALID_SUBJECT');
}
function windowRange(from: number, to: number, bounded = true): void {
  if (
    !Number.isSafeInteger(from) ||
    from < 0 ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    (bounded && to - from > MAX_WINDOW)
  )
    failure('INVALID_TIME_WINDOW');
}
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validObject(value: unknown, id: string): value is ObjectRecord {
  if (!plain(value)) return false;
  return (
    typeof value.id === 'string' &&
    UUID.test(value.id) &&
    value.subjectId === id &&
    (value.kind === 'init' || value.kind === 'fragment') &&
    typeof value.filename === 'string' &&
    /^(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\/(?:[01]\d|2[0-3])|unlocated)\/$/.test(
      value.filename.slice(0, value.filename.lastIndexOf('/') + 1),
    ) &&
    path.posix.basename(value.filename) ===
      `${value.kind === 'init' ? 'init' : 'seg'}-${value.id}.${value.kind === 'init' ? 'mp4' : 'm4s'}` &&
    value.filename.split('/').every((part: string) => part !== '..' && !part.includes('\\')) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    value.bytes <= MAX_BYTES &&
    typeof value.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(value.hash)
  );
}
/** Files, journals and the database belong exclusively to this independent data root. */
export async function openArchive(options: ArchiveOptions): Promise<ArchiveHandle> {
  if (!options.root.trim()) failure('INVALID_ARCHIVE_ROOT');
  await mkdir(path.resolve(options.root), { recursive: true });
  const root = await realpath(path.resolve(options.root));
  // An upgrade must never silently create an empty library beside legacy data.
  try {
    await lstat(path.join(root, 'metadata.sqlite'));
    failure('LIBRARY_MIGRATION_REQUIRED');
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
  const configuredMedia = path.resolve(options.mediaRoot ?? path.join(root, 'media'));
  await mkdir(configuredMedia, { recursive: true });
  if ((await lstat(configuredMedia)).isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
  const mediaRoot = await realpath(configuredMedia);
  if (mediaRoot === root) failure('INVALID_MEDIA_ROOT');
  const metadata = new Metadata(root, undefined, mediaRoot);
  const archive = new Archive(mediaRoot, metadata, options);
  try {
    await archive.recover();
    return archive;
  } catch (error) {
    await metadata.call('close', { clean: false }).catch(() => undefined);
    await metadata.terminate();
    throw error;
  }
}

interface DeleteFilter {
  from?: number;
  to?: number;
  unlocated?: boolean;
  cutoff?: number;
  segmentIds?: string[];
  personalRevision?: number;
}

class Archive implements ArchiveHandle {
  withBackgroundReads<T>(action: () => Promise<T>): Promise<T> {
    return this.db.withBackgroundReads(action);
  }
  private favoriteWork: Promise<void> | undefined;
  private favoriteError: Error | undefined;
  private deletionWork: Promise<void> | undefined;
  private readonly deletionWakeup = new TaskWakeup();
  private orphanWork: Promise<void> | undefined;
  private unitWork: Promise<void> | undefined;
  private unitReady = false;
  private unitIndexError: Error | undefined;
  private orphanTotal = 0;
  private orphanDone = 0;
  private orphanStartedAt: number | null = null;
  private orphanFinishedAt: number | null = null;
  backgroundTasks(): Promise<BackgroundTask[]> {
    return this.run(async () => {
      const index = await this.db.read<{
        ready: boolean;
        processed: number;
        lastRunAtMs: number | null;
        lastSuccessAtMs: number | null;
      }>('unitIndexStatus');
      const library = await this.db.read<{
        checkpointing: boolean;
        checkpointFailed: boolean;
        requiresRecovery: boolean;
      }>('storageStatus');
      const favorites = await this.db.read<{ pending: number; processed: number; total: number }>(
        'favoriteMaterializationStatus',
      );
      return [
        {
          id: 'favorite-materialization',
          group: 'processing',
          state: this.favoriteError
            ? 'retrying'
            : this.favoriteWork
              ? 'running'
              : favorites.pending
                ? 'waiting'
                : 'idle',
          pending: favorites.pending,
          processed: favorites.processed,
          total: favorites.total,
          error: this.favoriteError ? 'favorite_materialization_failed' : null,
        },
        {
          id: 'library-checkpoint',
          group: 'protection',
          state: library.requiresRecovery
            ? 'error'
            : library.checkpointing
              ? 'running'
              : library.checkpointFailed
                ? 'retrying'
                : 'idle',
          error: library.requiresRecovery
            ? 'library_write_recovery_required'
            : library.checkpointFailed
              ? 'library_checkpoint_failed'
              : null,
        },
        {
          id: 'archive-index',
          group: 'processing',
          state: this.unitIndexError
            ? 'retrying'
            : index.ready
              ? 'idle'
              : this.unitWork
                ? 'running'
                : 'waiting',
          processed: index.processed,
          detail: 'index-batches',
          lastRunAtMs: index.lastRunAtMs,
          lastSuccessAtMs: index.lastSuccessAtMs,
          error: this.unitIndexError ? 'recording_unit_index_failed' : null,
        },
        {
          id: 'orphan-sweep',
          group: 'processing',
          state: this.orphanError
            ? 'retrying'
            : this.orphanWork
              ? 'running'
              : this.orphanSubjects.length
                ? 'waiting'
                : 'idle',
          processed: this.orphanDone,
          total: this.orphanTotal,
          detail: 'subject-scan',
          lastRunAtMs: this.orphanStartedAt,
          lastSuccessAtMs: this.orphanFinishedAt,
          error: this.orphanError ? 'orphan_cleanup_failed' : null,
        },
      ];
    });
  }
  private startUnitIndex(): void {
    if (this.unitReady || this.unitWork || this.closing) return;
    this.unitIndexError = undefined;
    this.unitWork = (async () => {
      // Recovery can defer the index only before this instance starts serving;
      // subsequent commits append synchronously to an already-ready index.
      while (!this.closing) {
        if (!(await this.db.call<boolean>('buildRecordingUnits', { limit: 32 }))) {
          this.unitReady = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
      }
    })()
      .catch((error) => {
        this.unitIndexError =
          error instanceof Error ? error : new Error('UNIT_INDEX_FAILED', { cause: error });
        console.error('recording_unit_index_failed', error);
      })
      .finally(() => {
        this.unitWork = undefined;
      });
  }
  private async readyUnits(): Promise<void> {
    this.startUnitIndex();
    await this.unitWork;
    if (this.unitIndexError) throw this.unitIndexError;
  }
  private orphanSubjects: string[] = [];
  private orphanError: Error | undefined;
  private closing = false;
  private poisoned = false;
  private closed: Promise<void> | null = null;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly gcWork = new Map<string, Promise<number>>();
  private readonly gcIo: TaskPool;
  private readonly backgroundPool: TaskPool;
  private readonly hashPool: TaskPool;
  private readonly backgroundConcurrency: number;
  private readonly verified = new Map<string, string>();
  private readonly mediaListeners = new Set<(change: MediaChange) => void>();
  subscribeMedia(listener: (change: MediaChange) => void): () => void {
    this.mediaListeners.add(listener);
    return () => this.mediaListeners.delete(listener);
  }
  private notifyMedia(change: MediaChange): void {
    for (const listener of this.mediaListeners) {
      try {
        listener(change);
      } catch (error) {
        // Derivative failures must be observable without changing commit success.
        console.warn(
          JSON.stringify({
            event: 'archive_media_listener_failed',
            subjectId: change.kind === 'commit' ? change.segment.subjectId : change.subjectId,
            kind: change.kind,
            error: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }
    }
  }
  private readonly recovery = {
    cleanStartup: false,
    journalRecordsRead: 0,
    journalRecordsApplied: 0,
    journalBytesRead: 0,
    objectsVerified: 0,
  };
  constructor(
    private readonly root: string,
    private readonly db: Metadata,
    private readonly options: ArchiveOptions,
  ) {
    this.backgroundConcurrency = options.backgroundConcurrency ?? 1;
    if (
      !Number.isSafeInteger(this.backgroundConcurrency) ||
      this.backgroundConcurrency < 1 ||
      this.backgroundConcurrency > 32
    )
      failure('INVALID_ARCHIVE_CONCURRENCY');
    this.gcIo = new TaskPool(options.gcConcurrency ?? 1);
    this.backgroundPool = new TaskPool(this.backgroundConcurrency);
    this.hashPool = new TaskPool(options.hashConcurrency ?? 1);
  }
  private get fault(): ArchiveOptions['fault'] {
    return this.options.fault;
  }
  private hash(bytes: Uint8Array): Promise<string> {
    // WebCrypto copies the input into bounded native work; never detach the
    // immutable buffer that the live and recording consumers still share.
    return this.hashPool.run(async () => {
      const source =
        bytes.buffer instanceof ArrayBuffer
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
      return Buffer.from(await webcrypto.subtle.digest('SHA-256', source)).toString('hex');
    });
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('ARCHIVE_CLOSED'));
    if (this.poisoned) return Promise.reject(new Error('ARCHIVE_REQUIRES_RECOVERY'));
    const operation = Promise.resolve().then(action);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
  private serial<T>(id: string, action: () => Promise<T>, accepted = false): Promise<T> {
    const schedule = async (): Promise<T> => {
      const previous = this.queues.get(id) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          if (this.poisoned) failure('ARCHIVE_REQUIRES_RECOVERY');
          return await action();
        });
      this.queues.set(id, next);
      try {
        return await next;
      } finally {
        if (this.queues.get(id) === next) this.queues.delete(id);
      }
    };
    return accepted ? schedule() : this.run(schedule);
  }
  private async directory(id: string): Promise<string> {
    const subject = path.join(this.root, 'subjects', `stripchat-${subjectId(id)}`);
    const dir = path.join(subject, 'recordings');
    for (const candidate of [path.join(this.root, 'subjects'), subject, dir]) {
      const created = await mkdir(candidate, { recursive: true });
      if ((await lstat(candidate)).isSymbolicLink() || !(await lstat(candidate)).isDirectory())
        failure('UNSAFE_ARCHIVE_PATH');
      if (created !== undefined) await this.syncDirectory(path.dirname(candidate));
    }
    return dir;
  }
  private async syncDirectory(dir: string): Promise<void> {
    // Windows does not expose POSIX directory fsync through Node. File fsync is
    // still enforced; power-loss rename durability is explicitly a platform limit.
    if (process.platform === 'win32') return;
    const file = await open(dir, constants.O_RDONLY);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private async objectPath(object: ObjectRecord): Promise<string> {
    if (!validObject(object, object.subjectId)) failure('INVALID_OBJECT_REFERENCE');
    const dir = await this.objectDirectory(object.subjectId, object.filename);
    const file = path.join(dir, path.posix.basename(object.filename));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file)
      failure('UNSAFE_MEDIA_PATH');
    return file;
  }
  private async objectDirectory(id: string, filename: string, create = false): Promise<string> {
    let dir = await this.directory(id);
    for (const part of filename.split('/').slice(0, -1)) {
      const parent = dir;
      dir = path.join(dir, part);
      if (create) {
        const created = await mkdir(dir, { recursive: false }).then(
          () => true,
          (error: unknown) => {
            if (code(error) !== 'EEXIST') throw error;
            return false;
          },
        );
        if (created) await this.syncDirectory(parent);
      }
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
    }
    return dir;
  }
  private async writeObject(
    id: string,
    bytes: Uint8Array,
    kind: ObjectRecord['kind'],
    bucket: string,
  ): Promise<ObjectRecord> {
    await this.fault?.('before-object-write');
    const objectId = randomUUID();
    const object: ObjectRecord = {
      id: objectId,
      subjectId: id,
      filename: `${bucket}/${kind === 'init' ? 'init' : 'seg'}-${objectId}.${kind === 'init' ? 'mp4' : 'm4s'}`,
      bytes: bytes.byteLength,
      hash: await this.hash(bytes),
      kind,
    };
    const dir = await this.directory(id);
    const destination = await this.objectDirectory(id, object.filename, true);
    const staging = path.join(dir, '.staging');
    await mkdir(staging, { recursive: true });
    if ((await lstat(staging)).isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
    const temporary = path.join(staging, `${objectId}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path.join(destination, path.posix.basename(object.filename)));
    await this.syncDirectory(destination);
    await this.fault?.('after-object-rename');
    return object;
  }
  async recover(): Promise<void> {
    const started = performance.now();
    const stage = (name: string): void =>
      console.info(
        JSON.stringify({
          event: 'archive_startup_stage',
          stage: name,
          elapsedMs: Math.round(performance.now() - started),
          ...this.recovery,
        }),
      );
    // Wait for the cross-process instance lock before touching archive files.
    const clean = await this.db.call<boolean>('beginSession');
    this.recovery.cleanStartup = clean;
    stage('metadata');
    const mediaRoot = path.join(this.root, 'subjects');
    const created = await mkdir(mediaRoot, { recursive: true });
    if ((await lstat(mediaRoot)).isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
    if (created !== undefined) await this.syncDirectory(this.root);
    const subjects = new Set<string>();
    for await (const entry of await opendir(mediaRoot)) {
      if (!/^stripchat-[1-9]\d*$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
      const id = `stripchat:${entry.name.slice(10)}`;
      subjects.add(id);
    }
    const storage = await this.db.read<{
      replayed: number;
      recordsRead: number;
      bytesRead: number;
    }>('storageStatus');
    this.recovery.journalRecordsApplied = storage.replayed;
    this.recovery.journalRecordsRead = storage.recordsRead;
    this.recovery.journalBytesRead = storage.bytesRead;
    stage('journals');
    // Only newly recovered objects require startup verification. Previously
    // committed objects are hash-checked on first read and by bounded scrub.
    for (;;) {
      const objects = await this.db.call<ObjectRecord[]>('unverifiedObjects');
      if (!objects.length) break;
      for (const object of objects) {
        await this.verifyObject(object);
        this.recovery.objectsVerified++;
        await this.db.call('verified', { id: object.id });
      }
    }
    for (const id of subjects) {
      await this.collect(id);
    }
    stage('recovered_objects');
    this.startUnitIndex();
    if (
      !clean ||
      (await this.db.call('settingGet', { key: 'archive.orphan-scan-pending' })) === '1'
    ) {
      await this.db.call('settingSet', { key: 'archive.orphan-scan-pending', value: '1' });
      this.orphanSubjects = [...subjects];
      this.orphanTotal = this.orphanSubjects.length;
      this.startOrphanSweep();
    }
  }
  private async verifyObject(object: ObjectRecord): Promise<void> {
    const filename = await this.objectPath(object);
    const file = await open(filename, 'r');
    try {
      const info = await file.stat();
      if (info.size !== object.bytes) failure('MEDIA_INTEGRITY_FAILED');
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        if (position > object.bytes) failure('MEDIA_INTEGRITY_FAILED');
        digest.update(buffer.subarray(0, bytesRead));
      }
      if (position !== object.bytes || digest.digest('hex') !== object.hash)
        failure('MEDIA_INTEGRITY_FAILED');
    } finally {
      await file.close();
    }
  }
  private startOrphanSweep(): void {
    if (this.orphanWork || this.closing || this.poisoned) return;
    this.orphanError = undefined;
    this.orphanStartedAt = Date.now();
    this.orphanWork = (async () => {
      while (this.orphanSubjects.length && !this.closing && !this.poisoned) {
        const id = this.orphanSubjects[0];
        if (!(await this.isolateOrphans(id))) return;
        this.orphanSubjects.shift();
        this.orphanDone++;
      }
      if (!this.closing && !this.poisoned) {
        await this.db.call('settingSet', { key: 'archive.orphan-scan-pending', value: '0' });
        console.info(JSON.stringify({ event: 'archive_orphan_sweep_complete' }));
        this.orphanFinishedAt = Date.now();
      }
    })()
      .catch((error) => {
        this.orphanError =
          error instanceof Error ? error : new Error('ORPHAN_SWEEP_FAILED', { cause: error });
        console.warn('archive_orphan_sweep_failed', error);
      })
      .finally(() => {
        this.orphanWork = undefined;
      });
  }
  private async isolateOrphans(id: string): Promise<boolean> {
    const dir = await this.directory(id);
    const orphaned = path.join(dir, '.orphaned');
    const isolate = async (source: string, name: string): Promise<void> => {
      await mkdir(orphaned, { recursive: true });
      if ((await lstat(orphaned)).isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
      await rename(source, path.join(orphaned, `${randomUUID()}-${name}`));
      await this.syncDirectory(orphaned);
    };
    for await (const batch of orphanCandidates(dir)) {
      if (this.closing || this.poisoned) return false;
      await this.fault?.('before-orphan-batch');
      if (this.closing || this.poisoned) return false;
      // Commits rename before journal/index commit. Hold their subject queue
      // while deciding whether a candidate is unowned, including staging files.
      await this.serial(
        id,
        async () => {
          const known = new Set(
            await this.db.call<string[]>('knownObjects', {
              subjectId: id,
              ids: batch.flatMap((item) => (item.objectId ? [item.objectId] : [])),
            }),
          );
          for (const item of batch) {
            if (item.objectId && known.has(item.objectId)) continue;
            try {
              const info = await lstat(item.filename);
              if (!info.isFile() || info.isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
              await isolate(item.filename, item.name);
            } catch (error) {
              // A completed commit or GC may have consumed a candidate while it
              // waited for the subject queue. Absence is already reconciled.
              if (code(error) !== 'ENOENT') throw error;
            }
          }
        },
        true,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }
  private collect(id: string): Promise<number> {
    const existing = this.gcWork.get(id);
    // The first collector accounts for bytes; joiners must not count them twice.
    if (existing) return existing.then(() => 0);
    const work = this.collectFiles(id).finally(() => this.gcWork.delete(id));
    this.gcWork.set(id, work);
    return work;
  }
  private async collectFiles(id: string): Promise<number> {
    let reclaimed = 0;
    for (;;) {
      const objects = await this.db.call<ObjectRecord[]>('pendingGc', { id });
      if (!objects.length) return reclaimed;
      const directories = new Set<string>();
      let batchFailed = false;
      const results = await Promise.allSettled(
        objects.map((object) =>
          this.gcIo.run(async () => {
            if (batchFailed) return;
            try {
              const filename = await this.objectPath(object);
              const bytes = (await stat(filename)).size;
              await this.fault?.('before-unlink');
              await unlink(filename);
              directories.add(path.dirname(filename));
              reclaimed += bytes;
              await this.fault?.('after-unlink');
            } catch (error) {
              if (code(error) !== 'ENOENT') {
                batchFailed = true;
                throw error;
              }
            }
          }),
        ),
      );
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason as unknown);
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(
          errors,
          errors[0] instanceof Error ? errors[0].message : 'ARCHIVE_GC_BATCH_FAILED',
          { cause: errors[0] },
        );
      // The tombstone journal makes unlink replayable. Persist directory changes
      // once per directory, then checkpoint the bounded batch atomically.
      for (const directory of directories) await this.syncDirectory(directory);
      await this.db.call('gcDone', { segmentIds: objects.map((object) => object.id) });
      if (this.closing) return reclaimed;
      // Release CPU/I/O scheduling between bounded batches, never a subject commit lock.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  upsertSubjects(subjects: SubjectInput[], options?: { syncAccount?: boolean }): Promise<void> {
    return this.run(async () => {
      if (subjects.length > 10000) failure('SUBJECT_BATCH_TOO_LARGE');
      subjects.forEach(inputSubject);
      await this.db.call('upsert', { subjects, syncAccount: options?.syncAccount === true });
    });
  }
  prepareAccountSubjects(subjects: SubjectInput[], generation: string): Promise<void> {
    if (!UUID.test(generation)) failure('INVALID_ACCOUNT_ACTIVATION');
    if (subjects.length > 10000) failure('SUBJECT_BATCH_TOO_LARGE');
    subjects.forEach(inputSubject);
    return this.run(() => this.db.call('prepareAccountSubjects', { subjects, generation }));
  }
  activateAccountSubjects(generation: string): Promise<void> {
    if (!UUID.test(generation)) failure('INVALID_ACCOUNT_ACTIVATION');
    return this.run(() => this.db.call('activateAccountSubjects', { generation }));
  }
  accountActivation(): Promise<string | null> {
    return this.run(() => this.db.read('accountActivation'));
  }
  discardAccountPreparation(generation: string): Promise<void> {
    if (!UUID.test(generation)) failure('INVALID_ACCOUNT_ACTIVATION');
    return this.run(() => this.db.call('discardAccountPreparation', { generation }));
  }
  listSubjects(): Promise<Subject[]> {
    return this.run(() => this.db.call('list'));
  }
  setGlobalRecording(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') failure('INVALID_POLICY');
    return this.run(() => this.db.call('globalRecording', { enabled }));
  }
  getSubject(id: string): Promise<Subject | null> {
    subjectId(id);
    return this.run(() => this.db.call('findSubject', { id }));
  }
  subjectPreview(id: string): Promise<string | null> {
    subjectId(id);
    return this.run(() => this.db.call('subjectPreview', { id }));
  }
  setPolicy(
    id: string,
    patch: { monitorEnabled?: boolean; autoRecord?: boolean },
  ): Promise<Subject> {
    return this.run(async () => {
      subjectId(id);
      if (
        (patch.monitorEnabled !== undefined && typeof patch.monitorEnabled !== 'boolean') ||
        (patch.autoRecord !== undefined && typeof patch.autoRecord !== 'boolean')
      )
        failure('INVALID_POLICY');
      return await this.db.call('policy', { id, patch });
    });
  }
  setPolicies(
    ids: string[],
    patch: { monitorEnabled?: boolean; autoRecord?: boolean },
  ): Promise<number> {
    return this.run(async () => {
      if (ids.length > 1000 || !ids.length) failure('INVALID_POLICY_BATCH');
      ids.forEach(subjectId);
      if (
        !Object.keys(patch).length ||
        (patch.monitorEnabled !== undefined && typeof patch.monitorEnabled !== 'boolean') ||
        (patch.autoRecord !== undefined && typeof patch.autoRecord !== 'boolean')
      )
        failure('INVALID_POLICY');
      return await this.db.call('policies', { ids: [...new Set(ids)], patch });
    });
  }
  setObservation(
    id: string,
    status: PublicStatus,
    observedAtMs: number,
    leaseMs = 15000,
    transitionAtMs = observedAtMs,
  ): Promise<void> {
    return this.run(async () => {
      subjectId(id);
      if (
        !['PUBLIC', 'PRIVATE', 'OFFLINE', 'UNKNOWN'].includes(status) ||
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !Number.isSafeInteger(transitionAtMs) ||
        transitionAtMs < 0 ||
        transitionAtMs > observedAtMs
      )
        failure('INVALID_OBSERVATION');
      if (
        !Number.isSafeInteger(leaseMs) ||
        leaseMs < 1000 ||
        leaseMs > 600000 ||
        !Number.isSafeInteger(observedAtMs + leaseMs)
      )
        failure('INVALID_OBSERVATION');
      await this.db.call('observation', {
        id,
        status,
        at: observedAtMs,
        leaseMs,
        transitionAt: transitionAtMs,
      });
    });
  }
  statusHistory(
    id: string,
    from: number,
    to: number,
    buckets = 240,
  ): Promise<StatusHistoryResponse> {
    return this.run(async () => {
      subjectId(id);
      windowRange(from, to);
      if (!Number.isSafeInteger(buckets) || buckets < 1 || buckets > 720)
        failure('INVALID_STATUS_HISTORY_BUCKETS');
      return await this.db.read('statusHistory', {
        id,
        from,
        to,
        buckets: Math.min(buckets, to - from),
      });
    });
  }
  events(
    options: { after?: number; before?: number; limit?: number } = {},
  ): Promise<EventsResponse> {
    return this.run(async () => {
      const { after = 0, before, limit = 100 } = options;
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        (before !== undefined &&
          (!Number.isSafeInteger(before) || before < 0 || options.after !== undefined)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        failure('INVALID_EVENT_QUERY');
      return await this.db.read('events', { eventAfter: after, eventBefore: before, limit });
    });
  }
  eventMeta(): Promise<EventMeta> {
    return this.run(() => this.db.read('eventMeta'));
  }
  ackEvents(cursor: number): Promise<EventMeta> {
    return this.run(async () => {
      if (!Number.isSafeInteger(cursor) || cursor < 0) failure('INVALID_EVENT_CURSOR');
      return await this.db.call('ackEvents', { readCursor: cursor });
    });
  }
  startRun(atMs = Date.now()): Promise<string> {
    return this.run(async () => {
      if (!Number.isSafeInteger(atMs) || atMs < 0) failure('INVALID_RUN_TIME');
      return await this.db.call('startRun', { at: atMs });
    });
  }
  heartbeatRun(runId: string, atMs = Date.now()): Promise<void> {
    return this.run(async () => {
      if (!UUID.test(runId) || !Number.isSafeInteger(atMs) || atMs < 0) failure('INVALID_RUN_TIME');
      await this.db.call('heartbeatRun', { id: runId, at: atMs });
    });
  }
  stopRun(runId: string, outcome: 'normal' | 'abnormal', atMs = Date.now()): Promise<void> {
    return this.run(async () => {
      if (
        !UUID.test(runId) ||
        !['normal', 'abnormal'].includes(outcome) ||
        !Number.isSafeInteger(atMs) ||
        atMs < 0
      )
        failure('INVALID_RUN_TIME');
      await this.db.call('stopRun', { id: runId, outcome, at: atMs });
    });
  }
  runHistory(from: number, to: number): Promise<RunHistoryResponse> {
    return this.run(async () => {
      windowRange(from, to);
      return await this.db.read('runHistory', { from, to });
    });
  }
  commit(input: CommitInput): Promise<Segment> {
    return this.serial(input.subjectId, async () => {
      subjectId(input.subjectId);
      if (
        !input.sourceEpoch ||
        input.sourceEpoch.length > 200 ||
        !/^(0|[1-9]\d{0,19})$/.test(input.sourceSequence) ||
        BigInt(input.sourceSequence) > 0xffffffffffffffffn ||
        !Number.isFinite(input.durationSeconds) ||
        input.durationSeconds < 0.001 ||
        input.durationSeconds > 86400 ||
        !(input.bytes instanceof Uint8Array) ||
        input.bytes.byteLength === 0 ||
        input.bytes.byteLength > MAX_BYTES ||
        (input.init !== null &&
          (!(input.init instanceof Uint8Array) ||
            input.init.byteLength === 0 ||
            input.init.byteLength > MAX_BYTES)) ||
        !['source-pdt', 'estimated', 'unknown'].includes(input.timeBasis) ||
        typeof input.discontinuity !== 'boolean' ||
        !(
          input.uncertaintyMs === null ||
          (Number.isFinite(input.uncertaintyMs) && input.uncertaintyMs >= 0)
        )
      )
        failure('INVALID_SEGMENT');
      const start = input.timeBasis === 'source-pdt' ? input.wallStartMs : null;
      if (
        input.timeBasis === 'source-pdt' &&
        (start === null ||
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(start + Math.round(input.durationSeconds * 1000)))
      )
        failure('INVALID_SOURCE_TIME');
      const subject = await this.db.call<Subject>('subject', { id: input.subjectId });
      const existing = await this.db.call<{ segment: Segment; deleted: boolean } | null>('source', {
        subjectId: input.subjectId,
        epoch: input.sourceEpoch,
        sequence: input.sourceSequence,
      });
      if (existing) {
        if (existing.deleted) failure('SOURCE_SEGMENT_DELETED');
        return existing.segment;
      }
      if (start !== null && start > 253402300799999) failure('INVALID_SOURCE_TIME');
      try {
        let init: ObjectRecord | null = null;
        const stamp = start === null ? null : new Date(start).toISOString();
        const bucket = stamp ? `${stamp.slice(0, 10)}/${stamp.slice(11, 13)}` : 'unlocated';
        if (input.init)
          init =
            (await this.db.call<ObjectRecord | null>('init', {
              id: input.subjectId,
              hash: await this.hash(input.init),
            })) ?? (await this.writeObject(input.subjectId, input.init, 'init', bucket));
        const media = await this.writeObject(input.subjectId, input.bytes, 'fragment', bucket);
        const segment: Segment = {
          id: media.id,
          subjectId: input.subjectId,
          sourceEpoch: input.sourceEpoch,
          sourceSequence: input.sourceSequence,
          mediaObjectId: media.id,
          initObjectId: init?.id ?? null,
          durationSeconds: input.durationSeconds,
          wallStartMs: start,
          wallEndMs: start === null ? null : start + Math.round(input.durationSeconds * 1000),
          timeBasis: input.timeBasis,
          uncertaintyMs: input.uncertaintyMs,
          discontinuity: input.discontinuity,
        };
        const revision = (await this.db.call<number>('head', { id: input.subjectId })) + 1;
        const record: JournalRecord = {
          version: 1,
          revision,
          subject: { id: subject.id, providerId: subject.providerId, handle: subject.handle },
          kind: 'commit',
          segment,
          objects: init ? [init, media] : [media],
        };
        await this.fault?.('before-journal-write');
        await this.db.call('apply', { record });
        await this.fault?.('after-journal-sync');
        await this.fault?.('after-index-commit');
        this.notifyMedia({ kind: 'commit', segment });
        return segment;
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
    });
  }
  timeline(
    id: string,
    from: number,
    to: number,
    limit = 1000,
    cursor?: string,
  ): Promise<TimelineResponse> {
    return this.run(async () => {
      subjectId(id);
      windowRange(from, to);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000) failure('INVALID_TIMELINE_LIMIT');
      return await this.db.read('timeline', { id, from, to, limit, cursor });
    });
  }
  sourceCheckpoint(id: string): Promise<SourceCheckpoint | null> {
    return this.run(async () => {
      subjectId(id);
      return await this.db.call('sourceCheckpoint', { id });
    });
  }
  snapshotPages(
    id: string,
    at: number,
    page = 1,
    limit = 30,
    window: MediaTimeRange,
    followLive = false,
    signal?: AbortSignal,
    unitId?: string,
  ): Promise<SnapshotPagesResponse> {
    return this.run(async () => {
      subjectId(id);
      if (!Number.isSafeInteger(at) || at < 0 || at >= Number.MAX_SAFE_INTEGER)
        failure('INVALID_TIME_WINDOW');
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_SNAPSHOT_PAGE_SIZE
      )
        failure('INVALID_SNAPSHOT_LIMIT');
      windowRange(window.fromMs, window.toMs);
      await this.readyUnits();
      const deadline = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000);
      for (;;) {
        deadline.throwIfAborted();
        if (!followLive) {
          while (!(await this.db.read<boolean>('prepareSnapshotLayout', { id, window }))) {
            deadline.throwIfAborted();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        try {
          return await this.db.read('snapshotPages', {
            id,
            at,
            page,
            limit,
            window,
            followLive,
            unitId,
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'SNAPSHOT_LAYOUT_STALE') throw error;
        }
      }
    });
  }
  snapshotUnit(id: string, at: number, unitId?: string): Promise<SnapshotItem | null> {
    return this.run(async () => {
      await this.readyUnits();
      subjectId(id);
      if (!Number.isSafeInteger(at) || at < 0 || at >= Number.MAX_SAFE_INTEGER)
        failure('INVALID_TIME_WINDOW');
      if (unitId && !UUID.test(unitId)) failure('INVALID_MEDIA_SELECTION');
      return await this.db.read('snapshotUnit', { id, at, unitId });
    });
  }
  markUnitsSeen(id: string, evidence: UnitSeenEvidence[]): Promise<{ changed: number }> {
    subjectId(id);
    if (
      !evidence.length ||
      evidence.length > 100 ||
      evidence.some(
        (value) => !UUID.test(value.unitId) || !Number.isSafeInteger(value.toMs) || value.toMs < 0,
      )
    )
      failure('INVALID_MEDIA_SELECTION');
    return this.serial(id, async () => {
      await this.readyUnits();
      const newest = new Map<string, UnitSeenEvidence>();
      for (const item of evidence)
        if (item.toMs > (newest.get(item.unitId)?.toMs ?? -1)) newest.set(item.unitId, item);
      return this.db.call('markUnitsSeen', { id, seenEvidence: [...newest.values()] });
    });
  }
  unitFavorites(
    id: string,
    ids: string[],
    liked: boolean,
    revision: number,
  ): Promise<PersonalTimeline & FavoriteRemovalResult> {
    subjectId(id);
    if (
      !ids.length ||
      ids.length > MAX_SNAPSHOT_SELECTION ||
      ids.some((value) => !UUID.test(value))
    )
      failure('INVALID_MEDIA_SELECTION');
    return this.serial(id, () => this.favoriteUnits(id, ids, liked, revision));
  }
  private async favoriteUnits(
    id: string,
    ids: string[],
    liked: boolean,
    revision: number,
  ): Promise<PersonalTimeline & FavoriteRemovalResult> {
    const selection = await this.prepareSelection(
      id,
      { fromMs: 0, toMs: 1 },
      'explicit',
      undefined,
      { includeUnitIds: ids },
    );
    await this.db.call('favoriteMediaSelection', {
      id,
      selectionId: selection.id,
      liked,
      personalRevision: revision,
    });
    void this.resumeFavorites().catch((error) =>
      console.warn('favorite_materialization_failed', error),
    );
    return {
      ...(await this.db.read<PersonalTimeline>('unitFavoriteQuery', { id, ids })),
      removed: ids.length,
    };
  }
  unitFavoriteQuery(id: string, ids: string[]): Promise<PersonalTimeline> {
    subjectId(id);
    if (ids.length > MAX_SNAPSHOT_SELECTION || ids.some((key) => !UUID.test(key)))
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.readyUnits();
      return this.db.read('unitFavoriteQuery', { id, ids });
    });
  }
  unitBounds(
    id: string,
    from: number,
    to: number,
  ): Promise<(MediaTimeRange & { openUnitId?: string }) | null> {
    subjectId(id);
    windowRange(from, to);
    return this.run(async () => {
      await this.readyUnits();
      return this.db.read('unitBounds', { id, from, to });
    });
  }
  unitRange(id: string, unitId: string): Promise<(MediaTimeRange & { open: boolean }) | null> {
    subjectId(id);
    if (!UUID.test(unitId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.readyUnits();
      return this.db.read('unitRange', { id, unitId });
    });
  }
  unitSource(id: string, unitId: string, at: number): Promise<Segment | null> {
    subjectId(id);
    if (!UUID.test(unitId) || !Number.isSafeInteger(at) || at < 0)
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.readyUnits();
      return this.db.read('unitSource', { id, unitId, at });
    });
  }
  snapshotForSegment(id: string, segmentId: string): Promise<SnapshotItem | null> {
    subjectId(id);
    if (!UUID.test(segmentId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.readyUnits();
      return this.db.read('snapshotForSegment', { id, segmentId });
    });
  }
  snapshotUnits(
    id: string,
    cursor?: string,
    limit = 8,
  ): Promise<{ items: SnapshotItem[]; cursor: string | null }> {
    subjectId(id);
    if ((cursor?.length ?? 0) > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.readyUnits();
      return this.db.read('snapshotUnits', { id, cursor, limit });
    });
  }
  coverage(
    id: string,
    from: number,
    to: number,
    buckets = 240,
    includeProtection = false,
  ): Promise<CoverageResponse> {
    return this.run(async () => {
      subjectId(id);
      windowRange(from, to, false);
      if (
        to - from > 31 * 86400000 ||
        !Number.isSafeInteger(buckets) ||
        buckets < 1 ||
        buckets > 720
      )
        failure('INVALID_COVERAGE_WINDOW');
      await this.readyUnits();
      return await this.db.read('coverage', {
        id,
        from,
        to,
        buckets: Math.min(buckets, to - from),
        includeProtection,
      });
    });
  }
  hasMedia(ids: string[]): Promise<boolean> {
    return this.run(async () => {
      if (ids.length > ARCHIVE_MEDIA_BATCH_LIMIT || ids.some((id) => !UUID.test(id)))
        failure('INVALID_MEDIA_BATCH');
      return await this.db.call('hasMedia', { ids: [...new Set(ids)] });
    });
  }
  locate(id: string, target: number, policy: GapPolicy): Promise<Segment | null> {
    return this.run(async () => {
      subjectId(id);
      if (
        !Number.isSafeInteger(target) ||
        target < 0 ||
        !['report', 'next', 'previous'].includes(policy)
      )
        failure('INVALID_LOCATE');
      return await this.db.call('locate', { id, target, policy });
    });
  }
  media(id: string): Promise<MediaObject | null> {
    return this.run(async () => {
      if (!UUID.test(id)) return null;
      const object = await this.db.call<ObjectRecord | null>('media', { id });
      if (!object) return null;
      try {
        const filename = await this.objectPath(object);
        const info = await stat(filename, { bigint: true });
        if (Number(info.size) !== object.bytes) failure('MEDIA_INTEGRITY_FAILED');
        const signature = `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
        if (this.verified.get(id) !== signature) {
          await this.verifyObject(object);
          if (this.verified.size >= 1024)
            this.verified.delete(this.verified.keys().next().value ?? '');
          this.verified.set(id, signature);
        }
        return { path: filename, bytes: object.bytes, contentType: 'video/mp4' };
      } catch (error) {
        if (code(error) === 'ENOENT') return null;
        throw error;
      }
    });
  }
  deleteRange(
    id: string,
    from: number,
    to: number,
  ): Promise<{ deletedSegments: number; reclaimedBytes: number }> {
    return this.removeAll(id, { from, to });
  }
  prepareMediaSelection(
    id: string,
    window: MediaTimeRange,
    mode: MediaSelectionMode,
    signal?: AbortSignal,
    options: MediaSelectionOptions = {},
  ): Promise<MediaSelection> {
    subjectId(id);
    windowRange(window.fromMs, window.toMs);
    return this.run(() => this.prepareSelection(id, window, mode, signal, options));
  }
  /** Admitted operations use this owner directly and survive graceful close. */
  private async prepareSelection(
    id: string,
    window: MediaTimeRange,
    mode: MediaSelectionMode,
    signal?: AbortSignal,
    options: MediaSelectionOptions = {},
  ): Promise<MediaSelection> {
    await this.readyUnits();
    signal?.throwIfAborted();
    const selectionId = await this.db.call<string>('beginMediaSelection', {
      id,
      window,
      selectionMode: mode,
      selectionOptions: { baseSelectionId: options.baseSelectionId },
    });
    for (const [field, values] of [
      ['includeUnitIds', options.includeUnitIds ?? []],
      ['excludeUnitIds', options.excludeUnitIds ?? []],
    ] as const) {
      for (let offset = 0; offset < values.length; offset += 256) {
        signal?.throwIfAborted();
        await this.db.call('stageSelectionPatch', {
          id,
          selectionId,
          selectionPatch: { [field]: values.slice(offset, offset + 256) },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    while (await this.db.call<boolean>('buildMediaSelection', { id, selectionId })) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal?.throwIfAborted();
    return this.db.read('mediaSelection', { id, selectionId });
  }
  favoriteMediaSelection(
    id: string,
    selectionId: string,
    liked: boolean,
    revision: number,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaSelectionResult> {
    subjectId(id);
    if (!UUID.test(selectionId)) failure('INVALID_MEDIA_SELECTION');
    return this.serial(id, async () => {
      const target = await this.forkMediaSelection(id, selectionId, patch, signal);
      signal?.throwIfAborted();
      return this.acceptFavoriteSelection(id, target, liked, revision, signal);
    });
  }
  planMediaSelectionDeletion(
    id: string,
    selectionId: string,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaDeletePlan> {
    subjectId(id);
    if (!UUID.test(selectionId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(() => this.prepareDeletion(id, selectionId, patch, signal));
  }
  private async prepareDeletion(
    id: string,
    selectionId: string,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaDeletePlan> {
    const target = await this.forkMediaSelection(id, selectionId, patch, signal);
    const planId = await this.db.call<string>('beginSelectedDeletionPlan', {
      id,
      selectionId: target,
    });
    while (await this.db.call<boolean>('buildDeletionPlan', { id: planId })) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal?.throwIfAborted();
    return this.db.read('deletionPlan', { id: planId });
  }
  planDeletion(id: string, ranges: MediaTimeRange[]): Promise<MediaDeletePlan> {
    subjectId(id);
    this.validateSelection(ranges);
    return this.run(async () => {
      await this.readyUnits();
      const planId = await this.db.call<string>('beginDeletionPlan', { id, ranges });
      while (await this.db.call<boolean>('buildDeletionPlan', { id: planId }))
        await new Promise<void>((resolve) => setImmediate(resolve));
      return this.db.call('deletionPlan', { id: planId });
    });
  }
  planUnitDeletion(id: string, ids: string[], signal?: AbortSignal): Promise<MediaDeletePlan> {
    subjectId(id);
    if (!ids.length || ids.length > MAX_SNAPSHOT_SELECTION || ids.some((key) => !UUID.test(key)))
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      const selection = await this.prepareSelection(
        id,
        { fromMs: 0, toMs: 1 },
        'explicit',
        signal,
        { includeUnitIds: ids },
      );
      return this.prepareDeletion(id, selection.id, {}, signal);
    });
  }
  private async forkMediaSelection(
    id: string,
    selectionId: string,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!patch.includeUnitIds?.length && !patch.excludeUnitIds?.length) return selectionId;
    const original = await this.db.read<MediaSelection>('mediaSelection', { id, selectionId });
    const selection = await this.prepareSelection(id, original, 'explicit', signal, {
      baseSelectionId: selectionId,
      ...patch,
    });
    return selection.id;
  }
  private async acceptFavoriteSelection(
    id: string,
    selectionId: string,
    liked: boolean,
    revision: number,
    signal?: AbortSignal,
  ): Promise<MediaSelectionResult> {
    // The same subject queue covers retention's read-and-tombstone interval.
    signal?.throwIfAborted();
    const result = await this.db.call<MediaSelectionResult>('favoriteMediaSelection', {
      id,
      selectionId,
      liked,
      personalRevision: revision,
    });
    void this.resumeFavorites().catch((error) =>
      console.warn('favorite_materialization_failed', error),
    );
    return result;
  }
  resumeFavorites(): Promise<void> {
    if (this.favoriteWork) return this.favoriteWork;
    if (this.closing || this.poisoned) return Promise.resolve();
    this.favoriteError = undefined;
    this.favoriteWork = this.withBackgroundReads(async () => {
      let previous: string[] = [];
      while (!this.closing && !this.poisoned) {
        let subjects = await this.db.read<string[]>('favoriteSubjects', {
          limit: this.backgroundConcurrency,
          excludedSubjects: previous,
        });
        if (!subjects.length && previous.length)
          subjects = await this.db.read<string[]>('favoriteSubjects', {
            limit: this.backgroundConcurrency,
          });
        previous = subjects;
        await Promise.all(
          subjects.map((id) =>
            this.backgroundPool.run(async () => {
              if (!this.closing && !this.poisoned)
                await this.db.call<boolean>('materializeFavorites', { id });
            }),
          ),
        );
        const maintenance = await this.db.call<boolean>('selectionMaintenance');
        if (!subjects.length && !maintenance) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })
      .catch((error) => {
        this.favoriteError =
          error instanceof Error
            ? error
            : new Error('FAVORITE_MATERIALIZATION_FAILED', { cause: error });
        throw error;
      })
      .finally(() => {
        this.favoriteWork = undefined;
      });
    return this.favoriteWork;
  }
  async deleteSelection(
    id: string,
    planId: string,
    personalRevision: number,
  ): Promise<MediaDeletionJob> {
    subjectId(id);
    if (!UUID.test(planId) || !Number.isSafeInteger(personalRevision) || personalRevision < 0)
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      const published = await this.db.read<MediaDeletionJob | null>('acceptedMediaDeletion', {
        id,
        planId,
      });
      const job =
        published ??
        (await this.serial(
          id,
          async () => {
            for (;;) {
              const result = await this.db.call<MediaDeletionJob | null>('enqueueMediaDeletion', {
                id,
                planId,
                personalRevision,
              });
              if (result) return result;
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          },
          true,
        ));
      this.notifyMedia({
        kind: 'delete',
        subjectId: id,
        fromMs: job.fromMs ?? 0,
        toMs: job.toMs ?? 0,
      });
      void this.resumeDeletions().catch((error) =>
        console.warn('Deletion queue unavailable', error),
      );
      return job;
    });
  }
  admitDeletion(
    id: string,
    commandId: string,
    deletionTarget: MediaDeletionTarget,
  ): Promise<MediaDeletionJob> {
    subjectId(id);
    if (!UUID.test(commandId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      const started = performance.now();
      const job = await this.db.call<MediaDeletionJob>('admitDeletionIntent', {
        id,
        commandId,
        deletionTarget,
      });
      console.info(
        JSON.stringify({
          event: 'media_deletion_admitted',
          commandId,
          subjectId: id,
          phase: job.phase,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
      this.notifyMedia({
        kind: 'delete',
        subjectId: id,
        fromMs: job.fromMs ?? deletionTarget.fromMs,
        toMs: job.toMs ?? deletionTarget.toMs,
      });
      // Schedule after the durable reply: heavy preparation is never an HTTP prerequisite.
      setImmediate(() => {
        void this.resumeDeletions().catch((error) =>
          console.warn('Deletion queue unavailable', error),
        );
      });
      return job;
    });
  }
  deletionJobs(): Promise<MediaDeletionJob[]> {
    return this.run(() => this.db.call('mediaDeletionJobs'));
  }
  resumeDeletions(): Promise<void> {
    this.deletionWakeup.notify();
    if (this.deletionWork) return this.deletionWork;
    if (this.closing || this.poisoned) return Promise.resolve();
    const work = async (): Promise<void> => {
      const active = new Map<string, Promise<void>>(),
        failures: unknown[] = [];
      try {
        while (!this.closing && !this.poisoned) {
          const epoch = this.deletionWakeup.epoch;
          if (failures.length) throw failures[0];
          while (active.size < this.backgroundConcurrency && !this.closing && !this.poisoned) {
            const excludedSubjects = [...active.keys()];
            const preparing = await this.db.read<MediaDeletionJob | null>('pendingDeletionIntent', {
              excludedSubjects,
            });
            const job =
              preparing ??
              (await this.db.call<PendingDeletion | null>('nextMediaDeletion', {
                excludedSubjects,
              }));
            if (!job) break;
            // Claiming is centralized. DB row locks end with their transaction;
            // the active subject owns the bounded execution step until it settles.
            const task = this.backgroundPool
              .run(async () => {
                if (this.closing || this.poisoned) return;
                if (preparing) await this.prepareDeletionStep(preparing);
                else await this.executeDeletionBatch(job as PendingDeletion);
              })
              .catch((error: unknown) => {
                failures.push(error);
              })
              .finally(() => active.delete(job.subjectId));
            active.set(job.subjectId, task);
          }
          if (epoch !== this.deletionWakeup.epoch) continue;
          if (!active.size) break;
          const changed = this.deletionWakeup.next(epoch);
          try {
            await Promise.race([...active.values(), changed.promise]);
          } finally {
            changed.dispose();
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        await Promise.all(active.values());
      }
      if (failures.length) throw failures[0];
    };
    this.deletionWork = this.withBackgroundReads(work).finally(() => {
      this.deletionWork = undefined;
    });
    return this.deletionWork;
  }
  private async prepareDeletionStep(pending: MediaDeletionJob): Promise<void> {
    try {
      await this.fault?.('before-deletion-prepare');
      const result = await this.db.call<MediaDeletionJob | null>('prepareDeletionIntent', {
        commandId: pending.id,
      });
      if (result && (result.phase !== pending.phase || result.state === 'failed'))
        console.info(
          JSON.stringify({
            event: 'media_deletion_phase',
            commandId: result.id,
            phase: result.phase,
            state: result.state,
            scannedUnits: result.scannedUnits,
            selectedUnits: result.selectedUnits,
            fragments: result.total,
          }),
        );
      if (result?.state === 'failed')
        this.notifyMedia({
          kind: 'delete',
          subjectId: result.subjectId,
          fromMs: result.fromMs ?? 0,
          toMs: result.toMs ?? 0,
        });
    } catch (error) {
      await this.db.call('retryDeletionIntent', { id: pending.id });
      console.warn('Deletion preparation paused for recovery', pending.id, error);
    }
  }
  private async executeDeletionBatch(job: PendingDeletion): Promise<void> {
    try {
      // Logical acceptance already retired derivatives; GC is a separate, bounded owner.
      const result = await this.remove(job.subjectId, { segmentIds: job.segmentIds }, true, false);
      await this.db.call('advanceMediaDeletion', {
        id: job.id,
        processed: job.processed + job.segmentIds.length,
        reclaimedBytes: result.reclaimedBytes,
      });
    } catch (error) {
      await this.db.call('retryMediaDeletion', { id: job.id });
      console.warn('Media deletion paused for recovery', job.id, error);
    }
  }
  private validateSelection(ranges: MediaTimeRange[]): void {
    if (
      !ranges.length ||
      ranges.length > MAX_SNAPSHOT_SELECTION ||
      // A seven-day view may expand outwards across complete source fragments.
      Math.max(...ranges.map((r) => r.toMs)) - Math.min(...ranges.map((r) => r.fromMs)) >=
        9 * 86400000 ||
      ranges.some(
        (r) =>
          !Number.isSafeInteger(r.fromMs) ||
          r.fromMs < 0 ||
          !Number.isSafeInteger(r.toMs) ||
          r.toMs <= r.fromMs ||
          r.toMs - r.fromMs > 86460000,
      )
    )
      failure('INVALID_MEDIA_SELECTION');
  }
  deleteUnlocated(id: string): Promise<{ deletedSegments: number; reclaimedBytes: number }> {
    return this.removeAll(id, { unlocated: true });
  }
  pruneBefore(cutoffMs: number): Promise<{ deletedSegments: number; reclaimedBytes: number }> {
    return this.run(async () => {
      await this.readyUnits();
      if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) failure('INVALID_PRUNE_CUTOFF');
      const subjects = await this.db.call<Subject[]>('list');
      let deletedSegments = 0,
        reclaimedBytes = 0;
      for (const subject of subjects) {
        const result = await this.removeAll(subject.id, { cutoff: cutoffMs }, true);
        deletedSegments += result.deletedSegments;
        reclaimedBytes += result.reclaimedBytes;
      }
      return { deletedSegments, reclaimedBytes };
    });
  }
  private removeAll(
    id: string,
    filter: DeleteFilter,
    accepted = false,
  ): Promise<{ deletedSegments: number; reclaimedBytes: number }> {
    const drain = async () => {
      let deletedSegments = 0,
        reclaimedBytes = 0;
      for (;;) {
        const batch = await this.remove(id, filter, true);
        deletedSegments += batch.deletedSegments;
        reclaimedBytes += batch.reclaimedBytes;
        if (!batch.deletedSegments) return { deletedSegments, reclaimedBytes };
      }
    };
    // The admitted sweep survives close, but each batch releases the subject lock
    // so new recording commits and favorite protection can take their turn.
    return accepted ? drain() : this.run(drain);
  }
  private remove(
    id: string,
    filter: DeleteFilter,
    accepted = false,
    publishChange = true,
  ): Promise<{ deletedSegments: number; reclaimedBytes: number }> {
    const publish = this.serial(
      id,
      async () => {
        subjectId(id);
        if (filter.from !== undefined && filter.to !== undefined)
          windowRange(filter.from, filter.to, false);
        const subject = await this.db.call<Subject>('subject', { id });
        if (
          filter.personalRevision !== undefined &&
          filter.personalRevision !== (await this.db.call<number>('personalRevision'))
        )
          failure('STALE_DELETE_PLAN');
        let deletedSegments = 0;
        try {
          const segmentIds = await this.db.call<string[]>('deleteBatch', { id, ...filter });
          if (segmentIds.length) {
            const revision = (await this.db.call<number>('head', { id })) + 1;
            const record: JournalRecord = {
              version: 1,
              revision,
              subject: { id: subject.id, providerId: subject.providerId, handle: subject.handle },
              kind: 'delete',
              segmentIds,
            };
            await this.fault?.('before-journal-write');
            await this.db.call('apply', { record });
            await this.fault?.('after-tombstone-sync');
            await this.fault?.('after-tombstone-commit');
            deletedSegments += segmentIds.length;
          }
        } catch (error) {
          // Only an uncertain metadata publication requires archive recovery.
          // Once the tombstone is committed, physical GC is independently retryable.
          this.poisoned = true;
          throw error;
        }
        if (deletedSegments && publishChange)
          this.notifyMedia({
            kind: 'delete',
            subjectId: id,
            fromMs: filter.from === undefined ? 0 : Math.max(0, filter.from - 86400000),
            toMs:
              filter.cutoff ??
              (filter.to === undefined ? Number.MAX_SAFE_INTEGER : filter.to + 86400000),
          });
        return deletedSegments;
      },
      accepted,
    );
    // Tombstones are final before unlink. Future commits cannot reuse retired
    // UUID objects (including init objects); they publish a new object instead.
    return publish.then(async (deletedSegments) => ({
      deletedSegments,
      reclaimedBytes: await this.collect(id),
    }));
  }
  recoveryStats(): {
    cleanStartup: boolean;
    journalRecordsRead: number;
    journalRecordsApplied: number;
    journalBytesRead: number;
    objectsVerified: number;
  } {
    return { ...this.recovery };
  }
  scrub(
    options: { limit?: number; delayMs?: number; cursor?: string } = {},
  ): Promise<{ checked: number; nextCursor: string | null }> {
    return this.run(async () => {
      const orphanError = this.orphanError;
      if (this.orphanSubjects.length) this.startOrphanSweep();
      if (orphanError) throw orphanError;
      const limit = options.limit ?? 128,
        delay = options.delayMs ?? 5;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1024 ||
        !Number.isFinite(delay) ||
        delay < 0 ||
        delay > 1000
      )
        failure('INVALID_SCRUB_OPTIONS');
      let after = options.cursor ?? '',
        checked = 0;
      while (checked < limit) {
        const objects = await this.db.call<ObjectRecord[]>('liveObjects', { after });
        if (!objects.length) return { checked, nextCursor: null };
        for (const object of objects.slice(0, limit - checked)) {
          // Tombstone may win while scrub is reading: never restore it.
          try {
            await this.verifyObject(object);
          } catch (error) {
            if (await this.db.call('media', { id: object.id })) throw error;
          }
          checked++;
          after = object.id;
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      return { checked, nextCursor: after };
    });
  }
  getSetting(key: string): Promise<string | null> {
    return this.run(() => this.db.call('settingGet', { key }));
  }
  identity(): Promise<{ instanceId: string; userId: string; timelineStartMs: number }> {
    return this.run(() => this.db.call('identity'));
  }
  personalRevision(): Promise<number> {
    return this.run(() => this.db.call('personalRevision'));
  }
  personal(id: string, from: number, to: number): Promise<PersonalTimeline> {
    subjectId(id);
    windowRange(from, to);
    return this.run(async () => {
      await this.readyUnits();
      return this.db.read('personal', { id, from, to });
    });
  }
  removeFavorite(id: string): Promise<void> {
    if (!UUID.test(id)) failure('INVALID_FAVORITE');
    return this.run(async () => {
      await this.readyUnits();
      const subject = await this.db.read<string | null>('favoriteSubject', { id });
      if (!subject) return;
      const revision = await this.db.read<number>('personalRevision');
      await this.serial(subject, () => this.favoriteUnits(subject, [id], false, revision), true);
    });
  }
  setSetting(key: string, value: string): Promise<void> {
    return this.run(async () => {
      // Per-subject settings use canonical IDs such as stripchat:123. These
      // names are bound SQL keys, never paths; slashes remain forbidden.
      if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(key) || value.length > 1024 * 1024)
        failure('INVALID_SETTING');
      await this.db.call('settingSet', { key, value });
    });
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      await Promise.allSettled([this.deletionWork, this.favoriteWork]);
      await this.orphanWork;
      await this.unitWork;
      await Promise.allSettled([...this.operations]);
      await Promise.allSettled([...this.gcWork.values()]);
      try {
        await this.db.call('close', { clean: !this.poisoned });
      } finally {
        await this.db.terminate();
      }
    })();
    return this.closed;
  }
}
