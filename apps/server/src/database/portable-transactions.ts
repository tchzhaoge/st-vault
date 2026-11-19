import { createHash } from 'node:crypto';
import { open, readdir, rename, unlink, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Postgres } from './postgres.js';
import { directory, libraryIdPattern, syncDirectory } from '../library/files.js';
import { FileLease } from './file-lease.js';
import { writeCheckpoint, restoreCheckpoint, validCheckpoint } from './portable-checkpoint.js';
import type { PortableCheckpoint, PortableTable } from './portable-checkpoint.js';
import type { PoolClient } from 'pg';

interface Change {
  relation: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
type Table = PortableTable;
interface Options {
  mediaRoot: string;
  libraryId: string;
  tables: string[];
  fault?: (
    point:
      | 'after-portable-sync'
      | 'after-postgres-commit'
      | 'before-checkpoint-publish'
      | 'after-checkpoint-publish'
      | 'after-checkpoint-pin',
  ) => void | Promise<void>;
  checkpoint?: PortableCheckpoint;
  previous?: PortableCheckpoint;
  publishCheckpoint?: (
    checkpoint: PortableCheckpoint,
    previous?: PortableCheckpoint,
  ) => Promise<void> | void;
}
const HEADER = 48;
const MAX_RECORD = 16 * 1024 ** 2;
const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw Error('INVALID_PORTABLE_IDENTIFIER');
  return `"${value}"`;
};
/** Journal-before-commit: confirmed metadata survives losing the entire hot database. */
export class PortableTransactions {
  private readonly db: Postgres;
  private readonly options: Options;
  private readonly tables: Map<string, Table>;
  private file: FileHandle;
  private readonly journalRoot: string;
  private currentCheckpoint?: PortableCheckpoint;
  private previousCheckpoint?: PortableCheckpoint;
  private checkpointWork: Promise<void> | undefined;
  private readonly checkpointAbort = new AbortController();
  private checkpointFailed = false;
  private checkpointAt = Date.now();
  private checkpointRetryAt = 0;
  private sequence = 0;
  private activeStart = 1;
  private replayed = 0;
  private recordsRead = 0;
  private bytesRead = 0;
  private journalBytes = 0;
  private poisoned = false;
  private closing = false;
  private closeWork: Promise<void> | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private readonly lease: FileLease;
  private constructor(
    db: Postgres,
    options: Options,
    tables: Table[],
    file: FileHandle,
    lease: FileLease,
  ) {
    this.lease = lease;
    this.db = db;
    this.options = options;
    this.journalRoot = path.join(options.mediaRoot, 'postgres-journal');
    this.currentCheckpoint = options.checkpoint;
    this.previousCheckpoint = options.previous;
    this.tables = new Map(tables.map((table) => [table.name, table]));
    this.file = file;
  }
  static async open(db: Postgres, options: Options): Promise<PortableTransactions> {
    if (
      !libraryIdPattern.test(options.libraryId) ||
      !options.tables.length ||
      new Set(options.tables).size !== options.tables.length
    )
      throw Error('INVALID_PORTABLE_LIBRARY');
    const journalRoot = directory(path.join(options.mediaRoot, 'postgres-journal'));
    const lease = await FileLease.acquire(path.join(journalRoot, '.instance.lock'));
    try {
      return await PortableTransactions.openLocked(db, options, journalRoot, lease);
    } catch (error) {
      await lease.close();
      throw error;
    }
  }
  private static async openLocked(
    db: Postgres,
    options: Options,
    journalRoot: string,
    lease: FileLease,
  ): Promise<PortableTransactions> {
    const tables: Table[] = [];
    for (const name of options.tables) {
      identifier(name);
      const columns = await db.query<{ name: string }>(
        `SELECT a.attname AS name FROM pg_attribute a
         WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [name],
      );
      const keys = await db.query<{ name: string }>(
        `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a
         ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
         WHERE i.indrelid=to_regclass($1) AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)`,
        [name],
      );
      if (!columns.length || !keys.length) throw Error('PORTABLE_TABLE_REQUIRES_PRIMARY_KEY');
      tables.push({
        name,
        columns: columns.map((row) => row.name),
        keys: keys.map((row) => row.name),
      });
    }
    const [prior] = await db.query<{ present: boolean }>(
      "SELECT to_regclass('stv_library_state') IS NOT NULL AS present",
    );
    const priorState = prior.present
      ? (
          await db.query<{ sequence: number }>('SELECT sequence FROM stv_library_state WHERE id=1')
        )[0]
      : undefined;
    await db.query(`CREATE TABLE IF NOT EXISTS stv_library_state(
      id SMALLINT PRIMARY KEY CHECK(id=1),library UUID NOT NULL,sequence BIGINT NOT NULL)`);
    await db.query('INSERT INTO stv_library_state VALUES(1,$1,0) ON CONFLICT(id) DO NOTHING', [
      options.libraryId,
    ]);
    const [state] = await db.query<{ library: string }>(
      'SELECT library FROM stv_library_state WHERE id=1',
    );
    if (state.library !== options.libraryId) throw Error('PORTABLE_LIBRARY_MISMATCH');
    const filename = path.join(journalRoot, 'active.log');
    const { constants } = await import('node:fs');
    const file = await open(
      filename,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    if (!(await file.stat()).isFile()) {
      await file.close();
      throw Error('UNSAFE_PORTABLE_JOURNAL');
    }
    syncDirectory(journalRoot);
    const journal = new PortableTransactions(db, options, tables, file, lease);
    try {
      await journal.installCapture();
      await journal.recover(priorState !== undefined);
      await journal.cleanupTemporaryCheckpoints();
      return journal;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  private async installCapture(): Promise<void> {
    await this.db
      .query(`CREATE OR REPLACE FUNCTION stv_capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('stv.capture',true)='on' THEN
        INSERT INTO pg_temp.stv_changes(relation,operation,before,after)
          VALUES(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
      ELSIF current_setting('stv.replay',true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'PORTABLE_WRITE_REQUIRES_TRANSACTION';
      END IF;
      RETURN NULL;
    END $$`);
    for (const table of this.tables.values()) {
      await this.db.query(`DROP TRIGGER IF EXISTS stv_capture ON ${identifier(table.name)}`);
      await this.db
        .query(`CREATE TRIGGER stv_capture AFTER INSERT OR UPDATE OR DELETE ON ${identifier(table.name)}
        FOR EACH ROW EXECUTE FUNCTION stv_capture_change()`);
    }
  }
  async transaction<T>(action: () => Promise<T>): Promise<T> {
    if (this.poisoned || this.closing) throw Error('PORTABLE_LIBRARY_REQUIRES_RECOVERY');
    if (this.db.inTransaction) throw Error('PORTABLE_TRANSACTION_MUST_BE_OUTERMOST');
    const work = this.execute(action);
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  private async execute<T>(action: () => Promise<T>): Promise<T> {
    let publishing = false;
    let committedSequence = this.sequence;
    try {
      const result = await this.db.transaction(
        async () => {
          // Serialize the portable append, not readers. No two writers can allocate
          // the same sequence or interleave frames, even on different pool clients.
          await this.db.query('SELECT pg_advisory_xact_lock(193701233,1)');
          if (this.poisoned) throw Error('PORTABLE_LIBRARY_REQUIRES_RECOVERY');
          await this.db.query(`CREATE TEMP TABLE IF NOT EXISTS stv_changes(
          ordinal BIGSERIAL,relation TEXT NOT NULL,operation TEXT NOT NULL,before JSONB,after JSONB)
          ON COMMIT DELETE ROWS`);
          await this.db.query("SET LOCAL stv.capture='on'");
          const result = await action();
          const [budget] = await this.db.query<{ count: number; bytes: number }>(
            `SELECT count(*) AS count,coalesce(sum(coalesce(octet_length(before::text),0)+coalesce(octet_length(after::text),0)),0)::bigint AS bytes
           FROM pg_temp.stv_changes`,
          );
          if (budget.count > 65536 || budget.bytes > MAX_RECORD)
            throw Error('PORTABLE_TRANSACTION_TOO_LARGE');
          const changes = await this.db.query<Change>(
            'SELECT relation,operation,before,after FROM pg_temp.stv_changes ORDER BY ordinal LIMIT 65537',
          );
          if (changes.length > 65536) throw Error('PORTABLE_TRANSACTION_TOO_LARGE');
          if (changes.length) {
            this.validate(changes);
            const [state] = await this.db.query<{ sequence: number }>(
              'SELECT sequence FROM stv_library_state WHERE id=1',
            );
            const sequence = state.sequence + 1;
            const payload = Buffer.from(
              JSON.stringify({ library: this.options.libraryId, changes }),
            );
            if (payload.length > MAX_RECORD) throw Error('PORTABLE_TRANSACTION_TOO_LARGE');
            const header = Buffer.alloc(HEADER);
            header.write('STP1');
            header.writeUInt32BE(payload.length, 4);
            header.writeBigUInt64BE(BigInt(sequence), 8);
            createHash('sha256')
              .update(header.subarray(0, 16))
              .update(payload)
              .digest()
              .copy(header, 16);
            publishing = true;
            const position = (await this.file.stat()).size;
            await this.write(Buffer.concat([header, payload]), position);
            await this.file.sync();
            this.journalBytes += HEADER + payload.length;
            await this.options.fault?.('after-portable-sync');
            // The durable media journal is authoritative. Only this hot projection
            // may acknowledge before its redundant WAL flush; recovery replays its
            // missing suffix. Configuration, jobs, checkpoints and replay stay sync.
            await this.db.query('SET LOCAL synchronous_commit=off');
            await this.db.query('UPDATE stv_library_state SET sequence=$1 WHERE id=1', [sequence]);
            committedSequence = sequence;
          }
          return result;
        },
        // Acknowledged commands and recording commits must not queue behind
        // background render/source scans. The journal still has one writer.
        { lane: 'writer' },
      );
      this.sequence = Math.max(this.sequence, committedSequence);
      await this.options.fault?.('after-postgres-commit');
      return result;
    } catch (error) {
      if (publishing) this.poisoned = true;
      throw error;
    }
  }
  private validate(changes: Change[]): void {
    for (const change of changes) {
      const table = this.tables.get(change.relation);
      if (!table || !['INSERT', 'UPDATE', 'DELETE'].includes(change.operation))
        throw Error('INVALID_PORTABLE_CHANGE');
      const row = change.after ?? change.before;
      if (
        !row ||
        Object.keys(row).length !== table.columns.length ||
        table.columns.some((column) => !(column in row))
      )
        throw Error('INVALID_PORTABLE_ROW');
      if (
        change.operation === 'UPDATE' &&
        table.keys.some((key) => change.before?.[key] !== change.after?.[key])
      )
        throw Error('PORTABLE_PRIMARY_KEY_IS_IMMUTABLE');
    }
  }
  private async write(bytes: Buffer, position: number): Promise<void> {
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await this.file.write(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      if (!bytesWritten) throw Error('PORTABLE_JOURNAL_WRITE_FAILED');
      offset += bytesWritten;
    }
  }
  private async read(bytes: Buffer, position: number, file = this.file): Promise<number> {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset;
  }
  private async recover(hadState: boolean): Promise<void> {
    let [state] = await this.db.query<{ sequence: number }>(
      'SELECT sequence FROM stv_library_state WHERE id=1',
    );
    let restored = false;
    if (this.currentCheckpoint && (!hadState || state.sequence < this.currentCheckpoint.sequence)) {
      let selected: PortableCheckpoint | undefined;
      for (const checkpoint of [this.currentCheckpoint, this.previousCheckpoint]) {
        if (checkpoint && (await validCheckpoint(this.options.mediaRoot, checkpoint))) {
          selected = checkpoint;
          break;
        }
      }
      if (!selected) throw Error('PORTABLE_CHECKPOINT_CORRUPT');
      await restoreCheckpoint({
        db: this.db,
        mediaRoot: this.options.mediaRoot,
        checkpoint: selected,
        library: this.options.libraryId,
        tables: [...this.tables.values()],
      });
      state = { sequence: selected.sequence };
      restored = true;
      this.currentCheckpoint = selected;
      // If the newest artifact is unusable, retain the valid fallback as the
      // current checkpoint. A successful replacement will publish a new pair.
      if (selected.file === this.previousCheckpoint?.file) {
        this.previousCheckpoint = undefined;
        this.checkpointFailed = true;
      }
    }
    let applied = state.sequence,
      head = this.currentCheckpoint?.sequence ?? 0;
    const sealed: (PortableCheckpoint & { start: number; end: number })[] = [];
    for (const name of await readdir(this.journalRoot)) {
      const match = /^([1-9][0-9]*)-([1-9][0-9]*)\.log$/.exec(name);
      if (!match) continue;
      const first = Number(match[1]),
        last = Number(match[2]);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first)
        throw Error('PORTABLE_JOURNAL_CORRUPT');
      sealed.push({ file: name, start: first, end: last, sequence: last, hash: '' });
    }
    sealed.sort((a, b) => a.start - b.start);
    let sealedEnd = 0;
    for (const file of sealed) {
      if (file.start <= sealedEnd) throw Error('PORTABLE_JOURNAL_CORRUPT');
      const info = await lstat(path.join(this.journalRoot, file.file));
      if (!info.isFile() || info.isSymbolicLink()) throw Error('UNSAFE_PORTABLE_JOURNAL');
      sealedEnd = file.end;
      if (file.end <= state.sequence) {
        head = Math.max(head, file.end);
        continue;
      }
      const handle = await this.openJournal(file.file);
      try {
        const scanned = await this.scanJournal(handle, false, file.start - 1, applied);
        if (scanned.first !== file.start || scanned.last !== file.end)
          throw Error('PORTABLE_JOURNAL_CORRUPT');
        if (scanned.first > applied + 1) throw Error('PORTABLE_JOURNAL_CORRUPT');
        applied = Math.max(applied, scanned.last);
        head = Math.max(head, scanned.last);
      } finally {
        await handle.close();
      }
    }
    const active = await this.scanJournal(
      this.file,
      true,
      sealedEnd || (this.currentCheckpoint?.sequence ?? 0),
      applied,
    );
    if (active.first !== undefined && active.first > applied + 1)
      throw Error('PORTABLE_JOURNAL_CORRUPT');
    head = Math.max(head, active.last);
    applied = Math.max(applied, active.last);
    if (state.sequence > head) throw Error('PORTABLE_JOURNAL_BEHIND_DATABASE');
    this.sequence = applied;
    this.activeStart =
      active.first ?? Math.max(sealedEnd, this.currentCheckpoint?.sequence ?? 0) + 1;
    this.journalBytes = (await this.file.stat()).size;
    for (const file of sealed)
      if (file.end > (this.currentCheckpoint?.sequence ?? 0))
        this.journalBytes += (await lstat(path.join(this.journalRoot, file.file))).size;
    if (restored || this.replayed) await this.resetSequences();
  }
  private async openJournal(name: string): Promise<FileHandle> {
    const { constants } = await import('node:fs');
    const file = await open(
      path.join(this.journalRoot, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    if (!(await file.stat()).isFile()) {
      await file.close();
      throw Error('UNSAFE_PORTABLE_JOURNAL');
    }
    return file;
  }
  private async scanJournal(
    file: FileHandle,
    active: boolean,
    previous: number,
    applied: number,
  ): Promise<{ first?: number; last: number }> {
    let position = 0,
      last = previous,
      first: number | undefined;
    const length = (await file.stat()).size;
    while (position < length) {
      const header = Buffer.alloc(HEADER);
      if ((await this.read(header, position, file)) < HEADER) {
        if (!active) throw Error('PORTABLE_JOURNAL_CORRUPT');
        await file.truncate(position);
        await file.sync();
        break;
      }
      const size = header.readUInt32BE(4),
        next = Number(header.readBigUInt64BE(8));
      if (
        header.toString('utf8', 0, 4) !== 'STP1' ||
        size > MAX_RECORD ||
        !Number.isSafeInteger(next) ||
        next !== last + 1
      )
        throw Error('PORTABLE_JOURNAL_CORRUPT');
      const payload = Buffer.alloc(size);
      if ((await this.read(payload, position + HEADER, file)) < size) {
        if (!active) throw Error('PORTABLE_JOURNAL_CORRUPT');
        await file.truncate(position);
        await file.sync();
        break;
      }
      if (
        !createHash('sha256')
          .update(header.subarray(0, 16))
          .update(payload)
          .digest()
          .equals(header.subarray(16))
      )
        throw Error('PORTABLE_JOURNAL_CORRUPT');
      this.recordsRead++;
      this.bytesRead += HEADER + size;
      const value = JSON.parse(payload.toString('utf8')) as { library: string; changes: Change[] };
      if (value.library !== this.options.libraryId || !Array.isArray(value.changes))
        throw Error('INVALID_PORTABLE_CHANGE');
      this.validate(value.changes);
      if (next > applied) {
        if (next !== applied + 1) throw Error('PORTABLE_JOURNAL_CORRUPT');
        await this.db.transaction(
          async () => {
            await this.db.query('SET CONSTRAINTS ALL DEFERRED');
            await this.db.query("SET LOCAL stv.replay='on'");
            for (const change of value.changes) await this.apply(change);
            await this.db.query('UPDATE stv_library_state SET sequence=$1 WHERE id=1', [next]);
          },
          { lane: 'background' },
        );
        applied = next;
        this.replayed++;
      }
      first ??= next;
      last = next;
      position += HEADER + size;
    }
    return { first, last };
  }
  private async resetSequences(): Promise<void> {
    for (const table of this.tables.values())
      for (const column of table.columns) {
        const [row] = await this.db.query<{ sequence: string | null }>(
          'SELECT pg_get_serial_sequence($1,$2) AS sequence',
          [table.name, column],
        );
        if (row.sequence)
          await this.db.query(
            `SELECT setval($1::regclass,coalesce((SELECT max(${identifier(column)}) FROM ${identifier(table.name)}),1),EXISTS(SELECT 1 FROM ${identifier(table.name)}))`,
            [row.sequence],
          );
      }
  }
  private async apply(change: Change): Promise<void> {
    const table = this.tables.get(change.relation)!;
    if (change.operation === 'DELETE') {
      await this.db.query(
        `DELETE FROM ${identifier(table.name)} WHERE ${table.keys.map((key, index) => `${identifier(key)}=$${index + 1}`).join(' AND ')}`,
        table.keys.map((key) => change.before![key]),
      );
      return;
    }
    const columns = table.columns.map(identifier);
    const updates = table.columns.filter((column) => !table.keys.includes(column)).map(identifier);
    await this.db.query(
      `INSERT INTO ${identifier(table.name)}(${columns.join(',')})
      VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT(${table.keys.map(identifier).join(',')})
      ${updates.length ? 'DO UPDATE SET ' + updates.map((column) => `${column}=excluded.${column}`).join(',') : 'DO NOTHING'}`,
      table.columns.map((column) => change.after![column]),
    );
  }
  status(): {
    sequence: number;
    replayed: number;
    recordsRead: number;
    bytesRead: number;
    journalBytes: number;
    checkpointing: boolean;
    checkpointFailed: boolean;
    requiresRecovery: boolean;
  } {
    return {
      sequence: this.sequence,
      replayed: this.replayed,
      recordsRead: this.recordsRead,
      bytesRead: this.bytesRead,
      journalBytes: this.journalBytes,
      checkpointing: this.checkpointWork !== undefined,
      checkpointFailed: this.checkpointFailed,
      requiresRecovery: this.poisoned,
    };
  }
  needsCheckpoint(): boolean {
    return (
      !!this.options.publishCheckpoint &&
      !this.closing &&
      !this.poisoned &&
      !this.checkpointWork &&
      Date.now() >= this.checkpointRetryAt &&
      (!this.currentCheckpoint ||
        this.checkpointFailed ||
        this.journalBytes >= 64 * 1024 ** 2 ||
        (this.journalBytes > 0 && Date.now() - this.checkpointAt >= 300000))
    );
  }
  checkpoint(): Promise<void> {
    if (this.closing || this.poisoned)
      return Promise.reject(Error('PORTABLE_LIBRARY_REQUIRES_RECOVERY'));
    if (!this.options.publishCheckpoint)
      return Promise.reject(Error('PORTABLE_CHECKPOINT_PUBLISHER_REQUIRED'));
    this.checkpointWork ??= this.saveCheckpoint()
      .catch((error: unknown) => {
        if (this.closing && error === this.checkpointAbort.signal.reason) return;
        this.checkpointFailed = true;
        this.checkpointRetryAt = Date.now() + 30000;
        throw error;
      })
      .finally(() => {
        this.checkpointWork = undefined;
      });
    return this.checkpointWork;
  }
  private async saveCheckpoint(): Promise<void> {
    let snapshot: PoolClient | undefined;
    let checkpointSequence = 0;
    try {
      await this.db.transaction(
        async () => {
          await this.db.query('SELECT pg_advisory_xact_lock(193701233,1)');
          if (this.poisoned) throw Error('PORTABLE_LIBRARY_REQUIRES_RECOVERY');
          this.checkpointAbort.signal.throwIfAborted();
          const [state] = await this.db.query<{ sequence: number }>(
            'SELECT sequence FROM stv_library_state WHERE id=1',
          );
          checkpointSequence = state.sequence;
          snapshot = await this.db.snapshot();
          const pinned = await snapshot.query<{ sequence: number }>(
            'SELECT sequence FROM stv_library_state WHERE id=1',
          );
          if (pinned.rows[0].sequence !== state.sequence)
            throw Error('PORTABLE_CHECKPOINT_SNAPSHOT_MISMATCH');
          const size = (await this.file.stat()).size;
          if (size) {
            try {
              await this.file.sync();
              await this.file.close();
              await rename(
                path.join(this.journalRoot, 'active.log'),
                path.join(this.journalRoot, `${this.activeStart}-${state.sequence}.log`),
              );
              const { constants } = await import('node:fs');
              this.file = await open(
                path.join(this.journalRoot, 'active.log'),
                constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
              );
              syncDirectory(this.journalRoot);
              this.activeStart = state.sequence + 1;
            } catch (error) {
              this.poisoned = true;
              throw error;
            }
          }
          this.journalBytes = 0;
        },
        { lane: 'background' },
      );
      await this.options.fault?.('after-checkpoint-pin');
      const checkpoint = await writeCheckpoint({
        client: snapshot!,
        mediaRoot: this.options.mediaRoot,
        library: this.options.libraryId,
        sequence: checkpointSequence,
        tables: [...this.tables.values()],
        signal: this.checkpointAbort.signal,
      });
      this.checkpointAbort.signal.throwIfAborted();
      await this.options.fault?.('before-checkpoint-publish');
      const previous = this.currentCheckpoint;
      await this.options.publishCheckpoint!(checkpoint, previous);
      this.previousCheckpoint = previous;
      this.currentCheckpoint = checkpoint;
      await this.options.fault?.('after-checkpoint-publish');
      this.checkpointFailed = false;
      this.checkpointRetryAt = 0;
      this.checkpointAt = Date.now();
      await this.cleanupPublished();
    } finally {
      if (snapshot) {
        try {
          await snapshot.query('ROLLBACK');
        } finally {
          snapshot.release();
        }
      }
    }
  }
  private async cleanupPublished(): Promise<void> {
    if (this.previousCheckpoint) {
      for (const name of await readdir(this.journalRoot)) {
        const match = /^([1-9][0-9]*)-([1-9][0-9]*)\.log$/.exec(name);
        if (match && Number(match[2]) <= this.previousCheckpoint.sequence) {
          const filename = path.join(this.journalRoot, name),
            info = await lstat(filename);
          if (!info.isFile() || info.isSymbolicLink()) throw Error('UNSAFE_PORTABLE_JOURNAL');
          await unlink(filename);
        }
      }
      syncDirectory(this.journalRoot);
    }
    const catalog = directory(path.join(this.options.mediaRoot, 'catalog'));
    for (const name of await readdir(catalog)) {
      if (!/^[a-f0-9-]{36}\.ndjson(?:\.tmp)?$/.test(name)) continue;
      if ([this.currentCheckpoint?.file, this.previousCheckpoint?.file].includes(`catalog/${name}`))
        continue;
      const filename = path.join(catalog, name),
        info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw Error('UNSAFE_PORTABLE_CHECKPOINT');
      await unlink(filename);
    }
    syncDirectory(catalog);
  }
  private async cleanupTemporaryCheckpoints(): Promise<void> {
    const catalog = directory(path.join(this.options.mediaRoot, 'catalog'));
    for (const name of await readdir(catalog)) {
      if (!/^[a-f0-9-]{36}\.ndjson\.tmp$/.test(name)) continue;
      const filename = path.join(catalog, name),
        info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw Error('UNSAFE_PORTABLE_CHECKPOINT');
      await unlink(filename);
    }
    syncDirectory(catalog);
  }
  close(): Promise<void> {
    this.closeWork ??= this.drain();
    return this.closeWork;
  }
  private async drain(): Promise<void> {
    this.closing = true;
    this.checkpointAbort.abort();
    await Promise.allSettled([
      ...this.active,
      ...(this.checkpointWork ? [this.checkpointWork] : []),
    ]);
    try {
      await this.file.close();
    } finally {
      await this.lease.close();
    }
  }
}
