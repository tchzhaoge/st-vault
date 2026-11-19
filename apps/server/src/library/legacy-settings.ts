import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import path from 'node:path';

/** An explicit library namespace prevents credentials entering portable checkpoints. */
export function portableSetting(key: string): boolean {
  return (
    key === 'timeline.deployed-at' ||
    key === 'account.activation-generation' ||
    ['archive.clean', 'archive.orphan-scan-pending'].includes(key) ||
    key.startsWith('preview.')
  );
}
export class PrivateSettings {
  private readonly db: DatabaseSync;
  constructor(root: string) {
    const filename = path.join(root, 'app.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      try {
        const info = lstatSync(filename + suffix);
        if (!info.isFile() || info.isSymbolicLink()) throw Error('UNSAFE_PRIVATE_DATABASE');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    this.db = new DatabaseSync(filename);
    this.db.exec(
      'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
  }
  get(key: string): string | null {
    return (
      (
        this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value',
      )
      .run(key, value);
  }
  close(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
