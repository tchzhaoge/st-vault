import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../database/sql.js';
import type { MediaSelectionResult } from '@st-vault/api-schema';
import type { MediaSelectionStore } from './media-selection-store.js';
/** The accepted command is the logical truth; the physical favorite table is a resumable projection. */
export class FavoriteCommands {
  private readonly db: SqlDatabase;
  private readonly selections: MediaSelectionStore;
  constructor(db: SqlDatabase, selections: MediaSelectionStore) {
    this.db = db;
    this.selections = selections;
  }
  async initialize(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS favorite_commands(
      id TEXT PRIMARY KEY,seq BIGINT NOT NULL UNIQUE,subject TEXT NOT NULL,selection TEXT NOT NULL,
      liked BIGINT NOT NULL,total BIGINT NOT NULL,processed BIGINT NOT NULL DEFAULT 0,
      cursor TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',created BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS favorite_command_pending ON favorite_commands(state,seq);
      CREATE OR REPLACE VIEW unit_favorite_facts AS
      SELECT u.id unit,COALESCE((SELECT c.created FROM favorite_commands c JOIN selection_units x ON x.selection=c.selection
        WHERE x.unit=u.id AND c.state='pending' ORDER BY c.seq DESC LIMIT 1),f.created) created
      FROM recording_units u LEFT JOIN unit_favorites f ON f.unit=u.id WHERE u.deleted=0
      AND COALESCE((SELECT c.liked FROM favorite_commands c JOIN selection_units x ON x.selection=c.selection
        WHERE x.unit=u.id AND c.state='pending' ORDER BY c.seq DESC LIMIT 1),CASE WHEN f.unit IS NOT NULL THEN 1 ELSE 0 END)=1;
      CREATE OR REPLACE VIEW effective_unit_favorites AS SELECT f.* FROM unit_favorite_facts f
      JOIN visible_recording_units u ON u.id=f.unit;`);
  }
  async accept(
    subject: string,
    selection: string,
    liked: boolean,
    revision: number,
  ): Promise<MediaSelectionResult> {
    const current = await this.selections.summary(subject, selection);
    if (revision !== current.personalRevision) throw Error('PERSONAL_REVISION_STALE');
    if (!current.count) return { subjectId: subject, revision, count: 0 };
    const id = randomUUID(),
      seq = revision + 1;
    await this.selections.pin(selection, id);
    await this.db
      .prepare(
        'INSERT INTO favorite_commands(id,seq,subject,selection,liked,total,created) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, seq, subject, selection, Number(liked), current.count, Date.now());
    await this.db.prepare('UPDATE personal_owner SET revision=? WHERE id=1').run(seq);
    return { subjectId: subject, revision: seq, count: current.count };
  }
  /** Source targets and cursor are committed together; replay cannot lose or reorder an operation. */
  async subjects(limit = 1, excludedSubjects: readonly string[] = []): Promise<string[]> {
    return (
      await this.db
        .prepare(
          "SELECT subject FROM favorite_commands WHERE state='pending' AND subject NOT IN(SELECT value FROM json_array_elements_text(?::json) AS busy(value)) GROUP BY subject ORDER BY min(seq) LIMIT ?",
        )
        .all<{ subject: string }>(JSON.stringify(excludedSubjects), limit)
    ).map((row) => row.subject);
  }
  async step(subject?: string): Promise<boolean> {
    const command = await this.db
      .prepare(
        "SELECT * FROM favorite_commands WHERE state='pending' AND (?::text IS NULL OR subject=?) ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
      .get<{
        id: string;
        selection: string;
        liked: number;
        created: number;
        cursor: string;
      }>(subject ?? null, subject ?? null);
    if (!command) return false;
    const rows = await this.db
      .prepare(
        'SELECT unit FROM selection_units WHERE selection=? AND unit>? ORDER BY unit LIMIT 256',
      )
      .all<{
        unit: string;
      }>(command.selection, command.cursor);
    const members = JSON.stringify(rows.map((row) => row.unit));
    if (command.liked)
      await this.db
        .prepare(
          `INSERT INTO unit_favorites(unit,created) SELECT value,?::bigint
       FROM json_array_elements_text(?::json) AS candidate(value) WHERE true ON CONFLICT DO NOTHING`,
        )
        .run(command.created, members);
    else
      await this.db
        .prepare(
          'DELETE FROM unit_favorites WHERE unit IN(SELECT value FROM json_array_elements_text(?::json) AS candidate(value))',
        )
        .run(members);
    await this.db
      .prepare('UPDATE favorite_commands SET cursor=?,processed=processed+?,state=? WHERE id=?')
      .run(
        rows.at(-1)?.unit ?? command.cursor,
        rows.length,
        rows.length < 256 ? 'completed' : 'pending',
        command.id,
      );
    if (rows.length < 256) await this.selections.unpin(command.selection, command.id);
    // Completed heads contain no target rows; one bounded metadata deletion per projection step.
    await this.db
      .prepare(
        "DELETE FROM favorite_commands WHERE id IN(SELECT id FROM favorite_commands WHERE state='completed' ORDER BY seq DESC LIMIT 1 OFFSET 20)",
      )
      .run();
    return true;
  }
  async status(): Promise<{
    pending: number;
    processed: number;
    total: number;
  }> {
    return (await this.db
      .prepare(
        "SELECT count(*) pending,COALESCE(sum(processed),0)::bigint processed,COALESCE(sum(total),0)::bigint total FROM favorite_commands WHERE state='pending'",
      )
      .get<{
        pending: number;
        processed: number;
        total: number;
      }>())!;
  }
}
