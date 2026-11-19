import { SqlDatabase } from '../database/sql.js';
import path from 'node:path';
/** Private credentials never enter portable media checkpoints. */
export function portableSetting(key: string): boolean {
  return (
    key === 'timeline.deployed-at' ||
    key === 'account.activation-generation' ||
    key === 'recording.default' ||
    ['archive.clean', 'archive.orphan-scan-pending'].includes(key) ||
    key.startsWith('preview.')
  );
}
export class PrivateSettings {
  private readonly db: SqlDatabase;
  private constructor(db: SqlDatabase) {
    this.db = db;
  }
  static async open(root: string): Promise<PrivateSettings> {
    const db = await SqlDatabase.open(path.join(root, 'private'));
    try {
      await db.exec(
        'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      );
      return new PrivateSettings(db);
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  async get(key: string): Promise<string | null> {
    return (
      (await this.db.prepare('SELECT value FROM settings WHERE key=?').get<{ value: string }>(key))
        ?.value ?? null
    );
  }
  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value<>excluded.value',
      )
      .run(key, value);
  }
  close(): Promise<void> {
    return this.db.close();
  }
}
