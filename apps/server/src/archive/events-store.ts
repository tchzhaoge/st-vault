import { randomUUID } from 'node:crypto';
import type { SqlDatabase, SQLInputValue } from '../database/sql.js';
import type {
  ArchiveEvent,
  EventMeta,
  EventsResponse,
  ProgramRun,
  PublicStatus,
  RunHistoryResponse,
} from '@st-vault/api-schema';
type EventInput = ArchiveEvent extends infer T
  ? T extends ArchiveEvent
    ? Omit<T, 'id' | 'atMs'>
    : never
  : never;
interface MetaRow {
  latest: number;
  last_at: number;
  read_cursor: number;
  revision: number;
  event_count: number;
  run_count: number;
}
interface Head {
  subject: string;
  status: PublicStatus;
  last_at: number;
  valid_until: number;
  active: number;
  event_expired: number;
  handle: string;
}
interface RunRow {
  id: string;
  started: number;
  heartbeat: number;
  ended: number | null;
  outcome: 'running' | 'normal' | 'abnormal';
  detected: number | null;
}
const DAY = 86400000;
const CONFIRMED = `((json::jsonb->>'kind') IN ('run_started','run_stopped','run_abnormal') OR ((json::jsonb->>'kind')='status_changed' AND (json::jsonb->>'reason')='observation' AND (json::jsonb->>'fromStatus') IN ('PUBLIC','PRIVATE','OFFLINE') AND (json::jsonb->>'toStatus') IN ('PUBLIC','PRIVATE','OFFLINE')))`;
/** Mutating entry points share the metadata owner’s outer PostgreSQL transaction. */
export class EventStore {
  private readonly db: SqlDatabase;
  private currentRun: string | undefined;
  private readonly retentionDays: number;
  private readonly maxEvents: number;
  constructor(
    db: SqlDatabase,
    policy: {
      retentionDays?: number;
      maxEvents?: number;
    } = {},
  ) {
    this.db = db;
    this.retentionDays = policy.retentionDays ?? 30;
    this.maxEvents = policy.maxEvents ?? 100000;
    if (
      !Number.isSafeInteger(this.retentionDays) ||
      this.retentionDays < 1 ||
      this.retentionDays > 3650 ||
      !Number.isSafeInteger(this.maxEvents) ||
      this.maxEvents < 1 ||
      this.maxEvents > 100000
    )
      throw new Error('INVALID_EVENT_POLICY');
  }
  async initialize(): Promise<void> {
    const db = this.db;
    await db.exec(`CREATE TABLE IF NOT EXISTS event_meta(id BIGINT PRIMARY KEY,latest BIGINT NOT NULL,last_at BIGINT NOT NULL,read_cursor BIGINT NOT NULL,revision BIGINT NOT NULL,event_count BIGINT NOT NULL,run_count BIGINT NOT NULL);
      INSERT INTO event_meta VALUES(1,0,0,0,0,0,0) ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS archive_events(id BIGINT PRIMARY KEY ,at_ms BIGINT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_time ON archive_events(at_ms,id);
      CREATE TABLE IF NOT EXISTS status_event_states(subject TEXT PRIMARY KEY,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS program_runs(id TEXT PRIMARY KEY,started BIGINT NOT NULL,heartbeat BIGINT NOT NULL,ended BIGINT,outcome TEXT NOT NULL,detected BIGINT);
      CREATE INDEX IF NOT EXISTS run_started ON program_runs(started,id);
      CREATE INDEX IF NOT EXISTS run_ended ON program_runs(ended,id);
      CREATE UNIQUE INDEX IF NOT EXISTS single_running_program ON program_runs(outcome) WHERE outcome='running';`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS confirmed_event_id ON archive_events(id) WHERE ${CONFIRMED}`,
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS status_event_expiry ON status_heads(valid_until,subject) WHERE active=1 AND event_expired=0 AND status!='UNKNOWN'`,
    );
  }
  async recover(): Promise<void> {
    await this.db.exec(
      'INSERT INTO status_event_states SELECT subject,status FROM status_heads ON CONFLICT(subject) DO NOTHING',
    );
  }
  private async one<T>(sql: string, ...args: SQLInputValue[]): Promise<T | undefined> {
    return await this.db.prepare(sql).get<T>(...args);
  }
  private async state(): Promise<MetaRow> {
    return (await this.one<MetaRow>('SELECT * FROM event_meta WHERE id=1'))!;
  }
  private async append(input: EventInput, detectedAt: number): Promise<void> {
    const state = await this.state(),
      atMs = Math.max(detectedAt, state.last_at),
      id = state.latest + 1;
    if (!Number.isSafeInteger(id)) throw new Error('EVENT_ID_OVERFLOW');
    // The portable logical counter owns identity even when every inserted event
    // is pruned; restoring a library must never reuse confirmed event IDs.
    await this.db
      .prepare('INSERT INTO archive_events(id,at_ms,json) VALUES(?,?,?)')
      .run(id, atMs, JSON.stringify({ ...input, atMs }));
    await this.db
      .prepare(
        'UPDATE event_meta SET latest=?,last_at=?,revision=revision+1,event_count=event_count+1 WHERE id=1',
      )
      .run(id, atMs);
    // Keep even an event storm bounded without waiting for the next heartbeat.
    if ((await this.state()).event_count > this.maxEvents) await this.prune(detectedAt);
  }
  private async expire(head: Head, detectedAt: number): Promise<void> {
    if (
      !head.active ||
      head.event_expired ||
      head.status === 'UNKNOWN' ||
      head.valid_until > detectedAt
    )
      return;
    // Lease expiry belongs to observation coverage, not confirmed user events.
    // Keep the last confirmed state so PUBLIC → unknown → PUBLIC is silent.
    await this.db
      .prepare('UPDATE status_heads SET event_expired=1 WHERE subject=?')
      .run(head.subject);
  }
  /** UNKNOWN is a failed/indeterminate poll, never new evidence that shortens a known lease. */
  async observation(
    id: string,
    handle: string,
    status: PublicStatus,
    at: number,
  ): Promise<boolean> {
    const head = await this.one<Head>(
      'SELECT h.*,s.handle FROM status_heads h JOIN subjects s ON s.id=h.subject WHERE h.subject=?',
      id,
    );
    if (head) await this.expire(head, at);
    if (status === 'UNKNOWN' && head && head.status !== 'UNKNOWN') return false;
    if (status === 'UNKNOWN') return true;
    const state = await this.one<{
      status: PublicStatus;
    }>('SELECT status FROM status_event_states WHERE subject=?', id);
    if (state && state.status !== 'UNKNOWN' && state.status !== status)
      await this.append(
        {
          kind: 'status_changed',
          subjectId: id,
          handle,
          fromStatus: state.status,
          toStatus: status,
          reason: 'observation',
          occurredAtMs: at,
        },
        at,
      );
    await this.db
      .prepare(
        'INSERT INTO status_event_states VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET status=excluded.status',
      )
      .run(id, status);
    return true;
  }
  async expireDue(at: number): Promise<void> {
    const rows = await this.db
      .prepare(
        "SELECT h.*,s.handle FROM status_heads h JOIN subjects s ON s.id=h.subject WHERE h.active=1 AND h.event_expired=0 AND h.status!='UNKNOWN' AND h.valid_until<=? AND s.monitor=1 ORDER BY h.valid_until,h.subject LIMIT 1000",
      )
      .all<Head>(at);
    for (const head of rows) await this.expire(head, at);
  }
  async meta(): Promise<EventMeta> {
    const row = await this.state(),
      oldest =
        (
          await this.one<{
            id: number;
          }>(`SELECT id FROM archive_events WHERE ${CONFIRMED} ORDER BY id LIMIT 1`)
        )?.id ?? Math.min(Number.MAX_SAFE_INTEGER, row.latest + 1);
    return {
      latestCursor:
        (
          await this.one<{
            id: number;
          }>(`SELECT id FROM archive_events WHERE ${CONFIRMED} ORDER BY id DESC LIMIT 1`)
        )?.id ?? row.latest,
      readCursor: row.read_cursor,
      oldestCursor: oldest,
      unreadCount: (await this.one<{
        count: number;
      }>(
        `SELECT COUNT(*) AS count FROM archive_events WHERE id>? AND ${CONFIRMED}`,
        row.read_cursor,
      ))!.count,
      revision: row.revision,
      retentionDays: this.retentionDays,
      maxEvents: this.maxEvents,
    };
  }
  async list(after: number, limit: number, before?: number): Promise<EventsResponse> {
    const rows = await this.db
      .prepare(
        before === undefined
          ? `SELECT id,json FROM archive_events WHERE id>? AND ${CONFIRMED} ORDER BY id LIMIT ?`
          : `SELECT id,json FROM archive_events WHERE id<? AND ${CONFIRMED} ORDER BY id DESC LIMIT ?`,
      )
      .all<{
        id: number;
        json: string;
      }>(before ?? after, limit + 1);
    const page = rows.slice(0, limit);
    if (before !== undefined) page.reverse();
    const items = page.map(
        (row) =>
          ({ ...(JSON.parse(row.json) as Omit<ArchiveEvent, 'id'>), id: row.id }) as ArchiveEvent,
      ),
      meta = await this.meta();
    return {
      items,
      nextCursor: (before === undefined ? items.at(-1)?.id : items[0]?.id) ?? before ?? after,
      hasMore: rows.length > limit,
      cursorExpired:
        before === undefined
          ? after > 0 && after < meta.oldestCursor - 1
          : before <= meta.oldestCursor && meta.oldestCursor > 1,
      meta,
    };
  }
  async ack(cursor: number): Promise<EventMeta> {
    const state = await this.state();
    if (cursor > state.latest) throw new Error('INVALID_EVENT_CURSOR');
    if (cursor > state.read_cursor)
      await this.db
        .prepare('UPDATE event_meta SET read_cursor=?,revision=revision+1 WHERE id=1')
        .run(cursor);
    return await this.meta();
  }
  private program(row: RunRow): ProgramRun {
    return {
      runId: row.id,
      startedAtMs: row.started,
      lastHeartbeatAtMs: row.heartbeat,
      stoppedAtMs: row.ended,
      outcome: row.outcome,
      detectedAtMs: row.detected,
    };
  }
  async start(at: number): Promise<string> {
    if (
      this.currentRun &&
      (await this.one<RunRow>('SELECT * FROM program_runs WHERE id=?', this.currentRun))
        ?.outcome === 'running'
    )
      return this.currentRun;
    const previous = await this.one<RunRow>("SELECT * FROM program_runs WHERE outcome='running'");
    if (previous) {
      const detected = Math.max(at, previous.heartbeat);
      await this.db
        .prepare("UPDATE program_runs SET outcome='abnormal',ended=heartbeat,detected=? WHERE id=?")
        .run(detected, previous.id);
      await this.append(
        {
          kind: 'run_abnormal',
          runId: previous.id,
          startedAtMs: previous.started,
          lastHeartbeatAtMs: previous.heartbeat,
          stoppedAtMs: previous.heartbeat,
          uncertainUntilMs: detected,
          occurredAtMs: previous.heartbeat,
        },
        detected,
      );
    }
    const id = randomUUID(),
      start = Math.max(at, previous?.heartbeat ?? 0, (await this.state()).last_at);
    await this.db
      .prepare("INSERT INTO program_runs VALUES(?,?,?,NULL,'running',NULL)")
      .run(id, start, start);
    await this.db.exec('UPDATE event_meta SET run_count=run_count+1 WHERE id=1');
    await this.append(
      {
        kind: 'run_started',
        runId: id,
        startedAtMs: start,
        lastHeartbeatAtMs: start,
        stoppedAtMs: null,
        uncertainUntilMs: null,
        occurredAtMs: start,
      },
      start,
    );
    this.currentRun = id;
    await this.maintain(at);
    return id;
  }
  async heartbeat(id: string, at: number): Promise<void> {
    const run = await this.one<RunRow>('SELECT * FROM program_runs WHERE id=?', id);
    if (!run || id !== this.currentRun || run.outcome !== 'running')
      throw new Error('RUN_NOT_ACTIVE');
    if (at > run.heartbeat)
      await this.db.prepare('UPDATE program_runs SET heartbeat=? WHERE id=?').run(at, id);
    await this.maintain(at);
  }
  async stop(id: string, outcome: 'normal' | 'abnormal', at: number): Promise<void> {
    const run = await this.one<RunRow>('SELECT * FROM program_runs WHERE id=?', id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (run.outcome !== 'running') return;
    if (id !== this.currentRun) throw new Error('RUN_NOT_ACTIVE');
    const end = Math.max(at, run.heartbeat);
    await this.db
      .prepare('UPDATE program_runs SET ended=?,outcome=?,detected=? WHERE id=?')
      .run(end, outcome, end, id);
    await this.append(
      {
        kind: outcome === 'normal' ? 'run_stopped' : 'run_abnormal',
        runId: id,
        startedAtMs: run.started,
        lastHeartbeatAtMs: run.heartbeat,
        stoppedAtMs: end,
        uncertainUntilMs: null,
        occurredAtMs: end,
      },
      end,
    );
    await this.maintain(at);
  }
  async maintain(at: number): Promise<void> {
    await this.expireDue(at);
    await this.prune(at);
  }
  async prune(at: number): Promise<void> {
    const state = await this.state(),
      cutoff = Math.max(0, at - this.retentionDays * DAY),
      excess = Math.min(1000, Math.max(0, state.event_count - this.maxEvents));
    let removed = 0;
    if (excess)
      removed += Number(
        (
          await this.db
            .prepare(
              'DELETE FROM archive_events WHERE id IN (SELECT id FROM archive_events ORDER BY id LIMIT ?)',
            )
            .run(excess)
        ).changes,
      );
    if (removed < 1000)
      removed += Number(
        (
          await this.db
            .prepare(
              'DELETE FROM archive_events WHERE id IN (SELECT id FROM archive_events WHERE at_ms<? ORDER BY at_ms,id LIMIT ?)',
            )
            .run(cutoff, 1000 - removed)
        ).changes,
      );
    if (removed)
      await this.db
        .prepare('UPDATE event_meta SET event_count=event_count-?,revision=revision+1 WHERE id=1')
        .run(removed);
    const excessRuns = Math.min(1000, Math.max(0, state.run_count - this.maxEvents));
    let removedRuns = 0;
    if (excessRuns)
      removedRuns += Number(
        (
          await this.db
            .prepare(
              'DELETE FROM program_runs WHERE id IN (SELECT id FROM program_runs WHERE ended IS NOT NULL ORDER BY ended,id LIMIT ?)',
            )
            .run(excessRuns)
        ).changes,
      );
    if (removedRuns < 1000)
      removedRuns += Number(
        (
          await this.db
            .prepare(
              'DELETE FROM program_runs WHERE id IN (SELECT id FROM program_runs WHERE ended<? ORDER BY ended,id LIMIT ?)',
            )
            .run(cutoff, 1000 - removedRuns)
        ).changes,
      );
    if (removedRuns)
      await this.db
        .prepare('UPDATE event_meta SET run_count=run_count-?,revision=revision+1 WHERE id=1')
        .run(removedRuns);
  }
  async runs(from: number, to: number): Promise<RunHistoryResponse> {
    const first =
      (
        await this.one<{
          started: number;
        }>(
          'SELECT started FROM program_runs WHERE started<=? ORDER BY started DESC,id DESC LIMIT 1',
          from,
        )
      )?.started ?? from;
    const rows = await this.db
      .prepare(
        'SELECT * FROM program_runs WHERE started>=? AND started<? ORDER BY started,id LIMIT 501',
      )
      .all<RunRow>(first, to);
    const output = rows.slice(0, 500),
      gaps: RunHistoryResponse['gaps'] = [];
    for (let index = 0; index < output.length; index++) {
      const run = output[index];
      if (run.ended === null) continue;
      const start = Math.max(from, run.ended),
        next = rows[index + 1]?.started;
      const end = Math.min(
        to,
        run.outcome === 'abnormal' && run.detected !== null && run.detected > run.ended
          ? run.detected
          : (next ?? to),
      );
      if (end > start)
        gaps.push({
          runId: run.id,
          fromMs: start,
          toMs: end,
          kind: run.detected !== null && run.detected > run.ended ? 'uncertain' : 'stopped',
        });
    }
    return {
      fromMs: from,
      toMs: to,
      runs: output.map((row) => this.program(row)),
      gaps,
      truncated: rows.length > 500,
    };
  }
}
