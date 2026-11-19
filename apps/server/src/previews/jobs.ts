import { mkdir, readFile, lstat, unlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { FileLease } from '../database/file-lease.js';
import { SqlDatabase } from '../database/sql.js';
import type { JobStatistics } from './job-statistics.js';
import path from 'node:path';
import type { SnapshotItem } from '@st-vault/api-schema';
import type { BackgroundTask } from '@st-vault/api-schema';
import type { ArchivePort } from '../ports.js';
import { jpeg } from './ffmpeg.js';
import { readJobStatistics } from './job-statistics.js';
import { initializeScreenshotSchema } from './job-schema.js';
import { AtomicDerivativeWriter } from './atomic-derivative.js';
import { DerivativeDiagnostics, ioCode } from './derivative-diagnostics.js';
import { snapshotFilePath } from '../library/paths.js';
import {
  SnapshotJobOutput,
  snapshotDigest as digest,
  validSnapshotMediaIds as validMediaIds,
} from './job-output.js';
import type { SnapshotFrame } from './job-output.js';
export type { SnapshotFrame } from './job-output.js';
export interface SnapshotJob {
  subject: string;
  unit: string;
  at: number;
  end: number;
  slot: number;
  coverage_end: number | null;
  created: number;
  priority: number;
  attempts: number;
  state: string;
  hash: string | null;
  rendered_to: number | null;
  media_ids: string | null;
  claim_token?: string | null;
}
interface Options {
  root: string;
  mediaRoot?: string;
  archive: Pick<
    ArchivePort,
    | 'listSubjects'
    | 'locate'
    | 'snapshotUnit'
    | 'subscribeMedia'
    | 'snapshotForSegment'
    | 'snapshotUnits'
  > &
    Partial<Pick<ArchivePort, 'hasMedia' | 'withBackgroundReads'>>;
  render: (job: SnapshotJob, signal: AbortSignal) => Promise<SnapshotFrame>;
  validate: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  auditMs?: number;
  concurrency?: number;
  retryMs?: number;
  canGenerate?: () => boolean;
}
export const SNAPSHOT_REQUEST_PRIORITY = 60;
const LIVE_PRIORITY = 40,
  REPAIR_PRIORITY = 50;
/** Durable derivatives queue. Recording callbacks only notify; no decoder is awaited by commit. */
export class ScreenshotJobs {
  private readonly db: SqlDatabase;
  private statistics: JobStatistics = { pending: 0, failed: 0, completed: 0, oldestCreated: null };
  private invalidationCount = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private auditTimer: ReturnType<typeof setInterval> | undefined;
  private readonly dirty = new Map<string, { first: string; last: string }>();
  private readonly current = new Map<
    string,
    { job: SnapshotJob; controller: AbortController; work: Promise<void> }
  >();
  private work: Promise<void> | undefined;
  private discoveryWork: Promise<void> | undefined;
  private wakeRequested = false;
  private readonly interrupted = new Map<string, SnapshotJob>();
  private claimError: string | null = null;
  private closed = false;
  private closing: Promise<void> | undefined;
  private invalidationWork: Promise<void> | undefined;
  private invalidationError: string | null = null;
  private invalidationRetryAt = 0;
  private invalidationFailures = 0;
  private priorityRuns = 0;
  private auditCursor: [string, number, number, string] = ['', -1, -1, ''];
  private scanIndex = 0;
  private scanAfter = 0;
  private scanRevision = 0;
  private readonly scanCooldown = new Map<string, number>();
  private stopSubscription: (() => void) | undefined;
  private averageMs = 0;
  private paused = false;
  private lastCompletedAt: number | null = null;
  private lastAuditAt: number | null = null;
  private lastAuditSuccess: number | null = null;
  private auditError: string | null = null;
  private auditFailures = 0;
  private cleanupError: string | null = null;
  private readonly diagnostics = new DerivativeDiagnostics();
  private readonly writer: AtomicDerivativeWriter;
  private readonly output: SnapshotJobOutput;
  private constructor(
    private readonly options: Options,
    db: SqlDatabase,
    private readonly lease: FileLease,
  ) {
    this.db = db;
    this.writer = options.mediaRoot
      ? new AtomicDerivativeWriter(
          path.join(options.mediaRoot, 'subjects'),
          'library',
          this.diagnostics,
          'snapshot',
        )
      : new AtomicDerivativeWriter(options.root, 'snapshot', this.diagnostics);
    this.output = new SnapshotJobOutput(
      this.writer,
      this.filename.bind(this),
      !!options.mediaRoot,
      options.validate,
    );
  }
  private async initialize(): Promise<void> {
    await initializeScreenshotSchema(this.db);
    await this.db.exec(
      "UPDATE jobs SET state='pending',due=0,claim_token=NULL WHERE state='running'",
    );
    await this.refreshStatistics();
  }
  private statisticsRefresh: Promise<void> | undefined;
  private statisticsVersion = 0;
  private statisticsApplied = 0;
  private async refreshStatistics(): Promise<void> {
    const target = ++this.statisticsVersion;
    while (this.statisticsApplied < target) {
      this.statisticsRefresh ??= (async () => {
        // Satisfy this revision without waiting for future parallel writers to
        // become idle. Their callers request a subsequent snapshot themselves.
        const revision = this.statisticsVersion;
        const [statistics, pending] = await Promise.all([
          readJobStatistics(this.db),
          this.db.prepare('SELECT COUNT(*) AS count FROM invalidations').get<{ count: number }>(),
        ]);
        this.statistics = statistics;
        this.invalidationCount = pending?.count ?? 0;
        this.statisticsApplied = revision;
      })().finally(() => {
        this.statisticsRefresh = undefined;
      });
      await this.statisticsRefresh;
    }
  }
  private async mutate<T>(work: Promise<T>): Promise<T> {
    const result = await work;
    if (!this.db.isTransaction) await this.refreshStatistics();
    return result;
  }
  static async open(options: Options): Promise<ScreenshotJobs> {
    if (
      !Number.isInteger(options.concurrency ?? 1) ||
      (options.concurrency ?? 1) < 1 ||
      (options.concurrency ?? 1) > 64
    )
      throw Error('INVALID_SCREENSHOT_CONCURRENCY');
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    if ((await lstat(options.root)).isSymbolicLink()) throw Error('UNSAFE_SCREENSHOT_ROOT');
    const lease = await FileLease.acquire(path.join(options.root, '.instance.lock'));
    let db: SqlDatabase;
    try {
      db = await SqlDatabase.open(path.join(options.root, 'jobs'));
    } catch (error) {
      await lease.close();
      throw error;
    }
    const queue = new ScreenshotJobs(options, db, lease);
    try {
      await queue.initialize();
      await queue.cleanup();
      queue.start();
      return queue;
    } catch (error) {
      queue.diagnostics.record('screenshot_open_failed', error, 'error');
      try {
        await queue.writer.close();
      } catch (cleanupError) {
        queue.diagnostics.record('screenshot_open_cleanup_failed', cleanupError, 'error');
      } finally {
        try {
          await db.close();
        } finally {
          await lease.close();
          queue.diagnostics.close();
        }
      }
      throw error;
    }
  }
  private filename(job: Pick<SnapshotJob, 'subject' | 'at' | 'end' | 'unit'>): string {
    if (this.options.mediaRoot) return snapshotFilePath(this.options.mediaRoot, job);
    if (
      !/^stripchat:[1-9]\d*$/.test(job.subject) ||
      ![job.at, job.end].every(Number.isSafeInteger) ||
      job.at < 0 ||
      job.end <= job.at ||
      job.end - job.at > 86460000
    )
      throw Error('INVALID_SCREENSHOT_JOB');
    return path.join(
      this.options.root,
      job.subject.slice(10),
      `${job.at}-${job.end}-${digest(Buffer.from(job.unit))}.jpg`,
    );
  }
  async enqueue(subject: string, item: SnapshotItem, priority = 0): Promise<void> {
    return this.enqueueItem(subject, item, priority);
  }
  private async enqueueItem(
    subject: string,
    item: SnapshotItem,
    priority: number,
    admitted = false,
  ): Promise<void> {
    if (this.closed && !admitted) return;
    if (!item.unitId) throw Error('INVALID_SCREENSHOT_UNIT');
    const job = {
      subject,
      unit: item.unitId,
      at: item.atMs,
      end: item.imageToMs ?? item.slotToMs ?? item.atMs + 500,
      slot: item.slotFromMs ?? item.atMs,
      coverage_end: item.slotToMs ?? null,
    };
    this.filename(job);
    const result = await this.mutate(
      this.db
        .prepare(
          `INSERT INTO jobs(subject,unit,at,"end",slot,coverage_end,created,priority)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(subject,unit) WHERE unit<>'' DO UPDATE SET
      priority=GREATEST(jobs.priority,excluded.priority),
      due=CASE WHEN excluded.coverage_end>coalesce(jobs.coverage_end,jobs."end") AND jobs.state='failed' THEN 0 ELSE jobs.due END,
      attempts=CASE WHEN excluded.coverage_end>coalesce(jobs.coverage_end,jobs."end") AND jobs.state='failed' THEN 0 ELSE jobs.attempts END,
      coverage_end=GREATEST(coalesce(jobs.coverage_end,excluded.coverage_end),excluded.coverage_end)
      WHERE jobs.at=excluded.at AND jobs."end"=excluded."end" AND jobs.slot=excluded.slot`,
        )
        .run(
          subject,
          job.unit,
          job.at,
          job.end,
          job.slot,
          job.coverage_end,
          Date.now(),
          Math.max(priority, 0),
        ),
    );
    if (!result.changes) throw Error('INCONSISTENT_SCREENSHOT_UNIT');
    this.schedule(0);
  }
  async hasCompleted(subject: string, at: number, unit?: string): Promise<boolean> {
    return (
      !this.closed &&
      (
        await this.db
          .prepare(
            "SELECT unit FROM jobs WHERE subject=? AND at=? AND (?::text IS NULL OR unit=?) AND state='done' LIMIT 2",
          )
          .all(subject, at, unit ?? null, unit ?? null)
      ).length === 1
    );
  }
  private async retire(rows: SnapshotJob[]): Promise<void> {
    if (!rows.length) return;
    await this.db.transaction(async () => {
      for (const row of rows) {
        await this.mutate(
          this.db
            .prepare('INSERT INTO retired VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
            .run(row.subject, row.at, row.end, row.unit),
        );
        await this.mutate(
          this.db
            .prepare('DELETE FROM jobs WHERE subject=? AND at=? AND "end"=? AND unit=?')
            .run(row.subject, row.at, row.end, row.unit),
        );
      }
    });
    await this.refreshStatistics();
    for (const active of this.current.values())
      if (rows.some((row) => this.key(row) === this.key(active.job))) active.controller.abort();
  }
  private cleanupWork: Promise<void> | undefined;
  private cleanup(): Promise<void> {
    if (this.cleanupWork) return this.cleanupWork;
    this.cleanupWork = this.background(() => this.cleanupBatch())
      .then(
        () => {
          this.cleanupError = null;
        },
        (error: unknown) => {
          this.cleanupError = 'screenshot_cleanup_failed';
          throw error;
        },
      )
      .finally(() => {
        this.cleanupWork = undefined;
      });
    return this.cleanupWork;
  }
  private async cleanupBatch(): Promise<void> {
    await this.writer.recover();
    const rows = (await this.db
      .prepare('SELECT * FROM retired LIMIT 32')
      .all()) as unknown as SnapshotJob[];
    for (const row of rows) {
      try {
        await unlink(this.filename(row));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (this.options.mediaRoot)
        try {
          await unlink(this.filename(row) + '.json');
        } catch (error) {
          if (ioCode(error) !== 'ENOENT') throw error;
        }
      await this.mutate(
        this.db
          .prepare('DELETE FROM retired WHERE subject=? AND at=? AND "end"=? AND unit=?')
          .run(row.subject, row.at, row.end, row.unit),
      );
    }
  }
  async read(subject: string, at: number, end: number, unit?: string): Promise<Uint8Array | null> {
    if (this.closed) return null;
    const rows = (await this.db
      .prepare(
        "SELECT * FROM jobs WHERE subject=? AND at=? AND state='done' AND rendered_to<=? AND (?::text IS NULL OR unit=?) ORDER BY rendered_to LIMIT 2",
      )
      .all(subject, at, end, unit ?? null, unit ?? null)) as unknown as SnapshotJob[];
    if (rows.length > 1) return null;
    for (const row of rows) {
      const bytes = await this.checked(row);
      if (
        bytes &&
        (await this.sourceExists(row)) &&
        (await this.db
          .prepare(
            'SELECT 1 FROM jobs WHERE subject=? AND at=? AND "end"=? AND unit=? AND state=\'done\'',
          )
          .get(row.subject, row.at, row.end, row.unit))
      )
        return bytes;
    }
    return null;
  }
  status(): {
    running: boolean;
    active: number;
    limit: number;
    lastCompletedAtMs: number | null;
    pending: number;
    failed: number;
    completed: number;
    mode: 'realtime' | 'catching-up' | 'paused';
    averageMs: number;
  } {
    const stats = this.statistics;
    return {
      running: this.current.size > 0,
      active: this.current.size,
      limit: this.options.concurrency ?? 1,
      lastCompletedAtMs: this.lastCompletedAt,
      pending: stats.pending,
      failed: stats.failed,
      completed: stats.completed,
      mode: this.paused
        ? 'paused'
        : stats.oldestCreated !== null && Date.now() - stats.oldestCreated > 60000
          ? 'catching-up'
          : 'realtime',
      averageMs: Math.round(this.averageMs),
    };
  }
  maintenanceStatus(): BackgroundTask {
    const writer = this.writer.status();
    const pending = this.closed ? 0 : this.invalidationCount;
    const error =
      this.claimError ??
      this.invalidationError ??
      this.auditError ??
      this.cleanupError ??
      (writer.error ? 'screenshot_cleanup_failed' : null);
    return {
      id: 'snapshot-maintenance',
      group: 'processing',
      state: error
        ? 'retrying'
        : this.invalidationWork || this.auditWork || this.cleanupWork || writer.recovering
          ? 'running'
          : writer.pending || pending
            ? 'waiting'
            : 'idle',
      pending,
      lastRunAtMs: this.lastAuditAt,
      lastSuccessAtMs: this.lastAuditSuccess,
      nextRunAtMs: this.invalidationError ? this.invalidationRetryAt : writer.retryAtMs,
      error,
      detail: writer.pending ? 'temporary-recovery' : 'bounded-audit',
    };
  }
  async invalidate(subject: string, from: number, to: number): Promise<Promise<void>> {
    if (this.closed) return Promise.resolve();
    await this.mutate(
      this.db
        .prepare(
          "INSERT INTO invalidations(subject,from_ms,to_ms) VALUES(?,?,?)\n      ON CONFLICT(subject) DO UPDATE SET from_ms=LEAST(invalidations.from_ms,excluded.from_ms),to_ms=GREATEST(invalidations.to_ms,excluded.to_ms),\n      cursor_at=-1,cursor_end=-1,cursor_unit='',generation=invalidations.generation+1",
        )
        .run(subject, from, to),
    );
    return this.drainInvalidations();
  }
  private drainInvalidations(): Promise<void> {
    if (this.invalidationWork) return this.invalidationWork;
    if (Date.now() < this.invalidationRetryAt) return Promise.resolve();
    this.invalidationWork = this.background(() => this.removeBatches())
      .then(
        () => {
          this.invalidationError = null;
          this.invalidationFailures = 0;
        },
        (error: unknown) => {
          this.invalidationError = 'screenshot_invalidation_failed';
          this.invalidationRetryAt =
            Date.now() + Math.min(30000, 1000 * 2 ** Math.min(this.invalidationFailures++, 5));
          throw error;
        },
      )
      .finally(() => {
        this.invalidationWork = undefined;
      });
    return this.invalidationWork;
  }
  private async removeBatches(): Promise<void> {
    while (!this.closed) {
      const pending = await this.db
        .prepare('SELECT * FROM invalidations ORDER BY subject LIMIT 1')
        .get<{
          subject: string;
          from_ms: number;
          to_ms: number;
          cursor_at: number;
          cursor_end: number;
          cursor_unit: string;
          generation: number;
        }>();
      if (!pending) return;
      const rows = (await this.db
        .prepare(
          'SELECT * FROM jobs WHERE subject=? AND at<? AND (at,"end",unit)>(?,?,?)\n        AND slot<? AND coalesce(coverage_end,"end")>? ORDER BY at,"end",unit LIMIT 32',
        )
        .all(
          pending.subject,
          pending.to_ms,
          pending.cursor_at,
          pending.cursor_end,
          pending.cursor_unit,
          pending.to_ms,
          pending.from_ms,
        )) as unknown as SnapshotJob[];
      const invalid: SnapshotJob[] = [];
      for (const row of rows) {
        // A sparse deletion publishes an envelope, not proof that every image in
        // between lost its source. Keep validated derivatives of surviving media.
        if (
          (row.state === 'done' && this.options.archive.hasMedia) ||
          (row.unit && this.options.archive.snapshotUnit)
        ) {
          await this.sourceExists(row, true);
        } else invalid.push(row);
        if (this.closed) return;
      }
      await this.retire(invalid);
      const last = rows.at(-1);
      if (rows.length < 32) {
        await this.mutate(
          this.db
            .prepare('DELETE FROM invalidations WHERE subject=? AND generation=?')
            .run(pending.subject, pending.generation),
        );
        this.invalidateScan(pending.subject);
      } else if (last)
        await this.mutate(
          this.db
            .prepare(
              'UPDATE invalidations SET cursor_at=?,cursor_end=?,cursor_unit=? WHERE subject=? AND generation=?',
            )
            .run(last.at, last.end, last.unit, pending.subject, pending.generation),
        );
      await this.cleanup();
      // Release the metadata and event loops between batches; new invalidation
      // generations rewind their own cursor and cannot be skipped by this batch.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  private invalidateScan(subject: string): void {
    this.scanCooldown.delete(subject);
    this.scanRevision++;
  }
  private start(): void {
    this.stopSubscription = this.options.archive.subscribeMedia?.((event) => {
      if (event.kind === 'commit' && event.segment.wallStartMs !== null) {
        this.scanCooldown.delete(event.segment.subjectId);
        const previous = this.dirty.get(event.segment.subjectId);
        this.dirty.set(event.segment.subjectId, {
          first: previous?.first ?? event.segment.id,
          last: event.segment.id,
        });
      } else if (event.kind === 'delete')
        void this.invalidate(event.subjectId, event.fromMs, event.toMs).catch((e) =>
          this.diagnostics.record('screenshot_invalidation_failed', e, 'error'),
        );
      this.schedule(0);
    });
    this.auditTimer = this.db.postgres.detached(() =>
      setInterval(() => this.scheduleAudit(), this.options.auditMs ?? 10000),
    );
    this.auditTimer.unref();
    this.scheduleAudit();
    this.schedule(0);
  }
  private auditWork: Promise<void> | undefined;
  private scheduleAudit(): void {
    if (this.closed || this.auditWork) return;
    this.lastAuditAt = Date.now();
    const failures = this.auditFailures;
    this.auditWork = this.background(() => this.audit())
      .then(() => {
        // Recovery/source checks may deliberately retain old data on I/O failure.
        // Promise completion alone therefore does not mean the audit succeeded.
        if (this.auditFailures !== failures || this.writer.status().error) return;
        this.auditError = null;
        this.lastAuditSuccess = Date.now();
      })
      .catch((e: unknown) => {
        this.auditError = 'screenshot_audit_failed';
        this.diagnostics.record('screenshot_audit_failed', e, 'error');
      })
      .finally(() => {
        this.auditWork = undefined;
      });
  }
  private async checked(job: SnapshotJob): Promise<Uint8Array | null> {
    try {
      const filename = this.filename(job),
        info = await lstat(filename);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 512 * 1024 ||
        (await realpath(filename)) !== path.resolve(filename)
      )
        throw Error('INVALID_SCREENSHOT');
      const bytes = await readFile(filename);
      if (!jpeg(bytes) || digest(bytes) !== job.hash) throw Error('INVALID_SCREENSHOT');
      return bytes;
    } catch (error) {
      if (this.closed) return null;
      await this.mutate(
        this.db
          .prepare(
            "UPDATE jobs SET state='pending',due=0,priority=GREATEST(priority,?),hash=NULL,error='missing_or_invalid' WHERE subject=? AND at=? AND \"end\"=? AND unit=?",
          )
          .run(REPAIR_PRIORITY, job.subject, job.at, job.end, job.unit),
      );
      this.schedule(0);
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        !(error instanceof Error && error.message === 'INVALID_SCREENSHOT')
      )
        this.diagnostics.record('screenshot_read_failed', error);
      return null;
    }
  }
  private async audit(): Promise<void> {
    await this.cleanup();
    if (this.closed) return;
    const rows = (await this.db
      .prepare(
        'SELECT * FROM jobs WHERE (subject,at,"end",unit)>(?,?,?,?) ORDER BY subject,at,"end",unit LIMIT 32',
      )
      .all(...this.auditCursor)) as unknown as SnapshotJob[];
    for (const row of rows) {
      if (this.closed) return;
      this.auditCursor = [row.subject, row.at, row.end, row.unit];
      if ((await this.sourceExists(row)) && row.state === 'done') await this.checked(row);
    }
    if (rows.length < 32) this.auditCursor = ['', -1, -1, ''];
  }
  private async sourceExists(job: SnapshotJob, requireEvidence = false): Promise<boolean> {
    // Completed frames carry the exact media dependencies used by the decoder.
    // Their existence is authoritative; locating the same minute again adds a
    // range scan to every image read/audit without validating anything extra.
    if (
      this.options.archive.snapshotUnit &&
      !(this.options.archive.hasMedia && job.state === 'done')
    ) {
      let segment;
      try {
        const unit = await this.options.archive.snapshotUnit(job.subject, job.at, job.unit);
        segment = unit?.unitId === job.unit ? unit : null;
      } catch (error) {
        this.auditFailures++;
        this.auditError = 'screenshot_audit_failed';
        this.diagnostics.record('screenshot_source_reconciliation_failed', error);
        if (requireEvidence) throw error;
        return !this.closed;
      }
      if (this.closed) return false;
      if (!segment) return this.missingSource(job);
    }
    if (this.options.archive.hasMedia && job.state === 'done') {
      let mediaIds: unknown = null;
      if (job.media_ids)
        try {
          mediaIds = JSON.parse(job.media_ids) as unknown;
        } catch (error) {
          this.diagnostics.record('screenshot_dependency_metadata_invalid', error);
        }
      if (!validMediaIds(mediaIds)) {
        // A frame without valid dependencies must be regenerated before serving.
        if (!this.closed) {
          await this.mutate(
            this.db
              .prepare(
                "UPDATE jobs SET state='pending',due=0,hash=NULL,rendered_to=NULL,media_ids=NULL,error='missing_dependencies' WHERE subject=? AND at=? AND \"end\"=? AND unit=? AND state='done'",
              )
              .run(job.subject, job.at, job.end, job.unit),
          );
          this.schedule(0);
        }
        return false;
      }
      let available;
      try {
        available = await this.options.archive.hasMedia(mediaIds);
      } catch (error) {
        this.auditFailures++;
        this.auditError = 'screenshot_audit_failed';
        this.diagnostics.record('screenshot_dependency_reconciliation_failed', error);
        if (requireEvidence) throw error;
        return !this.closed;
      }
      if (this.closed) return false;
      if (!available) return this.missingSource(job);
    }
    return !this.closed;
  }
  private async missingSource(job: SnapshotJob): Promise<boolean> {
    // A delayed source lookup must not invalidate a newer canonical timestamp.
    if (
      await this.db
        .prepare('SELECT 1 FROM jobs WHERE subject=? AND at=? AND "end"=? AND unit=?')
        .get(job.subject, job.at, job.end, job.unit)
    ) {
      await this.retire([job]);
      this.invalidateScan(job.subject);
      await this.cleanup();
    }
    return false;
  }
  private schedule(delay: number): void {
    if (this.closed) return;
    if (this.work) {
      if (delay === 0) this.wakeRequested = true;
      return;
    }
    if (this.timer) {
      if (delay !== 0) return;
      clearTimeout(this.timer);
    }
    // A scan transaction can enqueue this wake after the previous scheduling
    // turn ended. Its next turn owns independent claims, never the scan client.
    this.timer = this.db.postgres.detached(() =>
      setTimeout(() => {
        this.timer = undefined;
        this.work = this.background(() => this.step())
          .catch((e) => this.diagnostics.record('screenshot_worker_failed', e, 'error'))
          .finally(() => {
            this.work = undefined;
            const next = this.wakeRequested ? 0 : (this.options.pollMs ?? 250);
            this.wakeRequested = false;
            this.schedule(next);
          });
      }, delay),
    );
    this.timer.unref();
  }
  private async discover(subject: string, segment: string, priority: number): Promise<void> {
    const item = await this.options.archive.snapshotForSegment?.(subject, segment);
    if (item) await this.enqueue(subject, item, priority);
  }
  private async scan(): Promise<void> {
    if (!this.options.archive.snapshotUnits || Date.now() < this.scanAfter) return;
    this.scanAfter = Date.now() + 250;
    const subjects = await this.options.archive.listSubjects();
    if (!subjects.length) return;
    let empty = 0;
    // Empty subjects share one bounded scan budget instead of each consuming
    // a 250ms scheduling slot. Already cooled subjects need no archive query.
    for (let visited = 0; visited < subjects.length && empty < 16 && !this.closed; visited++) {
      const subject = subjects[this.scanIndex++ % subjects.length].id;
      if ((this.scanCooldown.get(subject) ?? 0) > Date.now()) continue;
      this.scanCooldown.delete(subject);
      const cursor =
        (
          await this.db
            .prepare('SELECT unit_cursor FROM scan WHERE subject=?')
            .get<{ unit_cursor: string | null }>(subject)
        )?.unit_cursor ?? undefined;
      const revision = this.scanRevision;
      const page = await this.options.archive.snapshotUnits(subject, cursor, 8);
      if (this.closed) return;
      // Admission of a page and its cursor is atomic. A graceful close drains an
      // admitted page even when its first unit starts rendering concurrently.
      await this.db.transaction(async () => {
        for (const item of page.items) await this.enqueueItem(subject, item, 0, true);
        // A concurrent deletion may have rewound the durable cursor while locate ran.
        if (revision === this.scanRevision)
          await this.mutate(
            this.db
              .prepare(
                'INSERT INTO scan VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET unit_cursor=excluded.unit_cursor',
              )
              .run(subject, page.cursor ?? cursor ?? null),
          );
      });
      await this.refreshStatistics();
      if (!page.items.length) this.scanCooldown.set(subject, Date.now() + 30000);
      if (page.items.length) return;
      empty++;
    }
  }
  private key(job: Pick<SnapshotJob, 'subject' | 'unit'>): string {
    return `${job.subject}/${job.unit}`;
  }
  private background<T>(action: () => Promise<T>): Promise<T> {
    return this.db.postgres.detached(() =>
      this.db.postgres.inLane(
        'background',
        () => this.options.archive.withBackgroundReads?.(action) ?? action(),
      ),
    );
  }
  private async owned(job: SnapshotJob & { claim_token: string }): Promise<boolean> {
    return !!(await this.db
      .prepare(
        'SELECT 1 FROM jobs WHERE subject=? AND at=? AND "end"=? AND unit=? AND claim_token=? AND state=\'running\'',
      )
      .get(job.subject, job.at, job.end, job.unit, job.claim_token));
  }
  private async discoverWork(): Promise<void> {
    if (this.closed) return;
    await this.refreshStatistics();
    if (this.closed) return;
    for (const [subject, members] of [...this.dirty].slice(0, 16)) {
      this.dirty.delete(subject);
      for (const segment of new Set([members.first, members.last]))
        await this.discover(subject, segment, LIVE_PRIORITY);
      if (this.closed) return;
    }
    await this.scan();
  }
  private async step(): Promise<void> {
    for (const [token, job] of this.interrupted) {
      await this.mutate(
        this.db
          .prepare(
            "UPDATE jobs SET state='pending',due=0,claim_token=NULL WHERE subject=? AND unit=? AND state='running' AND claim_token=?",
          )
          .run(job.subject, job.unit, token),
      );
      this.interrupted.delete(token);
    }
    this.claimError = null;
    // Maintenance owns its bounded cursor independently; a slow source check
    // must not occupy the scheduler while another subject has a ready image.
    void this.drainInvalidations().catch((error) =>
      this.diagnostics.record('screenshot_invalidation_failed', error, 'error'),
    );
    this.discoveryWork ??= this.discoverWork()
      .catch((error) => this.diagnostics.record('screenshot_discovery_failed', error, 'error'))
      .finally(() => {
        this.discoveryWork = undefined;
      });
    void this.cleanup().catch((error) =>
      this.diagnostics.record('screenshot_cleanup_failed', error, 'error'),
    );
    if (this.closed) return;
    // A canonical timestamp can return after replacement; retire its old file
    // before a new render is allowed to publish the same filename again.
    this.paused = this.options.canGenerate?.() === false;
    if (this.paused && !this.options.mediaRoot) return;
    // A turn admits at most its initial free capacity. Fast cancellation may
    // requeue the same unit; it must yield before re-reading generation policy.
    const capacity = (this.options.concurrency ?? 1) - this.current.size;
    for (
      let admitted = 0;
      admitted < capacity && !this.closed && this.current.size < (this.options.concurrency ?? 1);
      admitted++
    ) {
      const now = Date.now();
      const fair = this.priorityRuns >= 8;
      const oldest = fair
        ? ((await this.db
            .prepare(
              "SELECT * FROM jobs WHERE state IN ('pending','failed') AND due<=? AND (subject||'/'||unit) NOT IN (SELECT jsonb_array_elements_text(?::jsonb)) AND NOT EXISTS(SELECT 1 FROM retired r WHERE r.subject=jobs.subject AND r.unit=jobs.unit AND r.at=jobs.at AND r.\"end\"=jobs.\"end\") ORDER BY created,at LIMIT 1",
            )
            .get(now, JSON.stringify([...this.current.keys()]))) as unknown as
            SnapshotJob | undefined)
        : undefined;
      const job =
        oldest ??
        ((await this.db
          .prepare(
            // The partial ready index excludes completed history and preserves priority order.
            "SELECT * FROM jobs WHERE state IN ('pending','failed') AND due<=? AND (subject||'/'||unit) NOT IN (SELECT jsonb_array_elements_text(?::jsonb)) AND NOT EXISTS(SELECT 1 FROM retired r WHERE r.subject=jobs.subject AND r.unit=jobs.unit AND r.at=jobs.at AND r.\"end\"=jobs.\"end\") ORDER BY priority DESC,at DESC LIMIT 1",
          )
          .get(now, JSON.stringify([...this.current.keys()]))) as unknown as
          SnapshotJob | undefined);
      if (!job) return;
      this.priorityRuns = fair ? 0 : this.priorityRuns + 1;
      // Retirement blocks only the exact derivative being replaced; unrelated
      // files must not stall current unit screenshots during catch-up.
      if (
        await this.db
          .prepare('SELECT 1 FROM retired WHERE subject=? AND at=? AND "end"=? AND unit=?')
          .get(job.subject, job.at, job.end, job.unit)
      )
        return;
      if (this.closed) return;
      const token = randomUUID();
      const claimed = await this.mutate(
        this.db
          .prepare(
            `UPDATE jobs SET state='running',claim_token=?
      WHERE subject=? AND at=? AND "end"=? AND unit=? AND state IN ('pending','failed')`,
          )
          .run(token, job.subject, job.at, job.end, job.unit),
      );
      if (!claimed.changes || this.closed) return;
      const controller = new AbortController();
      const claimedJob = { ...job, claim_token: token };
      const work = this.run(claimedJob, controller)
        .catch((error: unknown) => {
          // A failed retry-state write must not strand a durable running claim.
          this.interrupted.set(token, job);
          this.claimError = 'screenshot_claim_failed';
          this.diagnostics.record('screenshot_execution_failed', error, 'error');
        })
        .finally(() => {
          this.current.delete(this.key(job));
          this.schedule(this.paused ? (this.options.pollMs ?? 250) : 0);
        });
      this.current.set(this.key(job), { job, controller, work });
    }
  }
  private async run(
    job: SnapshotJob & { claim_token: string },
    controller: AbortController,
  ): Promise<void> {
    const started = Date.now();
    const timings = { renderMs: 0, validateMs: 0, publishMs: 0 };
    try {
      const cached = await this.output.adopt(job, controller.signal);
      if (cached) {
        const media_ids = JSON.stringify(cached.mediaIds);
        if (await this.sourceExists({ ...job, state: 'done', media_ids }, true)) {
          await this.mutate(
            this.db
              .prepare(
                "UPDATE jobs SET state='done',claim_token=NULL,hash=?,rendered_to=?,media_ids=?,error=NULL,attempts=0 WHERE subject=? AND at=? AND \"end\"=? AND unit=? AND state='running' AND claim_token=?",
              )
              .run(
                digest(cached.bytes),
                cached.throughMs,
                media_ids,
                job.subject,
                job.at,
                job.end,
                job.unit,
                job.claim_token,
              ),
          );
          return;
        }
      }
      if (this.options.canGenerate?.() === false) controller.abort();
      if (controller.signal.aborted) throw Error('SCREENSHOT_CANCELLED');
      const renderStarted = performance.now();
      const frame = await this.options.render(job, controller.signal);
      timings.renderMs = Math.round(performance.now() - renderStarted);
      if (!jpeg(frame.bytes) || frame.bytes.length > 512 * 1024) throw Error('INVALID_SCREENSHOT');
      const validateStarted = performance.now();
      await this.options.validate(frame.bytes, controller.signal);
      timings.validateMs = Math.round(performance.now() - validateStarted);
      if (
        (frame.mediaIds !== undefined && !validMediaIds(frame.mediaIds)) ||
        (this.options.archive.hasMedia && !validMediaIds(frame.mediaIds))
      )
        throw Error('INVALID_SCREENSHOT_DEPENDENCIES');
      const completed = {
        ...job,
        state: 'done',
        media_ids: frame.mediaIds ? JSON.stringify([...new Set(frame.mediaIds)]) : null,
      };
      if (this.options.canGenerate?.() === false) controller.abort();
      if (controller.signal.aborted) throw Error('SCREENSHOT_CANCELLED');
      if (!(await this.owned(job))) return;
      if (!(await this.sourceExists(completed, true))) return;
      if (controller.signal.aborted) throw Error('SCREENSHOT_CANCELLED');
      const publishStarted = performance.now();
      const disk = await this.output.publish(
        job,
        frame,
        async () => !controller.signal.aborted && (await this.owned(job)),
        () => this.sourceExists(completed, true),
      );
      if (!disk) {
        if (controller.signal.aborted) throw Error('SCREENSHOT_CANCELLED');
        return;
      }
      if (!controller.signal.aborted) {
        const result = await this.mutate(
          this.db
            .prepare(
              "UPDATE jobs SET state='done',claim_token=NULL,hash=?,rendered_to=?,media_ids=?,error=NULL,attempts=0 WHERE subject=? AND at=? AND \"end\"=? AND unit=? AND state='running' AND claim_token=?",
            )
            .run(
              digest(disk),
              frame.throughMs,
              completed.media_ids,
              job.subject,
              job.at,
              job.end,
              job.unit,
              job.claim_token,
            ),
        );
        if (Number(result.changes) > 0) {
          this.lastCompletedAt = Date.now();
          timings.publishMs = Math.round(performance.now() - publishStarted);
          console.info(
            JSON.stringify({
              event: 'screenshot_generated',
              subjectId: job.subject,
              unitId: job.unit,
              queueMs: Math.max(0, started - job.created),
              ...timings,
            }),
          );
        }
      }
    } catch (error) {
      const cancelled = controller.signal.aborted,
        delay = Math.min(300000, (this.options.retryMs ?? 3000) * 2 ** Math.min(job.attempts, 7));
      await this.mutate(
        this.db
          .prepare(
            'UPDATE jobs SET state=?,claim_token=NULL,due=?,attempts=attempts+?,error=? WHERE subject=? AND at=? AND "end"=? AND unit=? AND state=\'running\' AND claim_token=?',
          )
          .run(
            cancelled ? 'pending' : 'failed',
            cancelled ? 0 : Date.now() + delay,
            cancelled ? 0 : 1,
            cancelled ? 'interrupted' : error instanceof Error ? error.name : 'failed',
            job.subject,
            job.at,
            job.end,
            job.unit,
            job.claim_token,
          ),
      );
    } finally {
      const elapsed = Date.now() - started;
      this.averageMs = this.averageMs ? this.averageMs * 0.8 + elapsed * 0.2 : elapsed;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.auditTimer);
    this.stopSubscription?.();
    for (const active of this.current.values()) active.controller.abort();
    this.closing = Promise.allSettled([
      this.work,
      this.discoveryWork,
      ...[...this.current.values()].map((active) => active.work),
      this.auditWork,
      this.invalidationWork,
      this.cleanupWork,
    ]).then(async () => {
      try {
        await this.writer.close();
        await this.db.exec(
          "UPDATE jobs SET state='pending',due=0,claim_token=NULL WHERE state='running'",
        );
      } finally {
        try {
          await this.db.close();
        } finally {
          await this.lease.close();
          this.diagnostics.close();
        }
      }
    });
    return this.closing;
  }
}
