import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../database/sql.js';
import type { MediaDeletionJob, MediaDeletePlan, MediaTimeRange } from '@st-vault/api-schema';
export interface PendingDeletion extends MediaDeletionJob {
  segmentIds: string[];
}
const columns =
  'id,subject AS "subjectId",state,total,processed,reclaimed AS "reclaimedBytes",from_ms AS "fromMs",to_ms AS "toMs",created AS "createdAtMs",updated AS "updatedAtMs",error';
/** Plans are frozen in indexed rows. Neither RPC nor the executor loads the full file set. */
export class DeletionStore {
  private readonly db: SqlDatabase;
  private readonly revision: () => Promise<number>;
  constructor(db: SqlDatabase, revision: () => Promise<number>) {
    this.db = db;
    this.revision = revision;
  }
  async initialize(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS media_deletions(
      id TEXT PRIMARY KEY,subject TEXT NOT NULL REFERENCES subjects(id) DEFERRABLE INITIALLY DEFERRED,
      state TEXT NOT NULL,total BIGINT NOT NULL,processed BIGINT NOT NULL DEFAULT 0,
      reclaimed BIGINT NOT NULL DEFAULT 0,from_ms BIGINT,to_ms BIGINT,
      created BIGINT NOT NULL,updated BIGINT NOT NULL,error TEXT,retry_at BIGINT NOT NULL DEFAULT 0,
      attempts BIGINT NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS media_deletions_pending ON media_deletions(state,retry_at,created);
      CREATE TABLE IF NOT EXISTS deletion_plans(job TEXT PRIMARY KEY REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        ranges TEXT NOT NULL,cutoff BIGINT NOT NULL,revision BIGINT NOT NULL,cursor_start BIGINT NOT NULL DEFAULT -1,
        cursor_id TEXT NOT NULL DEFAULT '',ready BIGINT NOT NULL DEFAULT 0,bytes BIGINT NOT NULL DEFAULT 0,liked BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deletion_seeds(job TEXT PRIMARY KEY REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        start BIGINT NOT NULL DEFAULT -1,id TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS deletion_growth(job TEXT PRIMARY KEY REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        unit TEXT NOT NULL,revision BIGINT NOT NULL,segment TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS deletion_items(job TEXT NOT NULL REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        ordinal BIGINT NOT NULL,segment TEXT NOT NULL,PRIMARY KEY(job,ordinal),UNIQUE(job,segment));
      CREATE INDEX IF NOT EXISTS deletion_item_segment ON deletion_items(segment,job);
      CREATE TABLE IF NOT EXISTS deletion_units(job TEXT NOT NULL REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        unit TEXT NOT NULL REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED,PRIMARY KEY(job,unit));
      CREATE TABLE IF NOT EXISTS deletion_ranges(job TEXT NOT NULL REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        from_ms BIGINT NOT NULL,to_ms BIGINT NOT NULL,PRIMARY KEY(job,from_ms));
      CREATE OR REPLACE VIEW visible_segments AS SELECT s.* FROM segments s WHERE NOT EXISTS(
        SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job
        WHERE i.segment=s.id AND d.state IN ('queued','running','retry'));
      `);
  }
  /** Run only after the portable journal is replayed, inside its durable transaction. */
  async recover(): Promise<void> {
    await this.db.exec("UPDATE media_deletions SET retry_at=0 WHERE state='preparing'");
    await this.db.exec(
      "UPDATE media_deletions SET state='queued',retry_at=0 WHERE state IN ('queued','running','retry')",
    );
  }
  async begin(
    subject: string,
    ranges: MediaTimeRange[],
    cutoff: number,
    unitIds?: string[],
    commandId?: string,
  ): Promise<string> {
    if (!(await this.db.prepare('SELECT id FROM subjects WHERE id=?').get(subject)))
      throw Error('SUBJECT_NOT_FOUND');
    const pending = (await this.db
      .prepare(
        "SELECT count(*) n FROM media_deletions WHERE state IN ('preparing','queued','running','retry')",
      )
      .get<{
        n: number;
      }>())!;
    if (pending.n >= 64) throw Error('MEDIA_DELETION_QUEUE_FULL');
    const merged: MediaTimeRange[] = [];
    for (const range of [...ranges].sort((a, b) => a.fromMs - b.fromMs)) {
      const last = merged.at(-1);
      if (last && range.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, range.toMs);
      else merged.push({ ...range });
    }
    const id = commandId ?? randomUUID(),
      now = Date.now();
    await this.db
      .prepare(
        "INSERT INTO media_deletions(id,subject,state,total,created,updated) VALUES(?,?,'planned',0,?,?)",
      )
      .run(id, subject, now, now);
    await this.db
      .prepare('INSERT INTO deletion_plans(job,ranges,cutoff,revision) VALUES(?,?,?,?)')
      .run(id, JSON.stringify(merged), cutoff, await this.revision());
    await this.db
      .prepare(
        `INSERT INTO deletion_ranges(job,from_ms,to_ms)
      SELECT p.job,(r.value->>'fromMs')::bigint,(r.value->>'toMs')::bigint
      FROM deletion_plans p CROSS JOIN LATERAL json_array_elements(p.ranges::json) AS r(value) WHERE p.job=?`,
      )
      .run(id);
    if (unitIds) {
      if (unitIds.length > 256) throw Error('MEDIA_SELECTION_BATCH_TOO_LARGE');
      await this.db
        .prepare(
          `INSERT INTO deletion_units(job,unit) SELECT ?,value
        FROM json_array_elements_text(?::json) AS candidate(value) WHERE true ON CONFLICT DO NOTHING`,
        )
        .run(id, JSON.stringify(unitIds));
    }
    if (!unitIds) await this.db.prepare('INSERT INTO deletion_seeds(job) VALUES(?)').run(id);
    const open = await this.db
      .prepare(
        'SELECT id FROM recording_units WHERE subject=? AND closed=0 AND deleted=0 ORDER BY start DESC LIMIT 1',
      )
      .get<{
        id: string;
      }>(subject);
    if (open)
      await this.db
        .prepare('INSERT INTO deletion_growth(job,unit,revision) VALUES(?,?,?)')
        .run(id, open.id, cutoff);
    return id;
  }
  async build(id: string): Promise<boolean> {
    const seed = await this.db
      .prepare(
        "SELECT p.*,d.subject FROM deletion_seeds p JOIN media_deletions d ON d.id=p.job WHERE job=? AND d.state='planned'",
      )
      .get<{
        start: number;
        id: string;
        subject: string;
      }>(id);
    if (seed) {
      const rows = await this.db
        .prepare(
          `SELECT u.id,u.start FROM recording_units u WHERE subject=? AND deleted=0
        AND (start,id)>(?,?) ORDER BY start,id LIMIT 256`,
        )
        .all<{
          id: string;
          start: number;
        }>(seed.subject, seed.start, seed.id);
      await this.db
        .prepare(
          `INSERT INTO deletion_units(job,unit) SELECT ?,u.id FROM recording_units u
        WHERE u.id IN(SELECT value FROM json_array_elements_text(?::json) AS candidate(value))
        AND EXISTS(SELECT 1 FROM deletion_ranges r WHERE r.job=? AND r.from_ms<u."end" AND r.to_ms>u.start)
        ON CONFLICT DO NOTHING`,
        )
        .run(id, JSON.stringify(rows.map((row) => row.id)), id);
      if (rows.length === 256)
        await this.db
          .prepare('UPDATE deletion_seeds SET start=?,id=? WHERE job=?')
          .run(rows.at(-1)!.start, rows.at(-1)!.id, id);
      else await this.db.prepare('DELETE FROM deletion_seeds WHERE job=?').run(id);
      return true;
    }
    const p = await this.db
      .prepare(
        "SELECT p.*,d.subject,d.total,d.state FROM deletion_plans p JOIN media_deletions d ON d.id=p.job WHERE job=? AND d.state IN ('planned','preparing')",
      )
      .get<{
        subject: string;
        ranges: string;
        cutoff: number;
        cursor_start: number;
        cursor_id: string;
        total: number;
        ready: number;
        state: string;
      }>(id);
    if (!p) throw Error('STALE_DELETE_PLAN');
    if (p.ready) return false;
    const rows = await this.db
      .prepare(
        `SELECT s.id,s.start,s."end",s.created_revision,o.bytes,
      ${p.state === 'preparing' ? '0' : 'CASE WHEN EXISTS(SELECT 1 FROM unit_segments m JOIN effective_unit_favorites f ON f.unit=m.unit WHERE m.segment=s.id) THEN 1 ELSE 0 END'} liked
      FROM ${p.state === 'preparing' ? 'segments' : 'visible_segments'} s JOIN objects o ON o.id=s.media WHERE s.subject=? AND s.deleted=0
      AND s.created_revision<=? AND (s.start,s.id)>(?,?) AND EXISTS(
        SELECT 1 FROM unit_segments m JOIN deletion_units u ON u.unit=m.unit WHERE m.segment=s.id AND u.job=?)
      ORDER BY s.start,s.id LIMIT 128`,
      )
      .all<{
        id: string;
        start: number;
        end: number;
        created_revision: number;
        bytes: number;
        liked: number;
      }>(p.subject, p.cutoff, p.cursor_start, p.cursor_id, id);
    const ordinal = p.total + rows.length;
    await this.db
      .prepare(
        `INSERT INTO deletion_items(job,ordinal,segment) SELECT ?,ordinal,segment
       FROM json_to_recordset(?::json) AS candidate(ordinal bigint,segment text)`,
      )
      .run(
        id,
        JSON.stringify(
          rows.map((row, index) => ({ ordinal: p.total + index + 1, segment: row.id })),
        ),
      );
    const last = rows.at(-1);
    if (last) {
      await this.db
        .prepare(
          'UPDATE media_deletions SET total=?,from_ms=CASE WHEN from_ms IS NULL THEN ? ELSE LEAST(from_ms,?) END,to_ms=CASE WHEN to_ms IS NULL THEN ? ELSE GREATEST(to_ms,?) END WHERE id=?',
        )
        .run(
          ordinal,
          Math.min(...rows.map((r) => r.start)),
          Math.min(...rows.map((r) => r.start)),
          Math.max(...rows.map((r) => r.end)),
          Math.max(...rows.map((r) => r.end)),
          id,
        );
      await this.db
        .prepare(
          'UPDATE deletion_plans SET cursor_start=?,cursor_id=?,bytes=bytes+?,liked=liked+? WHERE job=?',
        )
        .run(
          last.start,
          last.id,
          rows.reduce((n, r) => n + r.bytes, 0),
          rows.reduce((n, r) => n + r.liked, 0),
          id,
        );
    }
    if (rows.length < 128)
      await this.db.prepare('UPDATE deletion_plans SET ready=1 WHERE job=?').run(id);
    return rows.length === 128;
  }
  async plan(id: string): Promise<MediaDeletePlan> {
    const p = await this.db.prepare('SELECT * FROM deletion_plans WHERE job=? AND ready=1').get<{
      ranges: string;
      bytes: number;
      liked: number;
      revision: number;
    }>(id);
    if (!p) throw Error('STALE_DELETE_PLAN');
    const d = await this.get(id);
    return {
      id,
      subjectId: d.subjectId,
      ranges: JSON.parse(p.ranges) as MediaTimeRange[],
      total: d.total,
      fromMs: d.fromMs,
      toMs: d.toMs,
      bytes: p.bytes,
      favoriteSegments: p.liked,
      personalRevision: p.revision,
    };
  }
  async accept(subject: string, id: string, revision: number): Promise<MediaDeletionJob | null> {
    const p = await this.db
      .prepare('SELECT revision,ready,cutoff FROM deletion_plans WHERE job=?')
      .get<{
        revision: number;
        ready: number;
        cutoff: number;
      }>(id);
    if (!p?.ready) throw Error('STALE_DELETE_PLAN');
    const d = await this.get(id);
    if (d.subjectId !== subject) throw Error('STALE_DELETE_PLAN');
    // Accepted plans are idempotent even if the response was lost.
    if (String(d.state) !== 'planned') return d;
    if (revision !== p.revision || revision !== (await this.revision()))
      throw Error('STALE_DELETE_PLAN');
    const pending = (await this.db
      .prepare(
        "SELECT count(*) n FROM media_deletions WHERE state IN ('preparing','queued','running','retry')",
      )
      .get<{
        n: number;
      }>())!;
    if (pending.n >= 64) throw Error('MEDIA_DELETION_QUEUE_FULL');
    if (d.createdAtMs < Date.now() - 3600000) throw Error('STALE_DELETE_PLAN');
    // Confirmation holds only this subject's commit queue. Its revision stream has
    // a stable end while other producers continue; each durable step scans 128 keys.
    const growth = await this.db.prepare('SELECT * FROM deletion_growth WHERE job=?').get<{
      unit: string;
      revision: number;
      segment: string;
    }>(id);
    if (
      growth &&
      (await this.db
        .prepare('SELECT 1 FROM deletion_units WHERE job=? AND unit=?')
        .get(id, growth.unit))
    ) {
      const rows = await this.db
        .prepare(
          `SELECT s.id,s.created_revision,s.start,s."end",s.deleted,s.media FROM segments s
        WHERE s.subject=? AND (s.created_revision,s.id)>(?,?) ORDER BY s.created_revision,s.id LIMIT 128`,
        )
        .all<{
          id: string;
          created_revision: number;
          start: number;
          end: number;
          deleted: number;
          media: string;
        }>(subject, growth.revision, growth.segment);
      let added = 0,
        bytes = 0,
        liked = 0,
        from = d.fromMs,
        to = d.toMs;
      for (const row of rows) {
        if (
          row.deleted ||
          !(await this.db
            .prepare('SELECT 1 FROM unit_segments WHERE segment=? AND unit=?')
            .get(row.id, growth.unit)) ||
          !(await this.db.prepare('SELECT 1 FROM visible_segments WHERE id=?').get(row.id))
        )
          continue;
        const changed = Number(
          (
            await this.db
              .prepare('INSERT INTO deletion_items VALUES(?,?,?) ON CONFLICT DO NOTHING')
              .run(id, d.total + added + 1, row.id)
          ).changes,
        );
        if (!changed) continue;
        added++;
        from = Math.min(from ?? Infinity, row.start);
        to = Math.max(to ?? 0, row.end);
        bytes +=
          (
            await this.db.prepare('SELECT bytes FROM objects WHERE id=?').get<{
              bytes: number;
            }>(row.media)
          )?.bytes ?? 0;
        if (
          await this.db
            .prepare('SELECT 1 FROM effective_unit_favorites WHERE unit=?')
            .get(growth.unit)
        )
          liked++;
      }
      await this.db
        .prepare('UPDATE media_deletions SET total=total+?,from_ms=?,to_ms=? WHERE id=?')
        .run(added, from, to, id);
      await this.db
        .prepare('UPDATE deletion_plans SET bytes=bytes+?,liked=liked+? WHERE job=?')
        .run(bytes, liked, id);
      if (rows.length === 128) {
        const last = rows.at(-1)!;
        await this.db
          .prepare('UPDATE deletion_growth SET revision=?,segment=? WHERE job=?')
          .run(last.created_revision, last.id, id);
        return null;
      }
    }
    await this.db.prepare('DELETE FROM deletion_growth WHERE job=?').run(id);
    await this.db
      .prepare(
        `UPDATE recording_units SET closed=1 WHERE subject=? AND closed=0 AND EXISTS(SELECT 1 FROM deletion_units x WHERE x.job=? AND x.unit=recording_units.id)`,
      )
      .run(subject, id);
    await this.db
      .prepare(
        "UPDATE media_deletions SET state=CASE WHEN total=0 THEN 'completed' ELSE 'queued' END,updated=? WHERE id=?",
      )
      .run(Date.now(), id);
    return await this.get(id);
  }
  async get(id: string): Promise<MediaDeletionJob> {
    const row = await this.db
      .prepare(`SELECT ${columns} FROM media_deletions WHERE id=?`)
      .get<MediaDeletionJob>(id);
    if (!row) throw Error('MEDIA_DELETION_NOT_FOUND');
    return row;
  }
  async list(): Promise<MediaDeletionJob[]> {
    return await this.db
      .prepare(
        `SELECT ${columns} FROM media_deletions WHERE state NOT IN('planned','discarding') ORDER BY (state='completed'),created DESC LIMIT 84`,
      )
      .all<MediaDeletionJob>();
  }
  async pending(subject: string): Promise<boolean> {
    return (
      !!(await this.db
        .prepare(
          "SELECT 1 FROM media_deletions WHERE subject=? AND state IN ('preparing','queued','running','retry') LIMIT 1",
        )
        .get(subject)) ||
      !!(await this.db
        .prepare(
          `SELECT 1 FROM recording_units u WHERE u.subject=? AND u.deleted=1
        AND EXISTS(SELECT 1 FROM unit_segments m JOIN segments s ON s.id=m.segment WHERE m.unit=u.id AND s.deleted=0) LIMIT 1`,
        )
        .get(subject))
    );
  }
  async next(excludedSubjects: readonly string[] = []): Promise<PendingDeletion | null> {
    const row = await this.db
      .prepare(
        `SELECT ${columns} FROM media_deletions d WHERE state IN ('queued','running','retry') AND retry_at<=?
        AND subject NOT IN(SELECT value FROM json_array_elements_text(?::json) AS busy(value))
        AND NOT EXISTS(SELECT 1 FROM media_deletions older WHERE older.subject=d.subject
          AND older.state IN ('preparing','queued','running','retry') AND (older.created,older.id)<(d.created,d.id))
        ORDER BY updated,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )
      .get<MediaDeletionJob>(Date.now(), JSON.stringify(excludedSubjects));
    if (!row) return null;
    await this.db
      .prepare("UPDATE media_deletions SET state='running',updated=? WHERE id=?")
      .run(Date.now(), row.id);
    const ids = await this.db
      .prepare(
        'SELECT segment FROM deletion_items WHERE job=? AND ordinal>? ORDER BY ordinal LIMIT 128',
      )
      .all<{
        segment: string;
      }>(row.id, row.processed);
    return { ...row, state: 'running', segmentIds: ids.map((r) => r.segment) };
  }
  async advance(id: string, processed: number, reclaimed: number): Promise<MediaDeletionJob> {
    await this.db
      .prepare(
        "UPDATE media_deletions SET processed=?,reclaimed=reclaimed+?,state=CASE WHEN ?>=total THEN 'completed' ELSE 'queued' END,updated=?,error=NULL,retry_at=0 WHERE id=?",
      )
      .run(processed, reclaimed, processed, Date.now(), id);
    const result = await this.get(id);
    // Already-checkpointed IDs no longer participate in visibility or recovery.
    await this.db
      .prepare('DELETE FROM deletion_items WHERE job=? AND ordinal<=?')
      .run(id, processed);
    return result;
  }
  async cleanup(): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT id FROM media_deletions WHERE state='discarding'
      OR (state='planned' AND (created<? OR id NOT IN(SELECT id FROM media_deletions WHERE state='planned' ORDER BY created DESC LIMIT 8)))
      OR (state IN ('completed','failed') AND id NOT IN(SELECT id FROM media_deletions WHERE state IN ('completed','failed') ORDER BY updated DESC LIMIT 20))
      ORDER BY created,id LIMIT 1`,
      )
      .get<{
        id: string;
      }>(Date.now() - 3600000);
    if (!row) return false;
    await this.db.prepare("UPDATE media_deletions SET state='discarding' WHERE id=?").run(row.id);
    for (const [table, key] of [
      ['deletion_items', 'ordinal'],
      ['deletion_units', 'unit'],
      ['deletion_ranges', 'from_ms'],
    ]) {
      if (
        (
          await this.db
            .prepare(
              `DELETE FROM ${table} WHERE job=? AND ${key} IN(SELECT ${key} FROM ${table} WHERE job=? ORDER BY ${key} LIMIT 256)`,
            )
            .run(row.id, row.id)
        ).changes
      )
        return true;
    }
    await this.db.prepare('DELETE FROM deletion_growth WHERE job=?').run(row.id);
    await this.db.prepare('DELETE FROM deletion_seeds WHERE job=?').run(row.id);
    await this.db.prepare('DELETE FROM deletion_plans WHERE job=?').run(row.id);
    await this.db.prepare('DELETE FROM media_deletions WHERE id=?').run(row.id);
    return true;
  }
  async retry(id: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE media_deletions SET state='retry',error='storage_unavailable',retry_at=?::bigint+LEAST(300000::bigint,30000::bigint*(1::bigint<<LEAST(attempts,4)::integer)),updated=?,attempts=attempts+1 WHERE id=?",
      )
      .run(Date.now(), Date.now(), id);
  }
}
