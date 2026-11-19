import type { SqlDatabase } from '../database/sql.js';
import type { MediaDeletionJob, MediaDeletionTarget } from '@st-vault/api-schema';
import type { DeletionStore } from './deletion-store.js';
import type { MediaSelectionStore } from './media-selection-store.js';
import { initializeUnitVisibility } from './unit-visibility.js';
interface Intent {
  job: string;
  subject: string;
  payload: string;
  cutoff: number;
  personal: number;
  phase: 'units' | 'extras' | 'plan' | 'delete';
  cursor_start: number;
  cursor_id: string;
  scanned: number;
  selected: number;
  from_ms: number;
  to_ms: number;
  revision: number;
}
// One predicate owns both immediate visibility and later materialization. During
// preparation, no enumerated deletion_items are needed to retire the footage.
const matches = `u.created_revision<=i.cutoff AND (
  ((i.payload::jsonb #>> '{kind}')='units' AND u.id IN(SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{unitIds}','[]'::json)) AS j(value)))
  OR ((i.payload::jsonb #>> '{kind}')='selection' AND EXISTS(SELECT 1 FROM selection_units x
    WHERE x.selection=(i.payload::jsonb #>> '{selectionId}') AND x.unit=u.id))
  OR ((i.payload::jsonb #>> '{kind}')='range' AND (
    (u.start<i.to_ms AND u."end">i.from_ms AND ((i.payload::jsonb #>> '{mode}')='all'
      OR NOT EXISTS(SELECT 1 FROM unit_favorite_facts f WHERE f.unit=u.id)))
    OR EXISTS(SELECT 1 FROM selection_units x WHERE x.selection=(i.payload::jsonb #>> '{baseSelectionId}') AND x.unit=u.id)))
  OR u.id IN(SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{patch,includeUnitIds}','[]'::json)) AS j(value)))
  AND u.id NOT IN(SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{patch,excludeUnitIds}','[]'::json)) AS j(value))`;
