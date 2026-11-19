import { openTestDatabase, planNodes } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { expect, it } from 'vitest';
import { hasMediaSql, liveObjectsSql, liveObjectsIndexSql } from './object-queries.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

async function fixture() {
  const db = await openTestDatabase();
  await db.exec(
    'CREATE TABLE objects(id TEXT PRIMARY KEY,deleted BIGINT,needs_verify BIGINT,kind TEXT);\n    CREATE INDEX object_verify ON objects(deleted,needs_verify,id);\n    CREATE TABLE segments(id TEXT PRIMARY KEY,deleted BIGINT,hidden BIGINT);\n    CREATE VIEW visible_segments AS SELECT * FROM segments WHERE hidden=0;\n    ',
  );
  await db.exec(
    `INSERT INTO objects SELECT lpad(n::text,8,'0'),0,0,'init' FROM generate_series(0,19999)n;ANALYZE objects`,
  );
  if (liveObjectsIndexSql) await db.exec(liveObjectsIndexSql);
  return db;
}
it('drives each media batch from requested IDs instead of scanning the live object population', async () => {
  const db = await fixture();
  try {
    for (const size of [2, 8, 32, 64, 600]) {
      const ids = Array.from({ length: size }, (_, i) => String(i).padStart(8, '0'));
      const plan = planNodes(
        await db.prepare('EXPLAIN (FORMAT JSON) ' + hasMediaSql).all(JSON.stringify(ids)),
      );
      expect(
        plan.some(
          (node) =>
            node['Relation Name'] === 'objects' &&
            node['Node Type'].includes('Index') &&
            node['Index Cond']?.includes('id ='),
        ),
      ).toBe(true);
      expect(plan.some((node) => node['Index Name'] === 'object_verify')).toBe(false);
      expect((await db.prepare(hasMediaSql).get(JSON.stringify(ids)))!.count).toBe(size);
    }
  } finally {
    await db.close();
  }
});
it('preserves missing, deleted, hidden, duplicate and init dependency semantics', async () => {
  const db = await fixture();
  try {
    await db.exec(`INSERT INTO objects VALUES('visible',0,0,'seg'),('hidden',0,0,'seg'),('deleted',1,0,'init'),('tombstone',0,0,'seg');
      INSERT INTO segments VALUES('visible',0,0),('hidden',0,1),('tombstone',1,0);`);
    const has = async (ids: string[]) =>
      (await db.prepare(hasMediaSql).get(JSON.stringify(ids)))!.count === ids.length;
    expect(await has([])).toBe(true);
    expect(await has(['visible', '00000000'])).toBe(true);
    for (const ids of [['missing'], ['hidden'], ['deleted'], ['tombstone'], ['visible', 'visible']])
      expect(await has(ids)).toBe(false);
  } finally {
    await db.close();
  }
});
it('pages live objects in ID order using an index that supplies the ordering', async () => {
  const db = await fixture();
  try {
    const plan = planNodes(await db.prepare('EXPLAIN (FORMAT JSON) ' + liveObjectsSql).all(''));
    // PostgreSQL may choose the primary-key index when this fixture is entirely
    // live. Both are valid ordered walks; reject a scan/sort, not a cheaper index.
    expect(
      plan.some(
        (node) => node['Relation Name'] === 'objects' && node['Node Type'].includes('Index'),
      ),
    ).toBe(true);
    expect(plan.some((node) => node['Node Type'] === 'Sort')).toBe(false);
    await db.exec("UPDATE objects SET deleted=1 WHERE id IN('00000000','00000128')");
    const first = await db.prepare(liveObjectsSql).all<{ id: string }>('');
    const second = await db.prepare(liveObjectsSql).all<{ id: string }>(first.at(-1)!.id);
    expect(first).toHaveLength(128);
    expect(second).toHaveLength(128);
    expect(first[0].id).toBe('00000001');
    expect(first.at(-1)!.id).toBe('00000129');
    expect(second[0].id).toBe('00000130');
  } finally {
    await db.close();
  }
});
