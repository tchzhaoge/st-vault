import path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { directory, regularFile, atomicJson, libraryIdPattern } from './files.js';
import type { SqlDatabase } from '../database/sql.js';
import { PortableTransactions } from '../database/portable-transactions.js';
export interface Checkpoint {
  file: string;
  sequence: number;
  hash: string;
}
export interface LibraryManifest {
  format: 2;
  id: string;
  createdAtMs: number;
  checkpoint?: Checkpoint;
  previous?: Checkpoint;
}
export type LibraryFault = (
  point:
    | 'after-journal-sync'
    | 'after-index-commit'
    | 'before-checkpoint-hash'
    | 'before-checkpoint-publish',
) => void;
function libraryError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const codes: Record<string, string> = {
    PORTABLE_JOURNAL_CORRUPT: 'LIBRARY_JOURNAL_CORRUPT',
    PORTABLE_JOURNAL_BEHIND_DATABASE: 'LIBRARY_JOURNAL_BEHIND_INDEX',
    PORTABLE_CHECKPOINT_CORRUPT: 'LIBRARY_CHECKPOINT_CORRUPT',
    PORTABLE_LIBRARY_MISMATCH: 'LIBRARY_INDEX_IDENTITY_MISMATCH',
    PORTABLE_LIBRARY_REQUIRES_RECOVERY: 'LIBRARY_REQUIRES_RECOVERY',
    UNSAFE_PORTABLE_JOURNAL: 'UNSAFE_DATABASE_PATH',
  };
  return codes[error.message] ? Error(codes[error.message], { cause: error }) : error;
}
/** The portable library is authoritative; PostgreSQL is its concurrent hot projection. */
export class LibraryStorage {
  readonly dataRoot: string;
  readonly mediaRoot: string;
  readonly indexFile: string;
  readonly manifest: LibraryManifest;
  private readonly fault?: LibraryFault;
  private journal: PortableTransactions | undefined;
  constructor(dataRoot: string, mediaRoot: string, fault?: LibraryFault, seed?: LibraryManifest) {
    this.dataRoot = directory(dataRoot);
    this.mediaRoot = directory(mediaRoot);
    this.fault = fault;
    const filename = path.join(mediaRoot, 'library.json');
    if (seed) {
      this.manifest = seed;
    } else if (existsSync(filename)) {
      regularFile(filename);
      const value = JSON.parse(readFileSync(filename, 'utf8')) as LibraryManifest;
      if (value.format !== 2) throw Error('LIBRARY_MIGRATION_REQUIRED');
      if (!libraryIdPattern.test(value.id) || !Number.isSafeInteger(value.createdAtMs))
        throw Error('INVALID_LIBRARY_MANIFEST');
      this.manifest = value;
    } else {
      if (readdirSync(mediaRoot).some((name) => name !== '.instance.lock'))
        throw Error('LIBRARY_MANIFEST_REQUIRED');
      this.manifest = { format: 2, id: randomUUID(), createdAtMs: Date.now() };
      atomicJson(filename, this.manifest);
    }
    this.indexFile = path.join(this.dataRoot, 'indexes', this.manifest.id);
  }
  async attach(db: SqlDatabase): Promise<void> {
    const tables = await db
      .prepare(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'stv_library_state' ORDER BY tablename",
      )
      .all<{ name: string }>();
    this.journal = await PortableTransactions.open(db.postgres, {
      mediaRoot: this.mediaRoot,
      libraryId: this.manifest.id,
      tables: tables.map((row) => row.name),
      checkpoint: this.manifest.checkpoint,
      previous: this.manifest.previous,
      publishCheckpoint: (checkpoint: Checkpoint, previous: Checkpoint | undefined) => {
        const next = { ...this.manifest, checkpoint, previous };
        atomicJson(path.join(this.mediaRoot, 'library.json'), next);
        Object.assign(this.manifest, next);
      },
      fault: (point) => {
        if (point === 'after-portable-sync') this.fault?.('after-journal-sync');
        else if (point === 'after-postgres-commit') this.fault?.('after-index-commit');
        else if (point === 'before-checkpoint-publish') this.fault?.('before-checkpoint-publish');
      },
    }).catch((error: unknown) => {
      throw libraryError(error);
    });
  }
  transaction<T>(_db: SqlDatabase, action: () => Promise<T>): Promise<T> {
    if (!this.journal) throw Error('LIBRARY_REQUIRES_RECOVERY');
    return this.journal.transaction(action);
  }
  needsCheckpoint(): boolean {
    return this.journal?.needsCheckpoint() ?? false;
  }
  checkpoint(): Promise<void> {
    if (!this.journal) throw Error('LIBRARY_REQUIRES_RECOVERY');
    return this.journal.checkpoint();
  }
  status() {
    return (
      this.journal?.status() ?? {
        sequence: 0,
        replayed: 0,
        recordsRead: 0,
        bytesRead: 0,
        journalBytes: 0,
        checkpointing: false,
        checkpointFailed: false,
        requiresRecovery: false,
      }
    );
  }
  async close(): Promise<void> {
    await this.journal?.close();
  }
}