/** Small durable admission; each continuation changes at most 256 units or 128 fragments. */
export class DeletionIntents {
  private readonly db: SqlDatabase;
  private readonly jobs: DeletionStore;
  private readonly selections: MediaSelectionStore;
  private readonly revision: () => Promise<number>;
  private readonly personal: () => Promise<number>;
  constructor(
    db: SqlDatabase,
    jobs: DeletionStore,
    selections: MediaSelectionStore,
    revision: () => Promise<number>,
    personal: () => Promise<number>,
  ) {
    this.db = db;
    this.jobs = jobs;
    this.selections = selections;
    this.revision = revision;
    this.personal = personal;
  }
  async initialize(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS deletion_intents(
      job TEXT PRIMARY KEY REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      subject TEXT NOT NULL REFERENCES subjects(id) DEFERRABLE INITIALLY DEFERRED,payload TEXT NOT NULL,cutoff BIGINT NOT NULL,
      personal BIGINT NOT NULL,phase TEXT NOT NULL,cursor_start BIGINT NOT NULL DEFAULT -1,
      cursor_id TEXT NOT NULL DEFAULT '',scanned BIGINT NOT NULL DEFAULT 0,selected BIGINT NOT NULL DEFAULT 0,
      from_ms BIGINT NOT NULL,to_ms BIGINT NOT NULL,revision BIGINT NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS deletion_intents_subject ON deletion_intents(subject,phase);
      CREATE OR REPLACE VIEW deletion_intent_units AS
      SELECT u.id AS unit,i.job FROM recording_units u JOIN deletion_intents i ON i.subject=u.subject
      JOIN media_deletions d ON d.id=i.job WHERE d.state='preparing' AND u.deleted=0 AND
      (CASE WHEN i.phase='plan' THEN EXISTS(SELECT 1 FROM deletion_units x WHERE x.job=i.job AND x.unit=u.id)
      ELSE (${matches}) END)
      UNION ALL SELECT x.unit,x.job FROM deletion_units x JOIN media_deletions d ON d.id=x.job
      WHERE d.state IN ('queued','running','retry');`);
    await initializeUnitVisibility(this.db, true);
  }
  async admit(subject: string, id: string, target: MediaDeletionTarget): Promise<MediaDeletionJob> {
    const payload = JSON.stringify(target);
    const prior = await this.db
      .prepare('SELECT subject,payload FROM deletion_intents WHERE job=?')
      .get<{
        subject: string;
        payload: string;
      }>(id);
    if (prior) {
      if (prior.subject !== subject || prior.payload !== payload)
        throw Error('COMMAND_ID_CONFLICT');
      return await this.get(id);
    }
    if (await this.db.prepare('SELECT 1 FROM media_deletions WHERE id=?').get(id))
      throw Error('COMMAND_ID_CONFLICT');
    const base =
      target.kind === 'selection'
        ? target.selectionId
        : target.kind === 'range'
          ? target.baseSelectionId
          : undefined;
    if (base) await this.selections.summary(subject, base);
    const cutoff = await this.revision();
    await this.jobs.begin(subject, [], cutoff, [], id);
    await this.db
      .prepare(
        `INSERT INTO deletion_intents(job,subject,payload,cutoff,personal,phase,from_ms,to_ms)
      VALUES(?,?,?,?,?,'units',?,?)`,
      )
      .run(id, subject, payload, cutoff, await this.personal(), target.fromMs, target.toMs);
    if (base) await this.selections.pin(base, id);
    await this.db.prepare("UPDATE media_deletions SET state='preparing' WHERE id=?").run(id);
    await this.db.prepare('DELETE FROM deletion_growth WHERE job=?').run(id);
    // Seal only the selected open unit. Future recording belongs to a successor
    // and cannot enter this already-confirmed command, even after a long restart.
    await this.db
      .prepare(
        `UPDATE recording_units SET closed=1 WHERE subject=? AND closed=0 AND EXISTS(
      SELECT 1 FROM deletion_intent_units x WHERE x.unit=recording_units.id AND x.job=?)`,
      )
      .run(subject, id);
    return await this.get(id);
  }
  async get(id: string): Promise<MediaDeletionJob> {
    const job = await this.jobs.get(id);
    const intent = await this.db
      .prepare(
        'SELECT phase,scanned,selected,from_ms,to_ms,revision FROM deletion_intents WHERE job=?',
      )
      .get<Pick<Intent, 'phase' | 'scanned' | 'selected' | 'from_ms' | 'to_ms' | 'revision'>>(id);
    if (!intent) return job;
    return {
      ...job,
      fromMs: job.fromMs ?? intent.from_ms,
      toMs: job.toMs ?? intent.to_ms,
      phase: intent.phase,
      scannedUnits: intent.scanned,
      selectedUnits: intent.selected,
      deletionRevision: intent.revision,
    };
  }
  async list(): Promise<MediaDeletionJob[]> {
    const result: MediaDeletionJob[] = [];
    for (const job of await this.jobs.list()) result.push(await this.get(job.id));
    return result;
  }
  private async unpin(intent: Intent): Promise<void> {
    const target = JSON.parse(intent.payload) as MediaDeletionTarget;
    const base =
      target.kind === 'selection'
        ? target.selectionId
        : target.kind === 'range'
          ? target.baseSelectionId
          : undefined;
    if (base) await this.selections.unpin(base, intent.job);
  }
  async pending(excludedSubjects: readonly string[] = []): Promise<MediaDeletionJob | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM media_deletions d WHERE state='preparing' AND retry_at<=?
        AND subject NOT IN(SELECT value FROM json_array_elements_text(?::json) AS busy(value))
        AND NOT EXISTS(SELECT 1 FROM media_deletions older WHERE older.subject=d.subject
          AND older.state IN ('preparing','queued','running','retry') AND (older.created,older.id)<(d.created,d.id))
        ORDER BY updated,id LIMIT 1`,
      )
      .get<{
        id: string;
      }>(Date.now(), JSON.stringify(excludedSubjects));
    return row ? await this.get(row.id) : null;
  }
  async step(jobId?: string): Promise<MediaDeletionJob | null> {
    const i = await this.db
      .prepare(
        `SELECT i.* FROM deletion_intents i JOIN media_deletions d ON d.id=i.job
      WHERE d.state='preparing' AND d.retry_at<=? AND (?::text IS NULL OR i.job=?) ORDER BY d.updated,d.id LIMIT 1 FOR UPDATE OF d,i SKIP LOCKED`,
      )
      .get<Intent>(Date.now(), jobId ?? null, jobId ?? null);
    if (!i) return null;
    const target = JSON.parse(i.payload) as MediaDeletionTarget;
    // An unfrozen 'unliked' predicate must never silently change meaning. A
    // conflicting personal write fails the whole preparation before any unlink.
    if (
      i.phase !== 'plan' &&
      target.kind === 'range' &&
      target.mode === 'unliked' &&
      i.personal !== (await this.personal())
    ) {
      await this.db
        .prepare(
          "UPDATE media_deletions SET state='failed',error='media_selection_stale',updated=? WHERE id=?",
        )
        .run(Date.now(), i.job);
      await this.unpin(i);
      return await this.get(i.job);
    }
    if (i.phase === 'plan') {
      if (!(await this.jobs.build(i.job))) {
        await this.db
          .prepare(
            "UPDATE media_deletions SET state=CASE WHEN total=0 THEN 'completed' ELSE 'queued' END,updated=? WHERE id=?",
          )
          .run(Date.now(), i.job);
        await this.db.prepare("UPDATE deletion_intents SET phase='delete' WHERE job=?").run(i.job);
        await this.unpin(i);
      }
    } else {
      const range = i.phase === 'units' && target.kind === 'range';
      const rows = range
        ? await this.db
            .prepare(
              `SELECT id,start FROM recording_units WHERE subject=? AND deleted=0
        AND start>? AND start<? AND created_revision<=? AND (start,id)>(?,?) ORDER BY start,id LIMIT 256`,
            )
            .all<{
              id: string;
              start: number;
            }>(
              i.subject,
              Math.max(-1, i.from_ms - 86460000),
              i.to_ms,
              i.cutoff,
              i.cursor_start,
              i.cursor_id,
            )
        : await this.db
            .prepare(
              `SELECT u.id,u.start FROM recording_units u WHERE u.subject=? AND u.id IN(
          SELECT value FROM json_array_elements_text(coalesce(?::json #> '{unitIds}','[]'::json)) AS j(value) UNION SELECT value FROM json_array_elements_text(coalesce(?::json #> '{patch,includeUnitIds}','[]'::json)) AS j(value)
          UNION SELECT unit FROM selection_units WHERE selection=coalesce((?::jsonb #>> '{selectionId}'),(?::jsonb #>> '{baseSelectionId}')))
          AND u.id>? ORDER BY u.id LIMIT 256`,
            )
            .all<{
              id: string;
              start: number;
            }>(i.subject, i.payload, i.payload, i.payload, i.payload, i.cursor_id);
      const selected = (
        await this.db
          .prepare(
            `INSERT INTO deletion_units(job,unit)
         SELECT i.job,u.id FROM recording_units u JOIN deletion_intents i ON i.job=?
         WHERE u.id IN(SELECT value FROM json_array_elements_text(?::json) AS candidate(value))
         AND u.deleted=0 AND (${matches}) ON CONFLICT DO NOTHING`,
          )
          .run(i.job, JSON.stringify(rows.map((row) => row.id)))
      ).changes;
      const last = rows.at(-1);
      const next = rows.length === 256 ? i.phase : range ? 'extras' : 'plan';
      await this.db
        .prepare(
          `UPDATE deletion_intents SET phase=?,cursor_start=?,cursor_id=?,scanned=scanned+?,selected=selected+? WHERE job=?`,
        )
        .run(
          next,
          next === i.phase ? (last?.start ?? i.cursor_start) : -1,
          next === i.phase ? (last?.id ?? i.cursor_id) : '',
          rows.length,
          selected,
          i.job,
        );
    }
    await this.db
      .prepare('UPDATE media_deletions SET updated=?,error=NULL,retry_at=0 WHERE id=?')
      .run(Date.now(), i.job);
    return await this.get(i.job);
  }
  async retry(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE media_deletions SET error='storage_unavailable',retry_at=?::bigint+30000,updated=? WHERE id=? AND state='preparing'`,
      )
      .run(Date.now(), Date.now(), id);
  }
}
