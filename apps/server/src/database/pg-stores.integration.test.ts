import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Segment } from '@st-vault/api-schema';
import { EmbeddedPostgres } from './embedded.js';
import { SqlDatabase } from './sql.js';
import { RecordingUnits } from '../archive/recording-units.js';
import { PersonalStore } from '../archive/personal-store.js';
import { EventStore } from '../archive/events-store.js';
import { AccountSubjects } from '../archive/account-subjects.js';

describe.skipIf(process.env.STV_TEST_POSTGRES !== '1')('PostgreSQL archive stores', () => {
  let root: string;
  let service: EmbeddedPostgres;
  const databases: SqlDatabase[] = [];
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'stv-pg-stores-'));
    service = await EmbeddedPostgres.open({
      root,
      binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    });
    vi.stubEnv('STV_DATABASE_SOCKET', String(service.connection.host));
    vi.stubEnv('STV_DATABASE_PASSWORD', String(service.connection.password));
  }, 30000);
  afterEach(async () => {
    for (const db of databases.splice(0).reverse()) await db.close();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await service?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture(): Promise<SqlDatabase> {
    const db = await SqlDatabase.open(path.join(root, randomUUID()));
    databases.push(db);
    await db.exec(`CREATE TABLE subjects(id TEXT PRIMARY KEY,provider_id BIGINT NOT NULL,handle TEXT NOT NULL,
      monitor BIGINT NOT NULL DEFAULT 1,auto_record BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE account_subjects(subject TEXT PRIMARY KEY,following BIGINT NOT NULL);
      CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT NOT NULL,start DOUBLE PRECISION,"end" DOUBLE PRECISION,
        json TEXT NOT NULL,created_revision BIGINT NOT NULL,deleted BIGINT NOT NULL DEFAULT 0);
      CREATE VIEW visible_segments AS SELECT * FROM segments WHERE deleted=0;
      CREATE TABLE status_heads(subject TEXT PRIMARY KEY,start BIGINT,last_at BIGINT,valid_until BIGINT,
        status TEXT,active BIGINT,event_expired BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE media_deletions(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE deletion_items(job TEXT NOT NULL,segment TEXT NOT NULL);
      INSERT INTO subjects(id,provider_id,handle) VALUES('stripchat:1',1,'Original');`);
    return db;
  }
  async function append(
    db: SqlDatabase,
    units: RecordingUnits,
    id: string,
    start: number,
    end: number,
    revision: number,
  ): Promise<void> {
    const segment = {
      id,
      subjectId: 'stripchat:1',
      wallStartMs: start,
      wallEndMs: end,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
    } as Segment;
    await db.transaction(async () => {
      await db
        .prepare(
          'INSERT INTO segments(id,subject,start,"end",json,created_revision) VALUES(?,?,?,?,?,?)',
        )
        .run(id, segment.subjectId, start, end, JSON.stringify(segment), revision);
      await units.append(segment, revision);
    });
  }
  it('preserves full-fragment units, bounded selection and favorite coverage with native PG SQL', async () => {
    const db = await fixture();
    const units = new RecordingUnits(db);
    await units.initialize();
    await append(db, units, 'a', 59500, 61000, 1);
    await append(db, units, 'b', 61000, 63000, 2);
    await append(db, units, 'c', 64000, 65000, 3);
    await units.defer();
    expect(await units.ready()).toBe(false);
    expect(await db.transaction(() => units.build(2))).toBe(true);
    expect(await db.transaction(() => units.build(2))).toBe(false);
    expect(await units.list('stripchat:1', { fromMs: 0, toMs: 120000 })).toMatchObject([
      { id: 'a', start: 59500, end: 61000, closed: 1 },
      { id: 'b', start: 61000, end: 65000, closed: 0 },
    ]);
    expect(await units.snap('stripchat:1', [{ fromMs: 60000, toMs: 64000 }])).toEqual([
      { fromMs: 59500, toMs: 61000 },
      { fromMs: 61000, toMs: 65000 },
    ]);
    expect((await units.items('stripchat:1', ['b', 'a'])).map((item) => item.unitId)).toEqual([
      'b',
      'a',
    ]);
    expect((await units.at('stripchat:1', 60000))?.id).toBe('a');
    expect(await units.at('stripchat:1', 66000)).toBeUndefined();
    const personal = new PersonalStore(db, 100);
    await personal.initialize();
    await db.exec('CREATE VIEW effective_unit_favorites AS SELECT * FROM unit_favorites');
    await db.prepare('INSERT INTO unit_favorites VALUES(?,?)').run('a', 1000);
    expect((await personal.read('stripchat:1', 0, 120000)).favorites).toEqual([
      {
        id: 'a',
        subjectId: 'stripchat:1',
        atMs: 59500,
        createdAtMs: 1000,
        fromMs: 59500,
        toMs: 61000,
      },
    ]);
    expect(await personal.protectedCoverage('stripchat:1', 0, 120000, 5, 'one')).toEqual([
      { fromMs: 48000, toMs: 72000 },
    ]);
    expect((await personal.readUnits('stripchat:1', ['a'])).favorites).toHaveLength(1);
    await db.transaction(() => units.deleted('a'));
    expect(
      (await units.list('stripchat:1', { fromMs: 0, toMs: 120000 })).map((unit) => unit.id),
    ).toEqual(['b']);
    expect((await personal.read('stripchat:1', 0, 120000)).favorites).toHaveLength(0);
  });
  it('keeps only confirmed status transitions and preserves event/read/run identities', async () => {
    const db = await fixture();
    const events = new EventStore(db);
    await events.initialize();
    const run = await db.transaction(() => events.start(1000));
    await db.transaction(() => events.observation('stripchat:1', 'Original', 'PUBLIC', 1100));
    await db.exec("INSERT INTO status_heads VALUES('stripchat:1',1100,1100,9000,'PUBLIC',1,0)");
    expect(
      await db.transaction(() => events.observation('stripchat:1', 'Original', 'UNKNOWN', 1200)),
    ).toBe(false);
    await db.transaction(() => events.observation('stripchat:1', 'Original', 'PRIVATE', 2000));
    await db.transaction(() => events.observation('stripchat:1', 'Original', 'OFFLINE', 3000));
    const list = await events.list(0, 10);
    expect(list.items.map((event) => event.kind)).toEqual([
      'run_started',
      'status_changed',
      'status_changed',
    ]);
    expect(list.items.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(list.meta.unreadCount).toBe(3);
    expect((await db.transaction(() => events.ack(3))).unreadCount).toBe(0);
    await db.transaction(() => events.stop(run, 'normal', 4000));
    expect((await events.runs(0, 5000)).gaps).toEqual([
      { runId: run, fromMs: 4000, toMs: 5000, kind: 'stopped' },
    ]);
    expect((await events.list(0, 2, 3)).items.map((event) => event.id)).toEqual([1, 2]);
  });
  it('activates a sanitized account list atomically and disables archived recording policies', async () => {
    const db = await fixture();
    const disabled: string[] = [];
    const account = new AccountSubjects(
      db,
      async (subject) => {
        await db
          .prepare(
            'INSERT INTO subjects(id,provider_id,handle) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET handle=excluded.handle',
          )
          .run(subject.id, subject.providerId, subject.handle);
      },
      async (id) => {
        disabled.push(id);
        await db.prepare('UPDATE subjects SET auto_record=0 WHERE id=?').run(id);
      },
    );
    await account.initialize();
    await db.transaction(() =>
      account.upsert([{ id: 'stripchat:1', providerId: 1, handle: 'Original' }], true),
    );
    await db.exec("UPDATE subjects SET auto_record=1 WHERE id='stripchat:1'");
    const next = { id: 'stripchat:2', providerId: 2, handle: 'Next', cookiesText: 'private-extra' };
    await db.transaction(() => account.prepare([next], 'generation'));
    expect(await account.current()).toBeNull();
    expect(
      (await db.prepare('SELECT subjects FROM account_preparations').get<{ subjects: string }>())
        ?.subjects,
    ).not.toContain('private-extra');
    await db.transaction(() => account.activate('generation'));
    expect(await account.current()).toBe('generation');
    expect(
      await db.prepare('SELECT following FROM account_subjects WHERE subject=?').get('stripchat:1'),
    ).toEqual({ following: 0 });
    expect(
      await db.prepare('SELECT following FROM account_subjects WHERE subject=?').get('stripchat:2'),
    ).toEqual({ following: 1 });
    expect(
      await db.prepare('SELECT auto_record FROM subjects WHERE id=?').get('stripchat:1'),
    ).toEqual({ auto_record: 0 });
    expect(disabled).toEqual(['stripchat:1']);
    await db.transaction(() => account.activate('generation'));
    expect(disabled).toEqual(['stripchat:1']);
  });
});
