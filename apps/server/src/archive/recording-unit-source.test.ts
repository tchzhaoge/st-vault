import { openTestDatabase } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { expect, it } from 'vitest';
import { RecordingUnits } from './recording-units.js';
import { initializeUnitVisibility } from './unit-visibility.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it('validates ordered source candidates lazily without hiding a surviving source', async () => {
  const db = await openTestDatabase();
  await db.exec(`CREATE TABLE visibility_checks(id BIGINT PRIMARY KEY,n BIGINT);INSERT INTO visibility_checks VALUES(1,0);
    CREATE FUNCTION source_visible(candidate TEXT) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $body$
    BEGIN UPDATE visibility_checks SET n=n+1 WHERE id=1;RETURN candidate<>'hidden';END $body$`);
  await db.exec(
    "CREATE TABLE recording_units(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,\"end\" BIGINT,sample BIGINT,closed BIGINT,deleted BIGINT);\n    CREATE TABLE segments(id TEXT PRIMARY KEY,start BIGINT,deleted BIGINT,json TEXT);\n    CREATE TABLE unit_segments(segment TEXT PRIMARY KEY,unit TEXT);\n    CREATE INDEX unit_members ON unit_segments(unit,segment);\n    CREATE VIEW visible_segments AS SELECT * FROM segments WHERE source_visible(id);\n    INSERT INTO recording_units VALUES('unit','subject',0,60000,0,1,0);",
  );
  const units = new RecordingUnits(db, false);
  await units.initialize();
  await initializeUnitVisibility(db);
  try {
    for (let i = 0; i < 30; i++) {
      const id = i === 0 ? 'hidden' : `s${i}`;
      await db
        .prepare('INSERT INTO segments VALUES(?,?,?,?)')
        .run(id, i, i === 0 ? 1 : 0, JSON.stringify({ timeBasis: 'source-pdt', uncertaintyMs: i }));
      await db.prepare('INSERT INTO unit_segments VALUES(?,?)').run(id, 'unit');
    }
    expect((await units.items('subject', ['unit']))[0]?.uncertaintyMs).toBe(1);
    expect((await db.prepare('SELECT n FROM visibility_checks WHERE id=1').get())!.n).toBe(0);
    await db.exec('UPDATE visibility_checks SET n=0 WHERE id=1');
    expect(
      (
        await units.item({
          id: 'unit',
          subject: 'subject',
          start: 0,
          end: 60000,
          sample: 0,
          closed: 1,
          deleted: 0,
          last_start: 29,
          created_revision: 1,
        })
      ).uncertaintyMs,
    ).toBe(1);
    expect((await db.prepare('SELECT n FROM visibility_checks WHERE id=1').get())!.n).toBe(0);
  } finally {
    await db.close();
  }
});
