import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../database/sql.js';
import type {
  FavoriteRange,
  PersonalTimeline,
  MediaTimeRange,
  UnitSeenEvidence,
} from '@st-vault/api-schema';
/** One persistent administrator; protection belongs to whole recording units. */
export class PersonalStore {
  private readonly db: SqlDatabase;
  private ownerIdentity?: {
    instanceId: string;
    userId: string;
    timelineStartMs: number;
  };
  get identity(): { instanceId: string; userId: string; timelineStartMs: number } {
    if (!this.ownerIdentity) throw Error('PERSONAL_STORE_NOT_INITIALIZED');
    return this.ownerIdentity;
  }
  private readonly timelineStartMs: number;
  private readonly coverageCache = new Map<string, MediaTimeRange[]>();
  clearCoverageCache(): void {
    this.coverageCache.clear();
  }
  constructor(db: SqlDatabase, timelineStartMs = Date.now()) {
    this.db = db;
    this.timelineStartMs = timelineStartMs;
  }
  async initialize(): Promise<void> {
    const db = this.db;
    await db.exec(
      'CREATE TABLE IF NOT EXISTS personal_owner(id BIGINT PRIMARY KEY CHECK(id=1),instance TEXT NOT NULL,"user" TEXT NOT NULL,revision BIGINT NOT NULL DEFAULT 0)',
    );
    await db
      .prepare(
        'INSERT INTO personal_owner(id,instance,"user") VALUES(1,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(randomUUID(), randomUUID());
    const row = (await db.prepare('SELECT instance,"user" FROM personal_owner WHERE id=1').get<{
      instance: string;
      user: string;
    }>())!;
    this.ownerIdentity = {
      instanceId: row.instance,
      userId: row.user,
      timelineStartMs: this.timelineStartMs,
    };
  }
  async revision(): Promise<number> {
    return (await this.db.prepare('SELECT revision FROM personal_owner WHERE id=1').get<{
      revision: number;
    }>())!.revision;
  }
  /** Monotonic, idempotent evidence; it never changes favorite concurrency or retention. */
  async markSeen(subjectId: string, evidence: UnitSeenEvidence[]): Promise<{ changed: number }> {
    const rows = await this.db
      .prepare(
        `INSERT INTO unit_seen_ranges(unit,subject,seen_at,seen_to)
      SELECT u.id,u.subject,?,LEAST(u."end",e."toMs") FROM visible_recording_units u
      JOIN json_to_recordset(?::json) AS e("unitId" text,"toMs" bigint) ON e."unitId"=u.id
      WHERE u.subject=? AND e."toMs">u.start
      ON CONFLICT(unit) DO UPDATE SET seen_to=EXCLUDED.seen_to,seen_at=EXCLUDED.seen_at
      WHERE unit_seen_ranges.seen_to<EXCLUDED.seen_to RETURNING unit`,
      )
      .all(Date.now(), JSON.stringify(evidence), subjectId);
    return { changed: rows.length };
  }
  async seenCoverage(
    subjectId: string,
    from: number,
    to: number,
    count: number,
  ): Promise<MediaTimeRange[]> {
    // Bound the response by pixels, not library size. A mixed pixel stays red so
    // an unread unit can never disappear behind a previously viewed neighbor.
    const rows = await this.db
      .prepare(
        `WITH bounds AS (
      SELECT ?::double precision lo,?::double precision hi,?::integer n
    ), units AS (
      SELECT u.start,u."end",COALESCE(s.seen_to,0) AS seen_to,
        GREATEST(0,FLOOR((u.start-b.lo)*b.n/(b.hi-b.lo)))::integer first,
        LEAST(b.n-1,CEIL((u."end"-b.lo)*b.n/(b.hi-b.lo))-1)::integer last
      FROM visible_recording_units u LEFT JOIN unit_seen_ranges s ON s.unit=u.id CROSS JOIN bounds b
      WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">?
      AND EXISTS(SELECT 1 FROM unit_seen_ranges WHERE subject=?)
    ) SELECT bucket,
      GREATEST(MIN(u.start),b.lo+bucket*(b.hi-b.lo)/b.n) AS "fromMs",
      LEAST(MAX(u.seen_to),MAX(u."end"),b.lo+(bucket+1)*(b.hi-b.lo)/b.n) AS "toMs"
      FROM units u CROSS JOIN bounds b CROSS JOIN LATERAL generate_series(u.first,u.last) bucket
      GROUP BY bucket,b.lo,b.hi,b.n
      HAVING bool_and(u.seen_to>=LEAST(u."end",b.lo+(bucket+1)*(b.hi-b.lo)/b.n)) ORDER BY bucket`,
      )
      .all<MediaTimeRange>(
        from,
        to,
        count,
        subjectId,
        Math.max(-1, from - 86460000),
        to,
        from,
        subjectId,
      );
    const spans: MediaTimeRange[] = [];
    for (const row of rows) {
      const last = spans.at(-1);
      if (last && last.toMs >= row.fromMs) last.toMs = Math.max(last.toMs, row.toMs);
      else spans.push({ fromMs: row.fromMs, toMs: row.toMs });
    }
    return spans;
  }
  async read(subjectId: string, fromMs: number, toMs: number): Promise<PersonalTimeline> {
    // effective_unit_favorites already applies canonical unit visibility. The
    // base-table join only supplies metadata; rejoining the view repeats its probes.
    const favorites = await this.db
      .prepare(
        'SELECT u.id,u.subject AS "subjectId",u.sample AS "atMs",f.created AS "createdAtMs",u.start AS "fromMs",u."end" AS "toMs" FROM recording_units u JOIN effective_unit_favorites f ON f.unit=u.id WHERE u.subject=? AND u.start>? AND u."end">? AND u.start<? AND u.deleted=0 ORDER BY u.start,u.id',
      )
      .all<FavoriteRange>(subjectId, Math.max(-1, fromMs - 86460000), fromMs, toMs);
    return {
      subjectId,
      fromMs,
      toMs,
      favorites,
      revision: await this.revision(),
      truncated: false,
    };
  }
  async protectedCoverage(
    subjectId: string,
    fromMs: number,
    toMs: number,
    buckets: number,
    contentVersion: string,
  ): Promise<MediaTimeRange[]> {
    const revision = await this.revision(),
      key = `${subjectId}:${fromMs}:${toMs}:${buckets}:${contentVersion}:${revision}`;
    const hit = this.coverageCache.get(key);
    if (hit) return hit;
    const duration = toMs - fromMs;
    // Aggregate in PostgreSQL before crossing the worker boundary: at most one row per pixel bucket.
    const rows = await this.db
      .prepare(
        `SELECT CAST(FLOOR(GREATEST(0,((u.start-?)*?)/(1.0*?))) AS BIGINT) bucket,
      MAX(u."end") "end" FROM recording_units u JOIN effective_unit_favorites f ON f.unit=u.id
      WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">? AND u.deleted=0 GROUP BY bucket ORDER BY bucket`,
      )
      .all<{
        bucket: number;
        end: number;
      }>(fromMs, buckets, duration, subjectId, Math.max(-1, fromMs - 86460000), toMs, fromMs);
    const targets = new Uint8Array(buckets);
    for (const row of rows) {
      const last = Math.min(buckets - 1, Math.ceil(((row.end - fromMs) * buckets) / duration) - 1);
      for (let i = row.bucket; i <= last; i++) targets[i] = 1;
    }
    const spans: MediaTimeRange[] = [];
    for (let i = 0; i < buckets; i++)
      if (targets[i]) {
        const from = fromMs + (i * duration) / buckets,
          to = fromMs + ((i + 1) * duration) / buckets,
          last = spans.at(-1);
        if (last?.toMs === from) {
          last.toMs = to;
        } else spans.push({ fromMs: from, toMs: to });
      }

    if (this.coverageCache.size >= 64)
      this.coverageCache.delete(this.coverageCache.keys().next().value!);
    this.coverageCache.set(key, spans);
    return spans;
  }
  async readUnits(subjectId: string, ids: string[]): Promise<PersonalTimeline> {
    const favorites = await this.db
      .prepare(
        'SELECT u.id,u.subject AS "subjectId",u.sample AS "atMs",f.created AS "createdAtMs",u.start AS "fromMs",u."end" AS "toMs" FROM effective_unit_favorites f JOIN recording_units u ON u.id=f.unit WHERE u.subject=? AND u.id IN(SELECT value FROM json_array_elements_text(?::json) AS x(value)) AND u.deleted=0 ORDER BY u.start,u.id',
      )
      .all<FavoriteRange>(subjectId, JSON.stringify(ids));
    return {
      subjectId,
      fromMs: favorites[0]?.fromMs ?? 0,
      toMs: favorites.reduce((end, range) => Math.max(end, range.toMs), 0),
      favorites,
      revision: await this.revision(),
      truncated: false,
    };
  }
}
