import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { openTestDatabase } from './postgres.test-support.js';
import { RecordingUnits } from './recording-units.js';
import { initializeUnitVisibility } from './unit-visibility.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it('uses one unit visibility rule for every read and skips deleted source candidates', async () => {
  const db = await openTestDatabase();
  try {
    await db.exec(`CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,
      deleted BIGINT,json TEXT,created_revision BIGINT)`);
    const units = new RecordingUnits(db);
    await units.initialize();
    await db.exec(`INSERT INTO recording_units(id,subject,start,"end",sample,last_start,created_revision,closed,deleted)
      VALUES('live','s',0,60000,0,1,1,0,0),('retired','s',60000,120000,60000,60000,2,1,0),
      ('empty','s',120000,180000,120000,120000,3,1,0),('deleted','s',180000,240000,180000,180000,4,1,1);
      INSERT INTO segments VALUES
      ('first','s',0,1,1,'{"timeBasis":"source-pdt","uncertaintyMs":0}',1),
      ('survivor','s',1,60000,0,'{"timeBasis":"source-pdt","uncertaintyMs":1}',1),
      ('retired','s',60000,120000,0,'{}',2),('empty','s',120000,180000,1,'{}',3),
      ('deleted','s',180000,240000,0,'{}',4);
      INSERT INTO unit_segments VALUES('first','live'),('survivor','live'),('retired','retired'),('empty','empty'),('deleted','deleted')`);
    // The base installer works before deletion schema exists.
    expect((await units.list('s', { fromMs: 0, toMs: 240000 })).map((u) => u.id)).toEqual([
      'live',
      'retired',
    ]);
    await db.exec(
      "CREATE TABLE deletion_intent_units(unit TEXT,job TEXT);INSERT INTO deletion_intent_units VALUES('retired','pending')",
    );
    await initializeUnitVisibility(db, true);
    const window = { fromMs: 0, toMs: 240000 };
    expect((await units.page('s', window, [-1, ''])).map((u) => u.id)).toEqual(['live']);
    expect((await units.list('s', window)).map((u) => u.id)).toEqual(['live']);
    expect((await units.intersect('s', window)).map((u) => u.id)).toEqual(['live']);
    expect((await units.bounds('s', window)).map((u) => u.id)).toEqual(['live']);
    expect((await units.at('s', 1))?.id).toBe('live');
    expect(await units.at('s', 60000)).toBeUndefined();
    expect(await units.get('s', 'retired')).toBeUndefined();
    const live = (await units.get('s', 'live'))!;
    expect((await units.item(live)).uncertaintyMs).toBe(1);
    expect(
      (await units.items('s', ['retired', 'live', 'empty', 'deleted'])).map((item) => item.unitId),
    ).toEqual(['live']);
    await db.exec("INSERT INTO deletion_intent_units VALUES('live','pending')");
    await expect(units.item(live)).rejects.toThrow('MEDIA_SELECTION_STALE');
    expect(await units.items('s', ['live'])).toEqual([]);
  } finally {
    await db.close();
  }
});
