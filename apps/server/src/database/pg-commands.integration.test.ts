import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EmbeddedPostgres } from './embedded.js';
import { SqlDatabase } from './sql.js';
import { DeletionStore } from '../archive/deletion-store.js';
import { DeletionIntents } from '../archive/deletion-intents.js';
import { MediaSelectionStore } from '../archive/media-selection-store.js';
import { FavoriteCommands } from '../archive/favorite-commands.js';
import { initializeUnitVisibility } from '../archive/unit-visibility.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.unstubAllEnvs();
});

describe.skipIf(process.env.STV_TEST_POSTGRES !== '1')('PostgreSQL media commands', () => {
  const subject = 'stripchat:42';
  async function fixture(count = 520) {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-pg-commands-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const server = await EmbeddedPostgres.open({
      root,
      binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    });
    cleanup.push(() => server.close());
    vi.stubEnv('STV_DATABASE_SOCKET', server.connection.host);
    if (typeof server.connection.password !== 'string')
      throw Error('TEST_DATABASE_PASSWORD_REQUIRED');
    vi.stubEnv('STV_DATABASE_PASSWORD', server.connection.password);
    let db = await SqlDatabase.open(root);
    cleanup.push(() => db.close());
    await db.exec(`CREATE TABLE subjects(id TEXT PRIMARY KEY,deletion_revision BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE personal_owner(id BIGINT PRIMARY KEY,revision BIGINT NOT NULL DEFAULT 0);
      INSERT INTO personal_owner VALUES(1,0);
      CREATE TABLE objects(id TEXT PRIMARY KEY,bytes BIGINT NOT NULL);
      CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT NOT NULL,media TEXT NOT NULL,start BIGINT NOT NULL,
        "end" BIGINT NOT NULL,created_revision BIGINT NOT NULL,deleted BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE recording_units(id TEXT PRIMARY KEY,subject TEXT NOT NULL REFERENCES subjects(id) DEFERRABLE INITIALLY DEFERRED,
        start BIGINT NOT NULL,"end" BIGINT NOT NULL,created_revision BIGINT NOT NULL,closed BIGINT NOT NULL DEFAULT 1,deleted BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE unit_segments(segment TEXT PRIMARY KEY REFERENCES segments(id) DEFERRABLE INITIALLY DEFERRED,
        unit TEXT NOT NULL REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE unit_favorites(unit TEXT PRIMARY KEY REFERENCES recording_units(id) DEFERRABLE INITIALLY DEFERRED,created BIGINT NOT NULL);`);
    await db.prepare('INSERT INTO subjects(id) VALUES(?)').run(subject);
    await db
      .prepare(
        `INSERT INTO objects SELECT 'u-'||lpad(n::text,6,'0'),1000 FROM generate_series(1,?::integer) n`,
      )
      .run(count);
    await db
      .prepare(
        `INSERT INTO segments SELECT id,?,id,(substring(id,3)::bigint-1)*60000,substring(id,3)::bigint*60000,
      substring(id,3)::bigint,0 FROM objects`,
      )
      .run(subject);
    await db
      .prepare(
        'INSERT INTO recording_units(id,subject,start,"end",created_revision) SELECT id,subject,start,"end",created_revision FROM segments',
      )
      .run();
    await db.prepare('INSERT INTO unit_segments SELECT id,id FROM segments').run();
    await db.prepare('UPDATE recording_units SET closed=0 WHERE created_revision=?').run(count);
    const revision = () => Promise.resolve(count);
    const personal = async () =>
      (await db
        .prepare('SELECT revision FROM personal_owner WHERE id=1')
        .get<{ revision: number }>())!.revision;
    const pipeline = async () => {
      const jobs = new DeletionStore(db, personal);
      await jobs.initialize();
      const selections = new MediaSelectionStore(db, revision);
      await selections.initialize();
      await initializeUnitVisibility(db);
      const favorites = new FavoriteCommands(db, selections);
      await favorites.initialize();
      const intents = new DeletionIntents(db, jobs, selections, revision, personal);
      await intents.initialize();
      await initializeUnitVisibility(db, true);
      await db.exec(`CREATE OR REPLACE VIEW visible_segments AS SELECT s.* FROM segments s WHERE
        NOT EXISTS(SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job WHERE i.segment=s.id AND d.state IN('queued','running','retry'))
        AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN recording_units u ON u.id=m.unit WHERE m.segment=s.id AND u.deleted=1)
        AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN deletion_intent_units i ON i.unit=m.unit WHERE m.segment=s.id);`);
      return { jobs, selections, favorites, intents };
    };
    return {
      get db() {
        return db;
      },
      personal,
      pipeline,
      async reopen() {
        await db.close();
        db = await SqlDatabase.open(root);
        return pipeline();
      },
    };
  }

  it('admits immediately, preserves favorites and later commits, and resumes bounded preparation', async () => {
    const f = await fixture();
    let stores = await f.pipeline();
    await f.db.prepare('INSERT INTO unit_favorites VALUES(?,?)').run('u-000001', Date.now());
    const id = randomUUID();
    const target = {
      kind: 'range' as const,
      mode: 'unliked' as const,
      fromMs: 0,
      toMs: 520 * 60000,
    };
    const admitted = await f.db.transaction(() => stores.intents.admit(subject, id, target));
    expect(admitted).toMatchObject({
      id,
      state: 'preparing',
      phase: 'units',
      processed: 0,
      total: 0,
    });
    expect(
      await f.db.prepare('SELECT count(*) AS count FROM deletion_units WHERE job=?').get(id),
    ).toEqual({ count: 0 });
    expect(
      await f.db.prepare('SELECT count(*) AS count FROM visible_segments WHERE deleted=0').get(),
    ).toEqual({ count: 1 });
    expect(
      await f.db.prepare('SELECT closed FROM recording_units WHERE id=?').get('u-000520'),
    ).toEqual({ closed: 1 });
    expect((await f.db.transaction(() => stores.intents.admit(subject, id, target))).id).toBe(id);
    await expect(
      f.db.transaction(() => stores.intents.admit(subject, id, { ...target, toMs: 1 })),
    ).rejects.toThrow('COMMAND_ID_CONFLICT');
    await f.db.transaction(async () => {
      await f.db.exec(`INSERT INTO objects VALUES('later',1000);
        INSERT INTO segments VALUES('later','stripchat:42','later',31200000,31260000,521,0);
        INSERT INTO recording_units VALUES('later','stripchat:42',31200000,31260000,521,0,0);
        INSERT INTO unit_segments VALUES('later','later');`);
    });
    stores = await f.reopen();
    await f.db.transaction(() => stores.jobs.recover());
    let priorScanned = 0,
      priorTotal = 0;
    for (let steps = 0; steps < 32; steps++) {
      const job = await f.db.transaction(() => stores.intents.step());
      if (!job) break;
      expect((job.scannedUnits ?? 0) - priorScanned).toBeLessThanOrEqual(256);
      expect(job.total - priorTotal).toBeLessThanOrEqual(128);
      priorScanned = job.scannedUnits ?? 0;
      priorTotal = job.total;
      if (job.state === 'queued') break;
    }
    expect(await stores.intents.get(id)).toMatchObject({
      state: 'queued',
      total: 519,
      selectedUnits: 519,
    });
    expect(
      await f.db.prepare('SELECT id FROM visible_segments WHERE deleted=0 ORDER BY id').all(),
    ).toEqual([{ id: 'later' }, { id: 'u-000001' }]);
    let processed = 0;
    for (let steps = 0; steps < 10; steps++) {
      const job = await f.db.transaction(() => stores.jobs.next());
      if (!job) break;
      expect(job.segmentIds.length).toBeLessThanOrEqual(128);
      await f.db.transaction(async () => {
        for (const segment of job.segmentIds)
          await f.db.prepare('UPDATE segments SET deleted=1 WHERE id=?').run(segment);
        processed += job.segmentIds.length;
        await stores.jobs.advance(id, processed, job.segmentIds.length * 1000);
      });
    }
    expect(await stores.jobs.get(id)).toMatchObject({
      state: 'completed',
      processed: 519,
      reclaimedBytes: 519000,
      subjectId: subject,
    });
  }, 30000);

  it('keeps favorite commands logical before materialization and rejects a stale unliked deletion', async () => {
    const f = await fixture(6);
    const s = await f.pipeline();
    const selection = await f.db.transaction(() =>
      s.selections.begin(subject, { fromMs: 0, toMs: 360000 }, 'explicit', {
        includeUnitIds: ['u-000001', 'u-000002'],
      }),
    );
    await f.db.transaction(() => s.selections.build(subject, selection));
    expect((await s.selections.summary(subject, selection)).count).toBe(2);
    await f.db.transaction(() => s.favorites.accept(subject, selection, true, 0));
    expect(await f.db.prepare('SELECT unit FROM unit_favorite_facts ORDER BY unit').all()).toEqual([
      { unit: 'u-000001' },
      { unit: 'u-000002' },
    ]);
    expect(await f.db.prepare('SELECT count(*) AS count FROM unit_favorites').get()).toEqual({
      count: 0,
    });
    expect(await s.favorites.status()).toEqual({ pending: 1, processed: 0, total: 2 });
    await f.db.transaction(() => s.favorites.step());
    expect(await f.db.prepare('SELECT unit FROM unit_favorites ORDER BY unit').all()).toEqual([
      { unit: 'u-000001' },
      { unit: 'u-000002' },
    ]);
    const job = randomUUID();
    await f.db.transaction(() =>
      s.intents.admit(subject, job, { kind: 'range', mode: 'unliked', fromMs: 0, toMs: 360000 }),
    );
    await f.db.exec('UPDATE personal_owner SET revision=revision+1 WHERE id=1');
    expect(await f.db.transaction(() => s.intents.step())).toMatchObject({
      state: 'failed',
      error: 'media_selection_stale',
    });
    expect(
      await f.db.prepare('SELECT count(*) AS count FROM visible_segments WHERE deleted=0').get(),
    ).toEqual({ count: 6 });
    expect(await f.db.prepare('SELECT count(*) AS count FROM deletion_items').get()).toEqual({
      count: 0,
    });
  }, 30000);

  it('keeps legacy exact plans idempotent and applies PostgreSQL retry backoff', async () => {
    const f = await fixture(3);
    const s = await f.pipeline();
    await f.db.prepare('INSERT INTO unit_favorites VALUES(?,?)').run('u-000001', Date.now());
    const plan = await f.db.transaction(() =>
      s.jobs.begin(subject, [{ fromMs: 100, toMs: 119999 }], 3),
    );
    for (let i = 0; i < 16; i++) if (!(await f.db.transaction(() => s.jobs.build(plan)))) break;
    expect(await s.jobs.plan(plan)).toMatchObject({
      total: 2,
      bytes: 2000,
      favoriteSegments: 1,
      ranges: [{ fromMs: 100, toMs: 119999 }],
    });
    const accepted = await f.db.transaction(() => s.jobs.accept(subject, plan, 0));
    expect(accepted).toMatchObject({ state: 'queued', subjectId: subject, total: 2 });
    expect(await f.db.transaction(() => s.jobs.accept(subject, plan, 99))).toMatchObject({
      id: plan,
      state: 'queued',
    });
    await f.db.transaction(() => s.jobs.retry(plan));
    const retry = await f.db
      .prepare('SELECT state,retry_at,attempts FROM media_deletions WHERE id=?')
      .get<{ state: string; retry_at: number; attempts: number }>(plan);
    expect(retry).toMatchObject({ state: 'retry', attempts: 1 });
    expect(retry!.retry_at).toBeGreaterThan(Date.now() + 25000);
  }, 30000);
});
