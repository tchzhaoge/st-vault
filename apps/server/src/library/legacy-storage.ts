import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type * as Files from './files.js';
const {
  atomicJson,
  directory,
  fileHash,
  fileHashAsync,
  libraryIdPattern,
  regularFile,
  syncDirectory,
} = (await import(
  new URL(import.meta.url.endsWith('.ts') ? './files.ts' : './files.js', import.meta.url).href
)) as typeof Files;

interface Checkpoint {
  file: string;
  sequence: number;
  hash: string;
}
export interface LibraryManifest {
  format: 1;
  id: string;
  createdAtMs: number;
  checkpoint?: Checkpoint;
  previous?: Checkpoint;
}
const HEADER = 48,
  MAX_CHANGESET = 16 * 1024 ** 2;
const checkpointPattern = /^catalog\/[0-9]+\.sqlite$/;
const sealedPattern = /^([0-9]+)-([0-9]+)\.log$/;
class CheckpointCancelled extends Error {}
function present(filename: string): boolean {
  try {
    regularFile(filename);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
export type LibraryFault = (
  point:
    | 'after-journal-sync'
    | 'after-index-commit'
    | 'before-checkpoint-hash'
    | 'before-checkpoint-publish',
) => void;

/** The library journal is authoritative. The SQLite connection is a disposable projection. */
export class LibraryStorage {
  readonly dataRoot: string;
  readonly mediaRoot: string;
  private readonly fault?: LibraryFault;
  readonly indexFile: string;
  readonly manifest: LibraryManifest;
  private fd: number | undefined;
  private sequence = 0;
  private activeStart = 1;
  private poisoned = false;
  private checkpointing: Promise<void> | undefined;
  private closing = false;
  private readonly closeController = new AbortController();
  private attached: DatabaseSync | undefined;
  private journalBytes = 0;
  private checkpointAt = 0;
  private replayed = 0;
  private recordsRead = 0;
  private bytesRead = 0;
  private checkpointRetryAt = 0;
  private checkpointFailed = false;
  private checkpointPending = false;
  private activeFirst = 0;
  private readonly journalRoot: string;
  constructor(dataRoot: string, mediaRoot: string, fault?: LibraryFault) {
    this.dataRoot = dataRoot;
    this.mediaRoot = mediaRoot;
    this.fault = fault;
    directory(dataRoot);
    directory(mediaRoot);
    this.journalRoot = directory(path.join(mediaRoot, 'journal'));
    directory(path.join(mediaRoot, 'catalog'));
    // Only this locked library's unpublished files are disposable. Never walk recordings.
    for (const name of readdirSync(path.join(mediaRoot, 'catalog')))
      if (/^[a-f0-9-]{36}\.tmp(?:-journal|-wal|-shm)?$/.test(name)) {
        const filename = path.join(mediaRoot, 'catalog', name);
        regularFile(filename);
        unlinkSync(filename);
      }
    const filename = path.join(mediaRoot, 'library.json');
    if (present(filename)) {
      regularFile(filename);
      const value = JSON.parse(readFileSync(filename, 'utf8')) as LibraryManifest;
      if (
        value.format !== 1 ||
        !libraryIdPattern.test(value.id) ||
        !Number.isSafeInteger(value.createdAtMs)
      )
        throw Error('INVALID_LIBRARY_MANIFEST');
      for (const checkpoint of [value.checkpoint, value.previous])
        if (
          checkpoint &&
          (!checkpointPattern.test(checkpoint.file) ||
            !Number.isSafeInteger(checkpoint.sequence) ||
            checkpoint.sequence < 0 ||
            !/^[a-f0-9]{64}$/.test(checkpoint.hash))
        )
          throw Error('INVALID_LIBRARY_CHECKPOINT');
      this.manifest = value;
    } else {
      if (
        readdirSync(mediaRoot).some(
          (name) =>
            ![
              'catalog',
              'journal',
              'instance-lock.sqlite',
              'instance-lock.sqlite-journal',
            ].includes(name),
        )
      )
        throw Error('LIBRARY_MIGRATION_REQUIRED');
      this.manifest = { format: 1, id: randomUUID(), createdAtMs: Date.now() };
      atomicJson(filename, this.manifest);
    }
    const indexRoot = directory(
      path.join(directory(path.join(dataRoot, 'indexes')), this.manifest.id),
    );
    this.indexFile = path.join(indexRoot, 'metadata.sqlite');
    let checkpoint = this.manifest.checkpoint;
    if (!present(this.indexFile) && checkpoint) {
      let valid = false;
      for (const candidate of [checkpoint, this.manifest.previous]) {
        if (!candidate) continue;
        try {
          if (fileHash(path.join(mediaRoot, candidate.file)) === candidate.hash) {
            checkpoint = candidate;
            valid = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      if (!valid) throw Error('LIBRARY_CHECKPOINT_CORRUPT');
      const source = path.join(mediaRoot, checkpoint.file);
      const temporary = `${this.indexFile}.restore`;
      present(temporary);
      copyFileSync(source, temporary);
      const fd = openSync(temporary, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.indexFile);
      syncDirectory(indexRoot);
    }
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      if (present(this.indexFile + suffix)) regularFile(this.indexFile + suffix);
  }
  async attach(db: DatabaseSync): Promise<void> {
    this.attached = db;
    db.exec(
      'CREATE TABLE IF NOT EXISTS library_state(id INTEGER PRIMARY KEY CHECK(id=1),library TEXT NOT NULL,sequence INTEGER NOT NULL)',
    );
    db.prepare('INSERT OR IGNORE INTO library_state VALUES(1,?,0)').run(this.manifest.id);
    const state = db.prepare('SELECT library,sequence FROM library_state WHERE id=1').get() as {
      library: string;
      sequence: number;
    };
    if (state.library !== this.manifest.id) throw Error('LIBRARY_INDEX_IDENTITY_MISMATCH');
    this.sequence = state.sequence;
    const files = readdirSync(this.journalRoot)
      .filter((name) => sealedPattern.test(name))
      .sort((a, b) => Number(sealedPattern.exec(a)![1]) - Number(sealedPattern.exec(b)![1]));
    let durableSequence = this.manifest.checkpoint?.sequence ?? 0;
    for (const filename of files) {
      const match = sealedPattern.exec(filename)!,
        end = Number(match[2]);
      // Reconstruct unfinished work from the existing startup inventory. Logs
      // retained only for the previous checkpoint are already covered.
      if (end > (this.manifest.checkpoint?.sequence ?? 0)) this.checkpointPending = true;
      durableSequence = Math.max(durableSequence, end);
      if (end > this.sequence && this.replay(db, filename, false) !== end)
        throw Error('LIBRARY_JOURNAL_SEQUENCE_GAP');
    }
    if (present(path.join(this.journalRoot, 'active.log')))
      durableSequence = Math.max(durableSequence, this.replay(db, 'active.log', true));
    if (state.sequence > durableSequence) throw Error('LIBRARY_JOURNAL_BEHIND_INDEX');
    if (this.sequence < (this.manifest.checkpoint?.sequence ?? 0))
      throw Error('LIBRARY_INDEX_BEHIND_CHECKPOINT');
    this.activeStart = this.activeFirst || durableSequence + 1;
    const active = path.join(this.journalRoot, 'active.log');
    this.fd = openSync(active, 'a+', 0o600);
    regularFile(active);
    syncDirectory(this.journalRoot);
    this.journalBytes = fstatSync(this.fd).size;
    if (!this.manifest.checkpoint) await this.checkpoint();
  }
  private replay(db: DatabaseSync, filename: string, active: boolean): number {
    const source = path.join(this.journalRoot, filename);
    regularFile(source);
    const fd = openSync(source, 'r'),
      size = fstatSync(fd).size;
    let offset = 0,
      last = 0;
    // Headers and payloads are small, but HDD/shared-mount I/O must stay large
    // and sequential. Keep memory bounded independently of journal length.
    const block = Buffer.alloc(256 * 1024);
    let blockStart = -1,
      blockSize = 0;
    const readAt = (destination: Buffer, position: number): number => {
      let copied = 0;
      while (copied < destination.length) {
        const at = position + copied;
        if (at < blockStart || at >= blockStart + blockSize) {
          blockStart = at;
          blockSize = readSync(fd, block, 0, block.length, at);
          if (!blockSize) break;
        }
        const start = at - blockStart,
          size = Math.min(destination.length - copied, blockSize - start);
        block.copy(destination, copied, start, start + size);
        copied += size;
      }
      return copied;
    };
    try {
      while (offset < size) {
        const header = Buffer.alloc(HEADER),
          headerSize = readAt(header, offset);
        if (headerSize < HEADER) {
          if (!active) throw Error('LIBRARY_JOURNAL_TRUNCATED');
          break;
        }
        const length = header.readUInt32BE(4),
          sequence = Number(header.readBigUInt64BE(8));
        if (
          header.toString('ascii', 0, 4) !== 'STJ1' ||
          !length ||
          length > MAX_CHANGESET ||
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          (last && sequence !== last + 1)
        )
          throw Error('LIBRARY_JOURNAL_CORRUPT');
        const payload = Buffer.alloc(length);
        if (readAt(payload, offset + HEADER) !== length) {
          if (!active) throw Error('LIBRARY_JOURNAL_TRUNCATED');
          break;
        }
        if (
          !createHash('sha256')
            .update(header.subarray(0, 16))
            .update(payload)
            .digest()
            .equals(header.subarray(16))
        )
          throw Error('LIBRARY_JOURNAL_CORRUPT');
        if (active && !last) this.activeFirst = sequence;
        if (sequence > this.sequence) {
          if (sequence !== this.sequence + 1) throw Error('LIBRARY_JOURNAL_SEQUENCE_GAP');
          db.exec('BEGIN IMMEDIATE');
          try {
            const tables = new Set(
              (
                db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
                  name: string;
                }[]
              ).map((row) => row.name),
            );
            if (
              !db.applyChangeset(payload, {
                filter: (table) => {
                  if (table === 'library_state' || !tables.has(table))
                    throw Error('LIBRARY_CHANGESET_SCHEMA_MISMATCH');
                  return true;
                },
              })
            )
              throw Error('LIBRARY_CHANGESET_CONFLICT');
            db.prepare('UPDATE library_state SET sequence=? WHERE id=1').run(sequence);
            db.exec('COMMIT');
            this.sequence = sequence;
            this.replayed++;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }
        last = sequence;
        offset += HEADER + length;
        this.recordsRead++;
        this.bytesRead += HEADER + length;
      }
    } finally {
      closeSync(fd);
    }
    if (active && offset < size) {
      truncateSync(source, offset);
      const fd = openSync(source, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return last;
  }
  transaction<T>(db: DatabaseSync, action: () => T): T {
    if (this.poisoned || this.fd === undefined) throw Error('LIBRARY_REQUIRES_RECOVERY');
    if (db.isTransaction) return action();
    const session = db.createSession();
    let publishing = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      const value = action(),
        changes = session.changeset();
      if (changes.length) {
        if (changes.length > MAX_CHANGESET) throw Error('LIBRARY_TRANSACTION_TOO_LARGE');
        const sequence = this.sequence + 1,
          header = Buffer.alloc(HEADER);
        header.write('STJ1');
        header.writeUInt32BE(changes.length, 4);
        header.writeBigUInt64BE(BigInt(sequence), 8);
        createHash('sha256')
          .update(header.subarray(0, 16))
          .update(changes)
          .digest()
          .copy(header, 16);
        publishing = true;
        this.append(Buffer.concat([header, changes]));
        this.fault?.('after-journal-sync');
        db.prepare('UPDATE library_state SET sequence=? WHERE id=1').run(sequence);
        db.exec('COMMIT');
        this.sequence = sequence;
        this.fault?.('after-index-commit');
      } else db.exec('COMMIT');
      return value;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (publishing) this.poisoned = true;
      throw error;
    } finally {
      session.close();
    }
  }
  private append(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(this.fd!, bytes, offset);
      if (!written) throw Error('LIBRARY_JOURNAL_WRITE_FAILED');
      offset += written;
    }
    fsyncSync(this.fd!);
    this.journalBytes += bytes.length;
  }
  checkpoint(): Promise<void> {
    if (this.closing) return Promise.reject(Error('LIBRARY_CLOSED'));
    if (this.checkpointing) return this.checkpointing;
    if (!this.attached || this.poisoned) return Promise.reject(Error('LIBRARY_REQUIRES_RECOVERY'));
    this.checkpointing = this.saveCheckpoint()
      .then(
        () => {
          this.checkpointFailed = false;
        },
        (error) => {
          if (
            error instanceof CheckpointCancelled ||
            (this.closeController.signal.aborted &&
              error instanceof Error &&
              error.name === 'AbortError')
          )
            return;
          this.checkpointFailed = true;
          this.checkpointRetryAt = Date.now() + 30000;
          throw error;
        },
      )
      .finally(() => {
        this.checkpointing = undefined;
      });
    return this.checkpointing;
  }
  private async saveCheckpoint(): Promise<void> {
    if (this.fd === undefined) throw Error('LIBRARY_CLOSED');
    if (this.journalBytes) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = undefined;
      renameSync(
        path.join(this.journalRoot, 'active.log'),
        path.join(this.journalRoot, `${this.activeStart}-${this.sequence}.log`),
      );
      this.checkpointPending = true;
      this.activeStart = this.sequence + 1;
      this.fd = openSync(path.join(this.journalRoot, 'active.log'), 'a+', 0o600);
      this.journalBytes = 0;
      syncDirectory(this.journalRoot);
    }
    const temporary = path.join(this.mediaRoot, 'catalog', `${randomUUID()}.tmp`);
    try {
      // Node's asynchronous backup must not share the connection executing RPC
      // transactions. A separate WAL reader lets recording commits keep flowing.
      const source = new DatabaseSync(this.indexFile, { readOnly: true });
      try {
        // Pin a WAL read snapshot. Without this transaction, each concurrent
        // writer can restart SQLite's incremental backup from its first page.
        source.exec('BEGIN');
        source.prepare('SELECT sequence FROM library_state WHERE id=1').get();
        await backup(source, temporary, {
          rate: 64,
          progress: () => {
            if (this.closing) throw new CheckpointCancelled();
          },
        });
      } finally {
        try {
          if (source.isTransaction) source.exec('ROLLBACK');
        } finally {
          source.close();
        }
      }
      if (this.closing) throw new CheckpointCancelled();
      const snapshot = new DatabaseSync(temporary, { readOnly: true });
      let sequence: number;
      try {
        sequence = Number(
          snapshot.prepare('SELECT sequence FROM library_state WHERE id=1').get()!.sequence,
        );
      } finally {
        snapshot.close();
      }
      const fd = openSync(temporary, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.fault?.('before-checkpoint-hash');
      const checkpoint: Checkpoint = {
        file: `catalog/${sequence}.sqlite`,
        sequence,
        hash: await fileHashAsync(temporary, this.closeController.signal),
      };
      if (this.closing) throw new CheckpointCancelled();
      this.fault?.('before-checkpoint-publish');
      const filename = path.join(this.mediaRoot, checkpoint.file);
      if (this.manifest.checkpoint?.sequence === sequence) {
        unlinkSync(temporary);
        this.checkpointPending = false;
        return;
      }
      renameSync(temporary, filename);
      syncDirectory(path.dirname(filename));
      const previous = this.manifest.checkpoint;
      atomicJson(path.join(this.mediaRoot, 'library.json'), {
        ...this.manifest,
        checkpoint,
        previous,
      });
      this.manifest.checkpoint = checkpoint;
      this.checkpointPending = false;
      this.manifest.previous = previous;
      this.checkpointAt = Date.now();
      for (const name of readdirSync(this.journalRoot)) {
        const match = sealedPattern.exec(name);
        if (match && Number(match[2]) <= (previous?.sequence ?? 0)) {
          const filename = path.join(this.journalRoot, name);
          regularFile(filename);
          unlinkSync(filename);
        }
      }
      for (const name of readdirSync(path.join(this.mediaRoot, 'catalog')))
        if (
          /^[0-9]+\.sqlite$/.test(name) &&
          ![checkpoint.file, previous?.file].includes(`catalog/${name}`)
        ) {
          const filename = path.join(this.mediaRoot, 'catalog', name);
          regularFile(filename);
          unlinkSync(filename);
        }
      syncDirectory(this.journalRoot);
    } finally {
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const filename = temporary + suffix;
        if (present(filename)) {
          regularFile(filename);
          unlinkSync(filename);
        }
      }
    }
  }
  needsCheckpoint(): boolean {
    return (
      !this.closing &&
      !this.checkpointing &&
      Date.now() >= this.checkpointRetryAt &&
      (this.checkpointPending ||
        this.checkpointFailed ||
        (this.journalBytes >= 64 * 1024 ** 2 && Date.now() - this.checkpointAt > 60000))
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
      checkpointFailed: this.checkpointFailed,
      requiresRecovery: this.poisoned || this.fd === undefined,
      journalBytes: this.journalBytes,
      checkpointing: !!this.checkpointing,
    };
  }
  async close(): Promise<void> {
    this.closing = true;
    this.closeController.abort();
    try {
      await this.checkpointing;
    } finally {
      // Checkpoints are derived. A cancelled copy retains all sealed/active
      // journal records and the prior checkpoint, which remain authoritative.
      if (this.fd !== undefined) {
        const fd = this.fd;
        this.fd = undefined;
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
  }
}
