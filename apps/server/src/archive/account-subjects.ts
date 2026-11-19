import type { SqlDatabase } from '../database/sql.js';
import type { SubjectInput } from '../ports.js';
/** Only public list data and an opaque activation ID enter the portable library. */
export class AccountSubjects {
  private readonly db: SqlDatabase;
  private readonly add: (subject: SubjectInput, trackNames: boolean) => Promise<void>;
  private readonly disable: (id: string) => Promise<void>;
  constructor(
    db: SqlDatabase,
    add: (subject: SubjectInput, trackNames: boolean) => Promise<void>,
    disable: (id: string) => Promise<void>,
  ) {
    this.db = db;
    this.add = add;
    this.disable = disable;
  }
  async initialize(): Promise<void> {
    const db = this.db;
    await db.exec(
      'CREATE TABLE IF NOT EXISTS account_preparations(generation TEXT PRIMARY KEY,subjects TEXT NOT NULL,created BIGINT NOT NULL)',
    );
  }
  async upsert(subjects: SubjectInput[], syncAccount = false): Promise<void> {
    const inherit =
      (
        await this.db
          .prepare("SELECT value FROM settings WHERE key='recording.default'")
          .get<{ value: string }>()
      )?.value === 'true';
    const existing = inherit
      ? new Map(
          (
            await this.db
              .prepare(
                'SELECT s.id,a.following FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id',
              )
              .all<{ id: string; following: number | null }>()
          ).map((row) => [row.id, row.following]),
        )
      : null;
    // Discard old archived choices; re-following inherits the current default.
    if (syncAccount)
      await this.db.exec(
        'UPDATE subjects SET auto_record=0 WHERE auto_record=1 AND id IN(SELECT subject FROM account_subjects WHERE following=0)',
      );
    for (const subject of subjects) {
      await this.add(subject, syncAccount);
      // Existing per-model choices survive ordinary sync and online transitions.
      if (
        existing &&
        (!existing.has(subject.id) || (syncAccount && existing.get(subject.id) === 0))
      )
        await this.db
          .prepare('UPDATE subjects SET auto_record=1,monitor=1 WHERE id=?')
          .run(subject.id);
    }
    if (!syncAccount) return;
    // Every existing subject belongs to the account membership partition.
    const previous = await this.db
      .prepare(
        'SELECT s.id AS subject FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id WHERE a.following=1 OR a.subject IS NULL',
      )
      .all<{
        subject: string;
      }>();
    await this.db.exec(
      'INSERT INTO account_subjects SELECT id,0 FROM subjects ON CONFLICT(subject) DO NOTHING',
    );
    const current = new Set(subjects.map((s) => s.id));
    await this.db.exec('UPDATE account_subjects SET following=0 WHERE following=1');
    const follow = this.db.prepare(
      'INSERT INTO account_subjects VALUES(?,1) ON CONFLICT(subject) DO UPDATE SET following=1',
    );
    for (const subject of subjects) await follow.run(subject.id);
    for (const subject of previous)
      if (!current.has(subject.subject)) await this.disable(subject.subject);
  }
  async prepare(subjects: SubjectInput[], generation: string): Promise<void> {
    if ((await this.current()) === generation) return;
    // The account owner finishes accepted activation before preparing another.
    // Retire at most one orphan from a crash before private acceptance.
    await this.db
      .prepare(
        'DELETE FROM account_preparations WHERE generation IN(SELECT generation FROM account_preparations WHERE generation!=? ORDER BY created LIMIT 1)',
      )
      .run(generation);
    // Structural TypeScript types do not strip runtime extras at a persistence boundary.
    const json = JSON.stringify(
      subjects.map(({ id, providerId, handle, previewSourceUrl, avatarSourceUrl }) => ({
        id,
        providerId,
        handle,
        previewSourceUrl,
        avatarSourceUrl,
      })),
    );
    const previous = await this.db
      .prepare('SELECT subjects FROM account_preparations WHERE generation=?')
      .get<{
        subjects: string;
      }>(generation);
    if (previous && previous.subjects !== json) throw Error('ACCOUNT_ACTIVATION_CONFLICT');
    await this.db
      .prepare('INSERT INTO account_preparations VALUES(?,?,?) ON CONFLICT(generation) DO NOTHING')
      .run(generation, json, Date.now());
  }
  async activate(generation: string): Promise<void> {
    if ((await this.current()) === generation) return;
    const prepared = await this.db
      .prepare('SELECT subjects FROM account_preparations WHERE generation=?')
      .get<{
        subjects: string;
      }>(generation);
    if (!prepared) throw Error('ACCOUNT_ACTIVATION_MISSING');
    await this.upsert(JSON.parse(prepared.subjects) as SubjectInput[], true);
    await this.db
      .prepare(
        "INSERT INTO settings VALUES('account.activation-generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(generation);
    await this.discard(generation);
  }
  async current(): Promise<string | null> {
    return (
      (
        await this.db
          .prepare("SELECT value FROM settings WHERE key='account.activation-generation'")
          .get<{
            value: string;
          }>()
      )?.value ?? null
    );
  }
  async discard(generation: string): Promise<void> {
    await this.db.prepare('DELETE FROM account_preparations WHERE generation=?').run(generation);
  }
}
