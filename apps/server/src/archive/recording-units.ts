import type { SqlDatabase } from '../database/sql.js';
import type { Segment, MediaTimeRange, SnapshotItem } from '@st-vault/api-schema';
import { initializeUnitVisibility } from './unit-visibility.js';
export interface RecordingUnit {
  id: string;
  subject: string;
  start: number;
  end: number;
  closed: number;
  deleted: number;
  sample: number;
  last_start: number;
  created_revision: number;
}
/** Owns immutable fragment membership. Network connections never define a unit. */
export class RecordingUnits {
  private readonly db: SqlDatabase;
  private readonly initializeSchema: boolean;
  private readonly generations = new Map<string, number>();
  private changeListener?: (
    subject: string,
    fromMs: number,
    toMs: number,
    destructive: boolean,
  ) => void;
  setChangeListener(
    listener: (subject: string, fromMs: number, toMs: number, destructive: boolean) => void,
  ): void {
    this.changeListener = listener;
  }
  generation(subject: string): number {
    return this.generations.get(subject) ?? 0;
  }
  private changed(subject: string, fromMs: number, toMs: number, destructive = false): void {
    this.db.afterCommit(() => {
      this.generations.set(subject, this.generation(subject) + 1);
      this.changeListener?.(subject, fromMs, toMs, destructive);
    });
  }
  constructor(db: SqlDatabase, initialize = true) {
    this.db = db;
    this.initializeSchema = initialize;
  }
  async initialize(): Promise<void> {
    const db = this.db;
    if (!this.initializeSchema) return;
    await db.exec(`CREATE TABLE IF NOT EXISTS recording_units(
      id TEXT PRIMARY KEY,subject TEXT NOT NULL,start BIGINT NOT NULL,"end" BIGINT NOT NULL,
      sample BIGINT NOT NULL,last_start BIGINT NOT NULL,created_revision BIGINT NOT NULL,closed BIGINT NOT NULL DEFAULT 0,deleted BIGINT NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS unit_window ON recording_units(subject,start,id,"end");
      CREATE INDEX IF NOT EXISTS unit_finish ON recording_units(subject,"end" DESC,id,start);
      CREATE INDEX IF NOT EXISTS unit_open ON recording_units(subject,closed,start DESC);
      CREATE INDEX IF NOT EXISTS unit_deleted ON recording_units(subject,deleted,id);
      CREATE INDEX IF NOT EXISTS unit_order ON recording_units(subject,created_revision,id);
      CREATE TABLE IF NOT EXISTS unit_segments(segment TEXT PRIMARY KEY REFERENCES segments(id) DEFERRABLE INITIALLY DEFERRED,unit TEXT NOT NULL REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE INDEX IF NOT EXISTS unit_members ON unit_segments(unit,segment);
      CREATE TABLE IF NOT EXISTS unit_favorites(unit TEXT PRIMARY KEY REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED,created BIGINT NOT NULL);
      -- Preserve the historical journal row shape; unbounded evidence is never read.
      CREATE TABLE IF NOT EXISTS unit_seen(unit TEXT PRIMARY KEY REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED,subject TEXT NOT NULL,seen_at BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS seen_subject ON unit_seen(subject);
      CREATE TABLE IF NOT EXISTS unit_seen_ranges(unit TEXT PRIMARY KEY REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED,subject TEXT NOT NULL,seen_at BIGINT NOT NULL,seen_to BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS seen_ranges_subject ON unit_seen_ranges(subject);
      CREATE TABLE IF NOT EXISTS unit_index(id BIGINT PRIMARY KEY CHECK(id=1),revision BIGINT NOT NULL,segment TEXT NOT NULL,ready BIGINT NOT NULL);
      INSERT INTO unit_index SELECT 1,-1,'',CASE WHEN EXISTS(SELECT 1 FROM segments) THEN 0 ELSE 1 END
        ON CONFLICT(id) DO NOTHING;
      CREATE INDEX IF NOT EXISTS segment_unit_build ON segments(created_revision,id);
      CREATE INDEX IF NOT EXISTS segment_unit_append ON segments(subject,created_revision,id);`);
    await initializeUnitVisibility(db);
  }
  async ready(): Promise<boolean> {
    return !!(await this.db.prepare('SELECT ready FROM unit_index WHERE id=1').get<{
      ready: number;
    }>())!.ready;
  }
  async defer(): Promise<void> {
    await this.db.exec('UPDATE unit_index SET ready=0 WHERE id=1');
  }
  /** Caller owns the metadata transaction, including the source checkpoint. */
  async append(segment: Segment, revision: number): Promise<void> {
    if (segment.wallStartMs === null || segment.wallEndMs === null) return;
    if (await this.db.prepare('SELECT 1 FROM unit_segments WHERE segment=?').get(segment.id))
      return;
    const start = segment.wallStartMs,
      end = segment.wallEndMs;
    let unit = await this.db
      .prepare(
        'SELECT * FROM recording_units WHERE subject=? AND closed=0 AND deleted=0 ORDER BY start DESC,id LIMIT 1',
      )
      .get<RecordingUnit>(segment.subjectId);
    const previousStart = unit?.start ?? start,
      previousEnd = unit?.end ?? end;
    if (
      unit &&
      (start < unit.last_start || start >= (Math.floor(unit.start / 60000) + 1) * 60000)
    ) {
      await this.db.prepare('UPDATE recording_units SET closed=1 WHERE id=?').run(unit.id);
      unit = undefined;
    }
    if (!unit) {
      await this.db
        .prepare(
          'INSERT INTO recording_units(id,subject,start,"end",sample,last_start,created_revision) VALUES(?,?,?,?,?,?,?)',
        )
        .run(segment.id, segment.subjectId, start, end, start, start, revision);
      unit = {
        id: segment.id,
        subject: segment.subjectId,
        start,
        end,
        sample: start,
        closed: 0,
        deleted: 0,
        last_start: start,
        created_revision: revision,
      };
    } else
      await this.db
        .prepare('UPDATE recording_units SET "end"=GREATEST("end",?),last_start=? WHERE id=?')
        .run(end, start, unit.id);
    await this.db.prepare('INSERT INTO unit_segments VALUES(?,?)').run(segment.id, unit.id);
    this.changed(
      segment.subjectId,
      Math.min(previousStart, unit.start),
      Math.max(previousEnd, unit.end, end),
    );
  }
  async build(limit = 128): Promise<boolean> {
    if (await this.ready()) return false;
    const state = (await this.db.prepare('SELECT revision,segment FROM unit_index WHERE id=1').get<{
      revision: number;
      segment: string;
    }>())!;
    const rows = await this.db
      .prepare(
        `SELECT s.id,s.json,s.created_revision,CASE WHEN s.deleted<>0 OR EXISTS(SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job WHERE i.segment=s.id AND d.state IN ('queued','running','retry')) THEN 1 ELSE 0 END deleted FROM segments s WHERE (s.created_revision,s.id)>(?,?) ORDER BY s.created_revision,s.id LIMIT ?`,
      )
      .all<{
        id: string;
        json: string;
        created_revision: number;
        deleted: number;
      }>(state.revision, state.segment, limit);
    for (const row of rows)
      if (!row.deleted) await this.append(JSON.parse(row.json) as Segment, row.created_revision);
    if (rows.length)
      await this.db
        .prepare('UPDATE unit_index SET revision=?,segment=? WHERE id=1')
        .run(rows.at(-1)!.created_revision, rows.at(-1)!.id);
    if (rows.length < limit) {
      await this.db.exec('UPDATE unit_index SET ready=1 WHERE id=1');
      return false;
    }
    return true;
  }
  async seal(subject: string): Promise<void> {
    const affected = (await this.db
      .prepare(
        'SELECT min(start) start,max("end") "end" FROM recording_units WHERE subject=? AND closed=0',
      )
      .get<{
        start: number | null;
        end: number | null;
      }>(subject))!;
    const result = await this.db
      .prepare('UPDATE recording_units SET closed=1 WHERE subject=? AND closed=0')
      .run(subject);
    if (Number(result.changes)) this.changed(subject, affected.start!, affected.end!);
  }
  async deleted(segmentId: string, notify = true): Promise<void> {
    const subject = await this.db
      .prepare(
        'SELECT u.subject,u.start,u."end" FROM recording_units u JOIN unit_segments m ON m.unit=u.id WHERE m.segment=?',
      )
      .get<{
        subject: string;
        start: number;
        end: number;
      }>(segmentId);
    await this.db
      .prepare(
        'UPDATE recording_units SET deleted=1,closed=1 WHERE id=(SELECT unit FROM unit_segments WHERE segment=?)',
      )
      .run(segmentId);
    if (subject && notify) this.changed(subject.subject, subject.start, subject.end, true);
  }
  async page(
    subject: string,
    window: MediaTimeRange,
    after: [number, string],
    limit = 256,
    descending = false,
  ): Promise<RecordingUnit[]> {
    await this.requireReady();
    const order = descending ? 'DESC' : 'ASC',
      comparison = descending ? '<' : '>';
    const lower = Math.max(-1, window.fromMs - 86460000);
    const seek: [number, string] = !descending && after[0] < lower ? [lower, '\uFFFF'] : after;
    return await this.db
      .prepare(
        `SELECT u.* FROM visible_recording_units u WHERE u.subject=? AND u.start<? AND u."end">?
      AND (u.start,u.id)${comparison}(?,?) AND u.deleted=0
      ${descending ? 'AND u.start>?' : ''}
      ORDER BY u.start ${order},u.id ${order} LIMIT ?`,
      )
      .all<RecordingUnit>(
        subject,
        window.toMs,
        window.fromMs,
        seek[0],
        seek[1],
        ...(descending ? [lower] : []),
        limit,
      );
  }
  async list(subject: string, window: MediaTimeRange): Promise<RecordingUnit[]> {
    await this.requireReady();
    return await this.db
      .prepare(
        `SELECT u.* FROM visible_recording_units u WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">?
      ORDER BY u.start,u.id`,
      )
      .all<RecordingUnit>(
        subject,
        Math.max(-1, window.fromMs - 86460000),
        window.toMs,
        Math.max(0, window.fromMs),
      );
  }
  async intersect(subject: string, window: MediaTimeRange): Promise<RecordingUnit[]> {
    await this.requireReady();
    return await this.db
      .prepare(
        `SELECT u.* FROM visible_recording_units u WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">?
      AND EXISTS(SELECT 1 FROM unit_segments m JOIN segments s ON s.id=m.segment
      WHERE m.unit=u.id AND s.deleted=0 AND s.start<? AND s."end">?) ORDER BY u.start,u.id`,
      )
      .all<RecordingUnit>(
        subject,
        Math.max(-1, window.fromMs - 86460000),
        window.toMs,
        window.fromMs,
        window.toMs,
        window.fromMs,
      );
  }
  /** Resolve outer selection edges without materializing every intervening unit. */
  async bounds(subject: string, window: MediaTimeRange): Promise<RecordingUnit[]> {
    await this.requireReady();
    // A source fragment is at most one day. A unit can also contain the
    // preceding partial minute, so both index directions have finite bounds.
    const parameters = [
      subject,
      Math.max(-1, window.fromMs - 86460000),
      window.toMs,
      window.fromMs,
      Math.min(Number.MAX_SAFE_INTEGER, window.toMs + 86460000),
      window.toMs,
      window.fromMs,
    ];
    const query = `SELECT u.* FROM visible_recording_units u WHERE u.subject=?
      AND u.start>? AND u.start<? AND u."end">? AND u."end"<=? AND u.deleted=0
      AND EXISTS(SELECT 1 FROM unit_segments m JOIN segments s ON s.id=m.segment
        WHERE m.unit=u.id AND s.deleted=0 AND s.start<? AND s."end">?)`;
    const first = await this.db
      .prepare(`${query} ORDER BY u.start,u.id LIMIT 1`)
      .get<RecordingUnit>(...parameters);
    if (!first) return [];
    const last = await this.db
      .prepare(`${query} ORDER BY u."end" DESC,u.id LIMIT 1`)
      .get<RecordingUnit>(...parameters);
    return last && last.id !== first.id ? [first, last] : [first];
  }
  async at(subject: string, at: number): Promise<RecordingUnit | undefined> {
    await this.requireReady();
    // Match segment lookup at overlapping PDT boundaries; only a real gap
    // falls forward to the next unit. Explicit unit IDs retain their identity.
    const covering = await this.db
      .prepare(
        `SELECT u.* FROM visible_recording_units u WHERE subject=? AND start>? AND start<=? AND "end">?
      ORDER BY start DESC,id LIMIT 1`,
      )
      .get<RecordingUnit>(subject, Math.max(-1, at - 86460000), at, at);
    if (covering) return covering;
    return await this.db
      .prepare(
        `SELECT u.* FROM visible_recording_units u WHERE subject=? AND start>?
      ORDER BY start,id LIMIT 1`,
      )
      .get<RecordingUnit>(subject, at);
  }
  async get(subject: string, id: string): Promise<RecordingUnit | undefined> {
    await this.requireReady();
    return await this.db
      .prepare('SELECT u.* FROM visible_recording_units u WHERE subject=? AND id=?')
      .get<RecordingUnit>(subject, id);
  }
  async snap(subject: string, ranges: MediaTimeRange[]): Promise<MediaTimeRange[]> {
    const selected = new Map<string, RecordingUnit>();
    for (const range of ranges)
      for (const unit of await this.intersect(subject, range)) selected.set(unit.id, unit);
    return [...selected.values()]
      .sort((a, b) => a.start - b.start)
      .map((u) => ({ fromMs: u.start, toMs: u.end }));
  }
  async item(unit: RecordingUnit): Promise<SnapshotItem> {
    // Validate the whole unit once, then stop at its first surviving source.
    const source = await this.db
      .prepare(
        `SELECT s.json FROM visible_recording_units u JOIN unit_segments m ON m.unit=u.id
          JOIN segments s ON s.id=m.segment WHERE u.id=? AND u.subject=? AND s.deleted=0
          ORDER BY s.start,s.id LIMIT 1`,
      )
      .get<{
        json: string;
      }>(unit.id, unit.subject);
    if (!source) throw Error('MEDIA_SELECTION_STALE');
    return this.present(unit, JSON.parse(source.json) as Segment);
  }
  async items(subject: string, ids: string[]): Promise<SnapshotItem[]> {
    if (!ids.length) return [];
    const rows = await this.db
      .prepare(
        `SELECT u.*,(SELECT s.json FROM unit_segments m JOIN segments s ON s.id=m.segment
          WHERE m.unit=u.id AND s.deleted=0 ORDER BY s.start,s.id LIMIT 1) source_json
          FROM visible_recording_units u WHERE u.subject=?
          AND u.id IN(SELECT value FROM json_array_elements_text(?::json) AS x(value))`,
      )
      .all<
        RecordingUnit & {
          source_json: string | null;
        }
      >(subject, JSON.stringify(ids));
    const mapped = new Map(
      rows
        .filter((r) => r.source_json)
        .map((r) => [r.id, this.present(r, JSON.parse(r.source_json!) as Segment)]),
    );
    return ids.flatMap((id) => (mapped.has(id) ? [mapped.get(id)!] : []));
  }
  private present(unit: RecordingUnit, segment: Segment): SnapshotItem {
    return {
      unitId: unit.id,
      open: !unit.closed,
      imageToMs: unit.sample + 86460000,
      atMs: unit.sample,
      slotFromMs: unit.start,
      slotToMs: unit.end,
      timeBasis: segment.timeBasis,
      uncertaintyMs: segment.uncertaintyMs,
      url: `/api/subjects/${encodeURIComponent(unit.subject)}/snapshots/${unit.sample}.jpg?to=${unit.sample + 86460000}&unit=${unit.id}`,
    };
  }
  private async requireReady(): Promise<void> {
    if (!(await this.ready())) throw Error('RECORDING_UNITS_BUILDING');
  }
}
