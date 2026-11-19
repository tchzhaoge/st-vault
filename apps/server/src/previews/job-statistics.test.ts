import { SqlDatabase } from '../database/sql.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { initializeJobStatistics, readJobStatistics } from './job-statistics.js';

async function assertExact(db: SqlDatabase): Promise<void> {
  const actual = await db
    .prepare(
      `SELECT
    COUNT(*) FILTER (WHERE state IN ('pending','running')) pending,
    COUNT(*) FILTER (WHERE state='failed') failed,
    COUNT(*) FILTER (WHERE state='done') completed,
    MIN(CASE WHEN state IN ('pending','running') THEN created END) "oldestCreated" FROM jobs`,
    )
    .get();
  expect(await readJobStatistics(db)).toEqual(actual);
}
async function fixture(): Promise<SqlDatabase> {
  const db = await SqlDatabase.open('/tmp/statistics-' + randomUUID());
  await db.exec(
    'CREATE TABLE jobs(id INTEGER PRIMARY KEY,state TEXT,created INTEGER,priority INTEGER DEFAULT 0)',
  );
  return db;
}

it('bootstraps existing jobs once and maintains exact counts for every state transition and retirement', async () => {
  const db = await fixture();
  try {
    await db.exec(
      "INSERT INTO jobs VALUES(1,'pending',10,0),(2,'running',20,0),(3,'failed',30,0),(4,'done',40,0)",
    );
    await initializeJobStatistics(db);
    await assertExact(db);
    for (const state of ['running', 'done', 'pending', 'failed', 'pending', 'pending']) {
      await db.prepare('UPDATE jobs SET state=? WHERE id=1').run(state);
      await assertExact(db);
    }
    await db.exec('UPDATE jobs SET created=5,priority=100 WHERE id=2');
    await assertExact(db);
    await db.exec(
      "INSERT INTO jobs VALUES(1,'done',50,0) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
    );
    await assertExact(db);
    await db.exec(
      "INSERT INTO jobs VALUES(2,'failed',60,0) ON CONFLICT(id) DO UPDATE SET state=excluded.state,created=excluded.created,priority=excluded.priority",
    );
    await assertExact(db);
    await db.exec('DELETE FROM jobs WHERE id IN (1,3)');
    await assertExact(db);
    const exec = vi.spyOn(db, 'exec');
    await initializeJobStatistics(db);
    expect(exec.mock.calls.some(([sql]) => /COUNT\(\*\)/i.test(sql))).toBe(false);
    exec.mockRestore();
    await assertExact(db);
  } finally {
    await db.close();
  }
});

it('rolls counts and oldest state back with failed or interrupted transactions', async () => {
  const db = await fixture();
  try {
    await initializeJobStatistics(db);
    await db.exec("INSERT INTO jobs VALUES(1,'pending',10,0)");
    const before = await readJobStatistics(db);
    await expect(
      db.transaction(async () => {
        await db.exec(
          "UPDATE jobs SET state='running';INSERT INTO jobs VALUES(2,'done',20,0);DELETE FROM jobs WHERE id=1",
        );
        await assertExact(db);
        throw Error('synthetic interruption');
      }),
    ).rejects.toThrow('synthetic interruption');
    expect(await readJobStatistics(db)).toEqual(before);
    await db.exec(
      "CREATE FUNCTION synthetic_count_failure() RETURNS trigger LANGUAGE plpgsql AS $body$BEGIN RAISE EXCEPTION 'synthetic count failure';END$body$;CREATE TRIGGER synthetic_count_failure BEFORE UPDATE ON job_statistics FOR EACH ROW WHEN (NEW.completed>OLD.completed) EXECUTE FUNCTION synthetic_count_failure()",
    );
    await expect(
      (async () => await db.exec("UPDATE jobs SET state='done' WHERE id=1"))(),
    ).rejects.toThrow('synthetic count failure');
    expect(await readJobStatistics(db)).toEqual(before);
    await assertExact(db);
    await db.exec(
      'DROP TRIGGER synthetic_count_failure ON job_statistics;DROP FUNCTION synthetic_count_failure();DELETE FROM jobs',
    );
    await assertExact(db);
  } finally {
    await db.close();
  }
});
