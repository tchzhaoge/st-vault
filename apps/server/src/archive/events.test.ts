import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SqlDatabase } from '../database/sql.js';
import { openTestDatabase, planNodes } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicStatus } from '@st-vault/api-schema';
import { openArchive } from './index.js';
import type { ArchiveHandle } from './index.js';
import { EventStore } from './events-store.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

const roots: string[] = [],
  archives: ArchiveHandle[] = [];
const subject = (id = 1) => ({ id: `stripchat:${id}`, providerId: id, handle: `fixture-${id}` });
async function create(root?: string): Promise<{ root: string; archive: ArchiveHandle }> {
  root ??= await mkdtemp(path.join(tmpdir(), 'stv-event-fixture-'));
  if (!roots.includes(root)) roots.push(root);
  const archive = await openArchive({ root });
  archives.push(archive);
  return { root, archive };
}
afterEach(async () => {
  await Promise.allSettled(archives.splice(0).map((a) => a.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function memory(policy: { maxEvents?: number; retentionDays?: number } = {}): Promise<{
  db: SqlDatabase;
  events: EventStore;
}> {
  const db = await openTestDatabase();
  await db.exec(
    'CREATE TABLE subjects(id TEXT PRIMARY KEY,handle TEXT,monitor BIGINT);CREATE TABLE status_heads(subject TEXT PRIMARY KEY,start BIGINT,last_at BIGINT,valid_until BIGINT,status TEXT,active BIGINT,event_expired BIGINT NOT NULL DEFAULT 0);',
  );
  const events = new EventStore(db, policy);
  await events.initialize();
  return { db, events };
}
describe('durable event history', () => {
  it('keeps event identities monotonic after restoring an empty pruned event table', async () => {
    const { db, events } = await memory();
    try {
      await db.exec('UPDATE event_meta SET latest=1000 WHERE id=1');
      await events.start(1000);
      expect((await events.list(0, 10)).items[0].id).toBe(1001);
    } finally {
      await db.close();
    }
  });
  it('filters existing internal events before pagination and unread counts using the confirmed index', async () => {
    const { db, events } = await memory();
    try {
      await events.observation('stripchat:1', 'fixture', 'PUBLIC', 1);
      await events.observation('stripchat:1', 'fixture', 'PRIVATE', 2);
      const insert = db.prepare('INSERT INTO archive_events(id,at_ms,json) VALUES(?,?,?)');
      await insert.run(
        2,
        3,
        JSON.stringify({
          kind: 'status_changed',
          fromStatus: 'PRIVATE',
          toStatus: 'UNKNOWN',
          reason: 'lease_expired',
          atMs: 3,
          occurredAtMs: 3,
          subjectId: 'stripchat:1',
          handle: 'fixture',
        }),
      );
      await insert.run(
        3,
        4,
        JSON.stringify({
          kind: 'status_changed',
          fromStatus: 'UNKNOWN',
          toStatus: 'PRIVATE',
          reason: 'observation',
          atMs: 4,
          occurredAtMs: 4,
          subjectId: 'stripchat:1',
          handle: 'fixture',
        }),
      );
      await db.exec('UPDATE event_meta SET latest=3,last_at=4,event_count=3 WHERE id=1');
      expect(await events.meta()).toMatchObject({
        latestCursor: 1,
        unreadCount: 1,
        oldestCursor: 1,
      });
      expect(await events.list(0, 1)).toMatchObject({ items: [{ id: 1 }], hasMore: false });
      expect((await events.list(0, 1, 4)).items.map((event) => event.id)).toEqual([1]);
      expect((await events.ack(1)).unreadCount).toBe(0);
      await events.observation('stripchat:1', 'fixture', 'OFFLINE', 5);
      expect((await events.list(1, 10)).items).toMatchObject([
        { id: 4, fromStatus: 'PRIVATE', toStatus: 'OFFLINE' },
      ]);
      expect(await events.meta()).toMatchObject({ latestCursor: 4, unreadCount: 1 });
      expect(
        await db
          .prepare(
            "SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND indexname='confirmed_event_id'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      await db.close();
    }
  });
  it('records only the six confirmed state transitions, never initial or duplicate observations', async () => {
    const { archive } = await create(),
      states: PublicStatus[] = ['PUBLIC', 'PRIVATE', 'OFFLINE'];
    let id = 0;
    for (const from of states)
      for (const to of states) {
        if (from === to) continue;
        const row = subject(++id),
          at = id * 10000;
        await archive.upsertSubjects([row]);
        await archive.setObservation(row.id, from, at, 1000);
        await archive.setObservation(row.id, from, at + 1, 1000);
        await archive.setObservation(row.id, to, to === 'UNKNOWN' ? at + 1001 : at + 2, 1000);
      }
    const page = await archive.events();
    expect(page.items).toHaveLength(6);
    const changes = page.items.filter((e) => e.kind === 'status_changed');
    expect(new Set(changes.map((e) => `${e.fromStatus}:${e.toStatus}`)).size).toBe(6);
    for (const item of changes) expect(item.reason).toBe('observation');
    expect(
      page.items.every(
        (item, i) =>
          i === 0 || (item.id > page.items[i - 1].id && item.atMs >= page.items[i - 1].atMs),
      ),
    ).toBe(true);
  });
  it('keeps lease expiry and recovery out of history without changing status coverage', async () => {
    const { archive } = await create();
    await archive.upsertSubjects([subject()]);
    const run = await archive.startRun(0);
    await archive.setObservation('stripchat:1', 'PUBLIC', 1000, 5000);
    await archive.setObservation('stripchat:1', 'UNKNOWN', 2000, 1000);
    expect((await archive.events()).items.map((e) => e.kind)).toEqual(['run_started']);
    expect(
      (await archive.statusHistory('stripchat:1', 1000, 6000, 1)).buckets[0].durationsMs.PUBLIC,
    ).toBe(5000);
    await archive.heartbeatRun(run, 9000);
    await archive.heartbeatRun(run, 10000);
    expect((await archive.events()).items.map((event) => event.kind)).toEqual(['run_started']);
    await archive.setObservation('stripchat:1', 'UNKNOWN', 10001, 1000);
    await archive.setObservation('stripchat:1', 'PUBLIC', 11000, 1000);
    expect((await archive.events()).items).toHaveLength(1);
    await archive.setObservation('stripchat:1', 'OFFLINE', 11500, 1000);
    expect((await archive.events()).items[1]).toMatchObject({
      fromStatus: 'PUBLIC',
      toStatus: 'OFFLINE',
      reason: 'observation',
      occurredAtMs: 11500,
    });
    await archive.setPolicy('stripchat:1', { monitorEnabled: false });
    await archive.heartbeatRun(run, 20000);
    expect((await archive.events()).items).toHaveLength(2);
  });
  it('persists both pagination directions and a monotonic read cursor without acknowledging unseen events', async () => {
    const { archive, root } = await create();
    await archive.upsertSubjects([subject()]);
    await archive.setObservation('stripchat:1', 'PUBLIC', 1000, 10000);
    for (let i = 0; i < 6; i++)
      await archive.setObservation('stripchat:1', i % 2 ? 'PUBLIC' : 'PRIVATE', 1001 + i, 10000);
    const first = await archive.events({ limit: 2 });
    expect(first.items.map((e) => e.id)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const latest = await archive.events({ before: 7, limit: 2 });
    expect(latest.items.map((e) => e.id)).toEqual([5, 6]);
    expect(latest.nextCursor).toBe(5);
    expect(latest.hasMore).toBe(true);
    expect(
      (await archive.events({ before: latest.nextCursor, limit: 2 })).items.map((e) => e.id),
    ).toEqual([3, 4]);
    await archive.ackEvents(2);
    await archive.ackEvents(1);
    expect(await archive.eventMeta()).toMatchObject({
      latestCursor: 6,
      readCursor: 2,
      unreadCount: 4,
    });
    await expect(archive.ackEvents(7)).rejects.toThrow('INVALID_EVENT_CURSOR');
    await expect(archive.events({ after: 1, before: 6 })).rejects.toThrow('INVALID_EVENT_QUERY');
    await archive.close();
    const { archive: next } = await create(root);
    expect(await next.eventMeta()).toMatchObject({
      latestCursor: 6,
      readCursor: 2,
      unreadCount: 4,
    });
    expect((await next.events({ after: first.nextCursor })).items.map((e) => e.id)).toEqual([
      3, 4, 5, 6,
    ]);
  });
  it('does not turn restart resets into hundreds of fake UNKNOWN/online transitions', async () => {
    const { archive, root } = await create(),
      subjects = Array.from({ length: 203 }, (_, i) => subject(i + 1));
    await archive.upsertSubjects(subjects);
    await archive.startRun(0);
    for (const row of subjects) await archive.setObservation(row.id, 'PUBLIC', 1000, 10000);
    expect((await archive.eventMeta()).latestCursor).toBe(1);
    await archive.close();
    const { archive: next } = await create(root);
    const run = await next.startRun(20000);
    await next.heartbeatRun(run, 21000);
    for (const row of subjects) await next.setObservation(row.id, 'PUBLIC', 22000, 10000);
    expect((await next.events()).items.map((e) => e.kind)).toEqual([
      'run_started',
      'run_abnormal',
      'run_started',
    ]);
    // 406 durable RPC transactions and two worker starts can exceed 5s on shared CI CPUs.
  }, 15000);
  it('records normal stop gaps and controlled abnormal stops with exact endpoints', async () => {
    const { archive } = await create();
    const first = await archive.startRun(1000);
    expect(await archive.startRun(1100)).toBe(first);
    await archive.heartbeatRun(first, 2000);
    await archive.stopRun(first, 'normal', 3000);
    await archive.stopRun(first, 'normal', 4000);
    const second = await archive.startRun(5000);
    await archive.stopRun(second, 'abnormal', 6000);
    const history = await archive.runHistory(0, 10000);
    expect(history.runs.map((r) => r.outcome)).toEqual(['normal', 'abnormal']);
    expect(history.gaps).toEqual([
      { runId: first, fromMs: 3000, toMs: 5000, kind: 'stopped' },
      { runId: second, fromMs: 6000, toMs: 10000, kind: 'stopped' },
    ]);
    expect((await archive.events()).items.map((e) => e.kind)).toEqual([
      'run_started',
      'run_stopped',
      'run_started',
      'run_abnormal',
    ]);
  });
  it('detects a crash only on the next explicit start and preserves heartbeat-to-restart uncertainty', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-event-crash-'));
    roots.push(root);
    const script = `import {openArchive} from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};const a=await openArchive({root:${JSON.stringify(root)}});const id=await a.startRun(1000);await a.heartbeatRun(id,4000);process.exit(73);`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { stdio: 'ignore', windowsHide: true },
    );
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      expect(
        await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        }),
      ).toBe(73);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
    const { archive } = await create(root);
    expect((await archive.events()).items.map((e) => e.kind)).toEqual(['run_started']);
    await archive.startRun(10000);
    expect((await archive.events()).items[1]).toMatchObject({
      kind: 'run_abnormal',
      atMs: 10000,
      occurredAtMs: 4000,
      startedAtMs: 1000,
      lastHeartbeatAtMs: 4000,
      stoppedAtMs: 4000,
      uncertainUntilMs: 10000,
    });
    expect((await archive.runHistory(2000, 11000)).gaps[0]).toMatchObject({
      fromMs: 4000,
      toMs: 10000,
      kind: 'uncertain',
    });
  });
  it('caps retention work at one thousand rows, preserves IDs and exposes lost-history cursors', async () => {
    const { db, events } = await memory({ retentionDays: 1 });
    try {
      await db.transaction(async () => {
        for (let i = 0; i <= 1050; i++)
          await events.observation(
            'stripchat:1',
            'fixture',
            i % 2 ? 'PUBLIC' : 'PRIVATE',
            1000 + i,
          );
      });
      await events.prune(2 * 86400000);
      expect(await events.meta()).toMatchObject({
        latestCursor: 1050,
        unreadCount: 50,
        oldestCursor: 1001,
      });
      await events.prune(2 * 86400000);
      expect(await events.meta()).toMatchObject({
        latestCursor: 1050,
        unreadCount: 0,
        oldestCursor: 1051,
      });
      await events.observation('stripchat:1', 'fixture', 'PUBLIC', 2 * 86400000 + 1);
      expect((await events.meta()).latestCursor).toBe(1051);
      expect((await events.list(1, 100)).cursorExpired).toBe(true);
    } finally {
      await db.close();
    }
    const capped = await memory({ maxEvents: 3 });
    try {
      for (let i = 0; i <= 10; i++)
        await capped.events.observation(
          'stripchat:1',
          'fixture',
          i % 2 ? 'PUBLIC' : 'PRIVATE',
          1000 + i,
        );
      expect(await capped.events.meta()).toMatchObject({
        latestCursor: 10,
        oldestCursor: 8,
        unreadCount: 3,
      });
      expect((await capped.events.list(0, 200)).items.map((e) => e.id)).toEqual([8, 9, 10]);
    } finally {
      await capped.db.close();
    }
  });
  it('bounds run windows at 500 rows and uses the partial expiry index instead of scanning expired history', async () => {
    const { db, events } = await memory();
    try {
      await db.transaction(async () => {
        for (let i = 0; i < 501; i++) {
          const id = await events.start(i * 10);
          await events.stop(id, 'normal', i * 10 + 1);
        }
      });
      const history = await events.runs(0, 10000);
      expect(history.runs).toHaveLength(500);
      expect(history.truncated).toBe(true);
      expect(history.gaps.at(-1)?.toMs).toBe(5000);
      await db.exec(`INSERT INTO status_heads(subject,start,last_at,valid_until,status,active,event_expired)
        SELECT 'expired-'||n,n,n,n,'UNKNOWN',0,1 FROM generate_series(1,5000)n;ANALYZE status_heads`);
      const plan = planNodes(
        await db
          .prepare(
            "EXPLAIN (FORMAT JSON) SELECT h.* FROM status_heads h WHERE h.active=1 AND h.event_expired=0 AND h.status!='UNKNOWN' AND h.valid_until<=? ORDER BY h.valid_until,h.subject LIMIT 1000",
          )
          .all(10000),
      );
      expect(plan.some((node) => node['Index Name'] === 'status_event_expiry')).toBe(true);
      expect(
        plan.some(
          (node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'status_heads',
        ),
      ).toBe(false);
    } finally {
      await db.close();
    }
  });
});
