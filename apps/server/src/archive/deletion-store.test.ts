import { openTestDatabase, planNodes } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { expect, it } from 'vitest';
import { DeletionStore } from './deletion-store.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it('freezes more than 4096 files in bounded pages and accepts without materializing IDs', async () => {
  const db = await openTestDatabase();
  try {
    await db.exec(
      '\n    CREATE TABLE subjects(id TEXT PRIMARY KEY);\n    CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT,start DOUBLE PRECISION,"end" DOUBLE PRECISION,deleted BIGINT,created_revision BIGINT,media TEXT);\n    CREATE INDEX segment_window ON segments(subject,deleted,start,id,"end",created_revision);\n    CREATE INDEX segment_unit_append ON segments(subject,created_revision,id);\n    CREATE TABLE objects(id TEXT PRIMARY KEY,bytes BIGINT);\n    CREATE TABLE recording_units(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,closed BIGINT DEFAULT 0,deleted BIGINT DEFAULT 0);\n    CREATE TABLE unit_segments(segment TEXT PRIMARY KEY REFERENCES segments(id),unit TEXT REFERENCES recording_units(id));\n    CREATE INDEX unit_members ON unit_segments(unit,segment);\n    CREATE TABLE unit_favorites(unit TEXT PRIMARY KEY REFERENCES recording_units(id),created BIGINT);\n    CREATE VIEW effective_unit_favorites AS SELECT * FROM unit_favorites;\n    INSERT INTO subjects VALUES(\'stripchat:1\'); INSERT INTO objects VALUES(\'media\',10);',
    );
    const insert = db.prepare('INSERT INTO segments VALUES(?,?,?,?,0,?,?)');
    await db.transaction(async () => {
      // Seed the same 10,000 facts in one statement: this test exercises bounded
      // deletion plans, not serial client/server insertion round trips.
      await db.exec(`INSERT INTO segments
      SELECT lpad(i::text,8,'0'),'stripchat:1',i*1000,i*1000+1000,0,i+1,'media'
      FROM generate_series(0,9999) AS n(i);`);
      await db.exec(`INSERT INTO recording_units VALUES('selected','stripchat:1',0,10000000,0,0);
    INSERT INTO unit_segments SELECT id,'selected' FROM segments;`);
    });
    const store = new DeletionStore(db, () => Promise.resolve(0));
    await store.initialize();
    const id = await store.begin('stripchat:1', [{ fromMs: 0, toMs: 10000000 }], 10000);
    let pages = 0;
    while (await store.build(id)) pages++;
    expect(pages).toBeGreaterThan(70);
    const plan = await store.plan(id);
    expect(plan.total).toBe(10000);
    expect(plan).not.toHaveProperty('segmentIds');
    expect(await db.prepare('SELECT count(*) n FROM visible_segments').get()).toMatchObject({
      n: 10000,
    });
    await insert.run('later', 'stripchat:1', 1000, 2000, 10001, 'media');
    // An independent successor must not be captured by a frozen unit selection,
    // even when its timestamp overlaps an earlier recording.
    await db.exec(`INSERT INTO recording_units VALUES('successor','stripchat:1',1000,2000,0,0);
      INSERT INTO unit_segments VALUES('later','successor');`);
    await db.exec('ANALYZE segments');
    const queryPlan = planNodes(
      await db
        .prepare(
          'EXPLAIN (FORMAT JSON) SELECT id FROM segments  WHERE subject=? AND created_revision>?',
        )
        .all('stripchat:1', 10000),
    );
    expect(queryPlan.some((node) => node['Index Name'] === 'segment_unit_append')).toBe(true);
    expect(
      queryPlan.some(
        (node) => node['Relation Name'] === 'segments' && node['Node Type'] === 'Seq Scan',
      ),
    ).toBe(false);
    expect((await store.accept('stripchat:1', id, 0))!.state).toBe('queued');
    expect((await store.accept('stripchat:1', id, 0))!.id).toBe(id);
    expect(await db.prepare('SELECT count(*) n FROM visible_segments').get()).toMatchObject({
      n: 1,
    });
    const batch = (await store.next())!;
    expect(batch.segmentIds).toHaveLength(128);
    await db
      .prepare(
        `UPDATE segments SET deleted=1 WHERE id IN (${batch.segmentIds.map(() => '?').join(',')})`,
      )
      .run(...batch.segmentIds);
    await store.advance(id, 128, 0);
    expect((await store.next())!.segmentIds).toHaveLength(128);
    const second = await store.begin('stripchat:1', [{ fromMs: 0, toMs: 10000000 }], 10001);
    while (await store.build(second)) {
      /* Bounded fixture plan. */
    }
    await db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<63)
      INSERT INTO media_deletions(id,subject,state,total,created,updated)
      SELECT 'queued-'||i,'stripchat:1','queued',0,0,0 FROM n;`);
    await expect((async () => await store.accept('stripchat:1', second, 0))()).rejects.toThrow(
      'MEDIA_DELETION_QUEUE_FULL',
    );
  } finally {
    await db.close();
  }
});
