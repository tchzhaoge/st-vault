import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../database/sql.js';
import type {
  MediaSelection,
  MediaSelectionPatch,
  MediaTimeRange,
  MediaSelectionMode,
  MediaSelectionOptions,
} from '@st-vault/api-schema';
interface SelectionRow {
  id: string;
  subject: string;
  from_ms: number;
  to_ms: number;
  mode: string;
  cutoff: number;
  personal: number;
  deletion: number;
  count: number;
  cursor_start: number;
  cursor_id: string;
  ready: number;
  created: number;
  base: string | null;
  copy_cursor: string;
  retiring: number;
}
/** Frozen membership; preparation, copying and retirement each yield after 256 keys. */
export class MediaSelectionStore {
  private readonly db: SqlDatabase;
  private readonly contentRevision: () => Promise<number>;
  constructor(db: SqlDatabase, contentRevision: () => Promise<number>) {
    this.db = db;
    this.contentRevision = contentRevision;
  }
  async initialize(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS media_selections(
      id TEXT PRIMARY KEY,subject TEXT NOT NULL REFERENCES subjects(id) DEFERRABLE INITIALLY DEFERRED,from_ms BIGINT NOT NULL,
      to_ms BIGINT NOT NULL,mode TEXT NOT NULL,cutoff BIGINT NOT NULL,personal BIGINT NOT NULL,
      deletion BIGINT NOT NULL,count BIGINT NOT NULL DEFAULT 0,cursor_start BIGINT NOT NULL DEFAULT -1,
      cursor_id TEXT NOT NULL DEFAULT '',ready BIGINT NOT NULL DEFAULT 0,created BIGINT NOT NULL,
      base TEXT,copy_cursor TEXT NOT NULL DEFAULT '',retiring BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS selection_units(selection TEXT NOT NULL REFERENCES media_selections(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        unit TEXT NOT NULL REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(selection,unit));
      CREATE INDEX IF NOT EXISTS selection_unit_reverse ON selection_units(unit,selection);
      CREATE TABLE IF NOT EXISTS selection_edits(selection TEXT NOT NULL REFERENCES media_selections(id) DEFERRABLE INITIALLY DEFERRED,
        unit TEXT NOT NULL,include BIGINT NOT NULL,PRIMARY KEY(selection,unit));
      CREATE TABLE IF NOT EXISTS selection_pins(selection TEXT NOT NULL REFERENCES media_selections(id) DEFERRABLE INITIALLY DEFERRED,
        owner TEXT NOT NULL,PRIMARY KEY(selection,owner));
      CREATE TABLE IF NOT EXISTS selection_deletion_copies(job TEXT PRIMARY KEY,selection TEXT NOT NULL,
        cursor TEXT NOT NULL DEFAULT '');`);
  }
  private async versions(subject: string): Promise<{
    personal: number;
    deletion: number;
  }> {
    const row = await this.db.prepare('SELECT deletion_revision FROM subjects WHERE id=?').get<{
      deletion_revision: number;
    }>(subject);
    if (!row) throw Error('SUBJECT_NOT_FOUND');
    return {
      personal: (await this.db.prepare('SELECT revision FROM personal_owner WHERE id=1').get<{
        revision: number;
      }>())!.revision,
      deletion: row.deletion_revision,
    };
  }
  async begin(
    subject: string,
    window: MediaTimeRange,
    mode: MediaSelectionMode,
    options: MediaSelectionOptions = {},
  ): Promise<string> {
    const versions = await this.versions(subject);
    if (options.baseSelectionId) await this.summary(subject, options.baseSelectionId);
    const count = (await this.db
      .prepare('SELECT count(*) n FROM media_selections WHERE retiring=0')
      .get<{
        n: number;
      }>())!.n;
    // Retirement never cascades a large membership set in the request transaction.
    if (count >= 64) {
      const oldest = await this.db
        .prepare(
          `SELECT id FROM media_selections p WHERE id<>? AND retiring=0
        AND NOT EXISTS(SELECT 1 FROM selection_pins x WHERE x.selection=p.id) ORDER BY created,id LIMIT 1`,
        )
        .get<{
          id: string;
        }>(options.baseSelectionId ?? '');
      if (!oldest) throw Error('MEDIA_SELECTION_QUEUE_FULL');
      await this.db.prepare('UPDATE media_selections SET retiring=1 WHERE id=?').run(oldest.id);
    }
    const id = randomUUID();
    await this.db
      .prepare(
        'INSERT INTO media_selections(id,subject,from_ms,to_ms,mode,cutoff,personal,deletion,created,base) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        subject,
        window.fromMs,
        window.toMs,
        mode,
        await this.contentRevision(),
        versions.personal,
        versions.deletion,
        Date.now(),
        options.baseSelectionId ?? null,
      );
    if (options.baseSelectionId) await this.pin(options.baseSelectionId, id);
    await this.patch(subject, id, options, false);
    return id;
  }
  async pin(id: string, owner: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO selection_pins VALUES(?,?) ON CONFLICT DO NOTHING')
      .run(id, owner);
  }
  async unpin(id: string, owner: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM selection_pins WHERE selection=? AND owner=?')
      .run(id, owner);
  }
  private async get(subject: string, id: string): Promise<SelectionRow> {
    const row = await this.db
      .prepare('SELECT * FROM media_selections WHERE id=? AND subject=? AND retiring=0')
      .get<SelectionRow>(id, subject);
    if (!row || row.created < Date.now() - 86400000) throw Error('MEDIA_SELECTION_STALE');
    const versions = await this.versions(subject);
    if (versions.personal !== row.personal || versions.deletion !== row.deletion)
      throw Error('MEDIA_SELECTION_STALE');
    return row;
  }
  async build(subject: string, id: string): Promise<boolean> {
    const p = await this.get(subject, id);
    if (p.ready) return false;
    let inserted = 0;
    if (p.base) {
      const rows = await this.db
        .prepare(
          'SELECT unit FROM selection_units WHERE selection=? AND unit>? ORDER BY unit LIMIT 256',
        )
        .all<{
          unit: string;
        }>(p.base, p.copy_cursor);
      inserted = (
        await this.db
          .prepare(
            `INSERT INTO selection_units(selection,unit) SELECT ?,value
         FROM json_array_elements_text(?::json) AS candidate(value)
         WHERE NOT EXISTS(SELECT 1 FROM selection_edits e WHERE e.selection=? AND e.unit=candidate.value AND e.include=0)
         ON CONFLICT DO NOTHING`,
          )
          .run(id, JSON.stringify(rows.map((row) => row.unit)), id)
      ).changes;
      await this.db
        .prepare('UPDATE media_selections SET count=count+?,copy_cursor=?,base=? WHERE id=?')
        .run(inserted, rows.at(-1)?.unit ?? p.copy_cursor, rows.length === 256 ? p.base : null, id);
      if (rows.length < 256) await this.unpin(p.base, id);
      return true;
    }
    if (p.mode === 'explicit') {
      await this.db.prepare('UPDATE media_selections SET ready=1 WHERE id=?').run(id);
      return false;
    }
    // Scan candidates, not matches: a long invisible/unliked run cannot monopolize a batch.
    const rows = await this.db
      .prepare(
        `SELECT u.id,u.start FROM recording_units u WHERE u.subject=? AND u.deleted=0
      AND u.created_revision<=? AND u.start>? AND u.start<? AND (u.start,u.id)>(?,?) ORDER BY u.start,u.id LIMIT 256`,
      )
      .all<{
        id: string;
        start: number;
      }>(
        subject,
        p.cutoff,
        Math.max(-1, p.from_ms - 86460000),
        p.to_ms,
        p.cursor_start,
        p.cursor_id,
      );
    inserted = (
      await this.db
        .prepare(
          `INSERT INTO selection_units(selection,unit) SELECT ?,u.id FROM visible_recording_units u
       WHERE u.id IN(SELECT value FROM json_array_elements_text(?::json) AS candidate(value))
       AND NOT EXISTS(SELECT 1 FROM selection_edits e WHERE e.selection=? AND e.unit=u.id AND e.include=0)
       AND (?::text<>'unliked' OR NOT EXISTS(SELECT 1 FROM effective_unit_favorites f WHERE f.unit=u.id))
       AND EXISTS(SELECT 1 FROM unit_segments m JOIN segments s ON s.id=m.segment
         WHERE m.unit=u.id AND s.deleted=0 AND s.created_revision<=? AND s."end">?)
       ON CONFLICT DO NOTHING`,
        )
        .run(id, JSON.stringify(rows.map((row) => row.id)), id, p.mode, p.cutoff, p.from_ms)
    ).changes;
    const last = rows.at(-1);
    await this.db
      .prepare(
        'UPDATE media_selections SET count=count+?,cursor_start=?,cursor_id=?,ready=? WHERE id=?',
      )
      .run(
        inserted,
        last?.start ?? p.cursor_start,
        last?.id ?? p.cursor_id,
        rows.length < 256 ? 1 : 0,
        id,
      );
    return rows.length === 256;
  }
  async summary(subject: string, id: string): Promise<MediaSelection> {
    const row = await this.get(subject, id);
    if (!row.ready) throw Error('MEDIA_SELECTION_STALE');
    return {
      id,
      subjectId: subject,
      fromMs: row.from_ms,
      toMs: row.to_ms,
      count: row.count,
      personalRevision: row.personal,
      deletionRevision: row.deletion,
    };
  }
  async patch(
    subject: string,
    id: string,
    patch: MediaSelectionPatch,
    requireReady = true,
  ): Promise<void> {
    if (requireReady) await this.summary(subject, id);
    else await this.get(subject, id);
    const includes = [...new Set(patch.includeUnitIds ?? [])],
      excludes = [...new Set(patch.excludeUnitIds ?? [])];
    if (includes.length + excludes.length > 256) throw Error('MEDIA_SELECTION_BATCH_TOO_LARGE');
    let delta = 0;
    if (includes.length) {
      const members = JSON.stringify(includes);
      const eligible = await this.db
        .prepare(
          `SELECT count(*) AS count FROM visible_recording_units u WHERE u.subject=?
         AND u.id IN(SELECT value FROM json_array_elements_text(?::json) AS candidate(value))`,
        )
        .get<{
          count: number;
        }>(subject, members);
      if (eligible?.count !== includes.length) throw Error('MEDIA_SELECTION_STALE');
      await this.db
        .prepare(
          `INSERT INTO selection_edits(selection,unit,include) SELECT ?,value,1
         FROM json_array_elements_text(?::json) AS candidate(value) WHERE true
         ON CONFLICT(selection,unit) DO UPDATE SET include=excluded.include`,
        )
        .run(id, members);
      delta += (
        await this.db
          .prepare(
            `INSERT INTO selection_units(selection,unit) SELECT ?,value
         FROM json_array_elements_text(?::json) AS candidate(value) WHERE true ON CONFLICT DO NOTHING`,
          )
          .run(id, members)
      ).changes;
    }
    if (excludes.length) {
      const members = JSON.stringify(excludes);
      await this.db
        .prepare(
          `INSERT INTO selection_edits(selection,unit,include) SELECT ?,value,0
         FROM json_array_elements_text(?::json) AS candidate(value) WHERE true
         ON CONFLICT(selection,unit) DO UPDATE SET include=excluded.include`,
        )
        .run(id, members);
      delta -= (
        await this.db
          .prepare(
            `DELETE FROM selection_units WHERE selection=? AND unit IN(
          SELECT value FROM json_array_elements_text(?::json) AS candidate(value))`,
          )
          .run(id, members)
      ).changes;
    }
    await this.db.prepare('UPDATE media_selections SET count=count+? WHERE id=?').run(delta, id);
  }
  async copyToDeletion(
    subject: string,
    id: string,
    job: string,
    patch: MediaSelectionPatch,
  ): Promise<void> {
    await this.patch(subject, id, patch);
    await this.pin(id, job);
    await this.db
      .prepare('INSERT INTO selection_deletion_copies(job,selection) VALUES(?,?)')
      .run(job, id);
  }
  async copyDeletion(job: string): Promise<boolean> {
    const p = await this.db.prepare('SELECT * FROM selection_deletion_copies WHERE job=?').get<{
      selection: string;
      cursor: string;
    }>(job);
    if (!p) return false;
    const rows = await this.db
      .prepare(
        'SELECT unit FROM selection_units WHERE selection=? AND unit>? ORDER BY unit LIMIT 256',
      )
      .all<{
        unit: string;
      }>(p.selection, p.cursor);
    await this.db
      .prepare(
        `INSERT INTO deletion_units(job,unit) SELECT ?,value
      FROM json_array_elements_text(?::json) AS candidate(value) WHERE true ON CONFLICT DO NOTHING`,
      )
      .run(job, JSON.stringify(rows.map((row) => row.unit)));
    if (rows.length === 256)
      await this.db
        .prepare('UPDATE selection_deletion_copies SET cursor=? WHERE job=?')
        .run(rows.at(-1)!.unit, job);
    else {
      await this.unpin(p.selection, job);
      await this.db.prepare('DELETE FROM selection_deletion_copies WHERE job=?').run(job);
    }
    return true;
  }
  /** At most one 256-row child batch. No cascading deletion of unbounded targets. */
  async cleanup(): Promise<boolean> {
    const orphan = await this.db
      .prepare(
        `SELECT c.job,c.selection FROM selection_deletion_copies c LEFT JOIN media_deletions d ON d.id=c.job
      WHERE d.id IS NULL OR d.state='discarding' OR (d.state='planned' AND d.created<?) LIMIT 1`,
      )
      .get<{
        job: string;
        selection: string;
      }>(Date.now() - 3600000);
    if (orphan) {
      await this.unpin(orphan.selection, orphan.job);
      await this.db.prepare('DELETE FROM selection_deletion_copies WHERE job=?').run(orphan.job);
      return true;
    }
    const row = await this.db
      .prepare(
        `SELECT id,base FROM media_selections p WHERE NOT EXISTS(SELECT 1 FROM selection_pins x WHERE x.selection=p.id)
      AND (retiring=1 OR created<?) ORDER BY retiring DESC,created,id LIMIT 1`,
      )
      .get<{
        id: string;
        base: string | null;
      }>(Date.now() - 86400000);
    if (!row) return false;
    await this.db.prepare('UPDATE media_selections SET retiring=1 WHERE id=?').run(row.id);
    for (const table of ['selection_units', 'selection_edits']) {
      const changed = await this.db
        .prepare(
          `DELETE FROM ${table} WHERE selection=? AND unit IN(SELECT unit FROM ${table} WHERE selection=? ORDER BY unit LIMIT 256)`,
        )
        .run(row.id, row.id);
      if (changed.changes) return true;
    }
    if (row.base) await this.unpin(row.base, row.id);
    await this.db.prepare('DELETE FROM media_selections WHERE id=?').run(row.id);
    return true;
  }
}
