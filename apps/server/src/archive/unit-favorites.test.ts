import { openTestDatabase, planNodes } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { expect, it, vi } from 'vitest';
import type { Segment } from '@st-vault/api-schema';
import { RecordingUnits } from './recording-units.js';
import { PersonalStore } from './personal-store.js';
import { MediaSelectionStore } from './media-selection-store.js';
import { FavoriteCommands } from './favorite-commands.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

async function fixture(count: number) {
  const db = await openTestDatabase();
  await db.exec(
    'CREATE TABLE subjects(id TEXT PRIMARY KEY,deletion_revision BIGINT);INSERT INTO subjects VALUES(\'stripchat:1\',0);CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,deleted BIGINT DEFAULT 0,json TEXT,created_revision BIGINT);\n    CREATE TABLE deletion_items(job TEXT,segment TEXT);CREATE TABLE media_deletions(id TEXT,state TEXT);\n    CREATE VIEW visible_segments AS SELECT * FROM segments WHERE deleted=0;',
  );
  const personal = new PersonalStore(db),
    units = new RecordingUnits(db);
  await personal.initialize();
  await units.initialize();
  // Fixture construction is bulk SQL; the tests below exercise production unit operations.
  await db.transaction(async () => {
    await db
      .prepare(
        `INSERT INTO segments(id,subject,start,"end",json,created_revision)
      SELECT 'unit-'||n,'stripchat:1',n*60000,n*60000+2000,
      json_build_object('id','unit-'||n,'subjectId','stripchat:1','wallStartMs',n*60000,'wallEndMs',n*60000+2000)::text,n+1
      FROM generate_series(0,?::bigint-1)n`,
      )
      .run(count);
    await db
      .prepare(
        `INSERT INTO recording_units(id,subject,start,"end",sample,last_start,created_revision,closed,deleted)
      SELECT id,subject,start,"end",start,start,created_revision,CASE WHEN created_revision=? THEN 0 ELSE 1 END,0 FROM segments`,
      )
      .run(count);
    await db.exec(
      'INSERT INTO unit_segments SELECT id,id FROM segments;ANALYZE recording_units;ANALYZE segments;ANALYZE unit_segments',
    );
  });
  const selections = new MediaSelectionStore(db, () => Promise.resolve(count)),
    commands = new FavoriteCommands(db, selections);
  await selections.initialize();
  await commands.initialize();
  const favorite = async (
    subject: string,
    ids: string[],
    liked: boolean,
    revision: number,
  ): Promise<void> => {
    const id = await selections.begin(subject, { fromMs: 0, toMs: 1 }, 'explicit');
    for (let offset = 0; offset < ids.length; offset += 256)
      await selections.patch(
        subject,
        id,
        { includeUnitIds: ids.slice(offset, offset + 256) },
        false,
      );
    while (await selections.build(subject, id)) {}
    await commands.accept(subject, id, liked, revision);
  };
  return {
    db,
    personal,
    units,
    favorite,
    ids: Array.from({ length: count }, (_, index) => `unit-${index}`),
  };
}
it('updates every selected unit beyond the old 2000 read cap with one revision and no partial favorites', async () => {
  const { db, personal, favorite, ids } = await fixture(2501);
  try {
    await favorite('stripchat:1', ids, true, 0);
    expect(await personal.revision()).toBe(1);
    expect((await personal.read('stripchat:1', 0, 2501 * 60000)).favorites).toHaveLength(2501);
    expect((await personal.read('stripchat:1', 0, 2501 * 60000)).truncated).toBe(false);
    await expect((async () => await favorite('stripchat:1', ids, false, 0))()).rejects.toThrow(
      'PERSONAL_REVISION_STALE',
    );
    expect((await personal.readUnits('stripchat:1', ids)).favorites).toHaveLength(2501);
    await favorite('stripchat:1', ids, false, 1);
    expect(await personal.revision()).toBe(2);
    expect((await personal.readUnits('stripchat:1', ids)).favorites).toEqual([]);
  } finally {
    await db.close();
  }
});
it('rolls back unit protection if revision persistence fails', async () => {
  const { db, personal, favorite, ids } = await fixture(2);
  try {
    await favorite('stripchat:1', ids, true, 0);
    await db.exec(
      "CREATE FUNCTION fail_revision() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'INJECTED';END $body$;\n      CREATE TRIGGER fail_revision BEFORE UPDATE ON personal_owner FOR EACH ROW EXECUTE FUNCTION fail_revision()",
    );
    await expect(
      db.transaction(async () => await favorite('stripchat:1', ids, false, 1)),
    ).rejects.toThrow('INJECTED');

    expect((await personal.readUnits('stripchat:1', ids)).favorites).toHaveLength(2);
    expect(await personal.revision()).toBe(1);
  } finally {
    await db.close();
  }
});
it('uses bounded history windows and indexed unit membership', async () => {
  const { db, units } = await fixture(10000);
  try {
    const range = { fromMs: 9990 * 60000, toMs: 10000 * 60000 };
    expect(await units.list('stripchat:1', range)).toHaveLength(10);
    const plan = planNodes(
      await db
        .prepare(
          'EXPLAIN (FORMAT JSON) SELECT * FROM recording_units WHERE subject=? AND start>? AND start<? AND "end">?',
        )
        .all('stripchat:1', range.fromMs - 86460000, range.toMs, range.fromMs),
    );
    // With current statistics PostgreSQL can prefer the more selective end
    // index. Require a bounded unit index condition, not SQLite's index choice.
    expect(
      plan.some(
        (node) =>
          node['Relation Name'] === 'recording_units' &&
          node['Node Type'].includes('Index') &&
          /start|end/.test(node['Index Cond'] ?? ''),
      ),
    ).toBe(true);
    expect(
      plan.some(
        (node) => node['Relation Name'] === 'recording_units' && node['Node Type'] === 'Seq Scan',
      ),
    ).toBe(false);
  } finally {
    await db.close();
  }
});
it('rejects protection for an unknown recording unit without leaving partial favorite data', async () => {
  const { db } = await fixture(2);
  try {
    await expect(
      db.prepare('INSERT INTO unit_favorites VALUES(?,?)').run('missing-unit', 0),
    ).rejects.toMatchObject({ code: '23503' });
    expect((await db.prepare('SELECT count(*) AS count FROM unit_favorites').get())!.count).toBe(0);
  } finally {
    await db.close();
  }
});
it('checkpoints historical membership in bounded batches and resumes without regrouping completed units', async () => {
  const { db, units } = await fixture(385);
  try {
    await db.exec(
      "DELETE FROM unit_segments;DELETE FROM recording_units;UPDATE unit_index SET revision=-1,segment='',ready=0",
    );
    expect(await units.build()).toBe(true);
    expect((await db.prepare('SELECT count(*) n FROM unit_segments').get())!.n).toBe(128);
    const resumed = new RecordingUnits(db);
    await resumed.initialize();
    expect(await resumed.build()).toBe(true);
    expect(await resumed.build()).toBe(true);
    expect(await resumed.build()).toBe(false);
    expect(await resumed.ready()).toBe(true);
    expect((await db.prepare('SELECT count(*) n FROM unit_segments').get())!.n).toBe(385);
    expect(
      await db.prepare('SELECT unit FROM unit_segments WHERE segment=?').get('unit-0'),
    ).toEqual({
      unit: 'unit-0',
    });
  } finally {
    await db.close();
  }
});

it('finds only the outer units with real media intersection and rejects internal gaps', async () => {
  const { db, units } = await fixture(0);
  const insert = db.prepare(
    'INSERT INTO segments(id,subject,start,"end",json,created_revision) VALUES(?,?,?,?,?,?)',
  );
  const append = async (
    id: string,
    start: number,
    end: number,
    revision: number,
  ): Promise<void> => {
    const segment = {
      id,
      subjectId: 'stripchat:1',
      wallStartMs: start,
      wallEndMs: end,
    } as Segment;
    await insert.run(id, segment.subjectId, start, end, JSON.stringify(segment), revision);
    await units.append(segment, revision);
  };
  try {
    await append('crossing', 58000, 62000, 1);
    await append('next', 62000, 64000, 2);
    await append('after-gap', 70000, 72000, 3);
    expect(await units.bounds('stripchat:1', { fromMs: 65000, toMs: 66000 })).toEqual([]);
    expect(await units.bounds('stripchat:1', { fromMs: 0, toMs: 58000 })).toEqual([]);
    expect(await units.bounds('stripchat:1', { fromMs: 72000, toMs: 90000 })).toEqual([]);
    expect(
      (await units.bounds('stripchat:1', { fromMs: 60000, toMs: 63000 })).map((unit) => [
        unit.id,
        unit.start,
        unit.end,
      ]),
    ).toEqual([
      ['crossing', 58000, 62000],
      ['next', 62000, 72000],
    ]);
    expect(
      (await units.bounds('stripchat:1', { fromMs: 62500, toMs: 63500 })).map((unit) => unit.id),
    ).toEqual(['next']);
    await db.prepare('UPDATE segments SET deleted=1 WHERE id=?').run('crossing');
    expect(await units.bounds('stripchat:1', { fromMs: 58000, toMs: 62000 })).toEqual([]);
    expect(await units.bounds('stripchat:other', { fromMs: 0, toMs: 90000 })).toEqual([]);
  } finally {
    await db.close();
  }
});

it('retains the full lookback for a maximum-duration fragment in a partial-minute unit', async () => {
  const { db, units } = await fixture(1);
  try {
    const segment = {
      id: 'long',
      subjectId: 'stripchat:1',
      wallStartMs: 58000,
      wallEndMs: 86458000,
    } as Segment;
    await db
      .prepare(
        'INSERT INTO segments(id,subject,start,"end",json,created_revision) VALUES(?,?,?,?,?,?)',
      )
      .run(
        segment.id,
        segment.subjectId,
        segment.wallStartMs,
        segment.wallEndMs,
        JSON.stringify(segment),
        2,
      );
    await units.append(segment, 2);
    expect(
      (await units.bounds('stripchat:1', { fromMs: 86457000, toMs: 86458000 })).map((unit) => [
        unit.start,
        unit.end,
      ]),
    ).toEqual([[0, 86458000]]);
  } finally {
    await db.close();
  }
});

it('uses the latest media end rather than the last unit start for overlapping long fragments', async () => {
  const { db, units } = await fixture(0);
  try {
    const insert = db.prepare(
      'INSERT INTO segments(id,subject,start,"end",json,created_revision) VALUES(?,?,?,?,?,?)',
    );
    for (const [index, [start, end]] of [
      [0, 121000],
      [61000, 63000],
    ].entries()) {
      const segment = {
        id: `overlap-${index}`,
        subjectId: 'stripchat:1',
        wallStartMs: start,
        wallEndMs: end,
      } as Segment;
      await insert.run(
        segment.id,
        segment.subjectId,
        start,
        end,
        JSON.stringify(segment),
        index + 1,
      );
      await units.append(segment, index + 1);
    }
    const result = await units.bounds('stripchat:1', { fromMs: 1000, toMs: 62000 });
    expect(result.map((unit) => [unit.id, unit.start, unit.end])).toEqual([
      ['overlap-0', 0, 121000],
    ]);
  } finally {
    await db.close();
  }
});

it('resolves a week of large history with two indexed limit-one queries', async () => {
  const { db, units } = await fixture(10000);
  try {
    const prepare = vi.spyOn(db, 'prepare');
    const window = { fromMs: 0, toMs: 7 * 86400000 };
    const bounds = await units.bounds('stripchat:1', window);
    const sql = prepare.mock.calls
      .map(([statement]) => statement)
      .filter((statement) => statement.startsWith('SELECT u.*'));
    prepare.mockRestore();
    expect(bounds.map((unit) => unit.id)).toEqual(['unit-0', 'unit-9999']);
    expect(sql).toHaveLength(2);
    for (const [index, statement] of sql.entries()) {
      expect(statement).toContain('LIMIT 1');
      const plan = planNodes(
        await db
          .prepare(`EXPLAIN (FORMAT JSON) ${statement}`)
          .all(
            'stripchat:1',
            -1,
            window.toMs,
            window.fromMs,
            window.toMs + 86460000,
            window.toMs,
            window.fromMs,
          ),
      );
      expect(
        plan.some((node) => node['Index Name'] === (index === 0 ? 'unit_window' : 'unit_finish')),
      ).toBe(true);
      expect(plan.some((node) => node['Index Name'] === 'unit_members')).toBe(true);
      expect(plan.some((node) => node.Alias === 'u' && node['Node Type'] === 'Seq Scan')).toBe(
        false,
      );
      expect(plan.some((node) => node['Node Type'] === 'Sort')).toBe(false);
    }
  } finally {
    await db.close();
  }
});
it('admits a smaller index batch while preserving the durable source checkpoint', async () => {
  const { db, units } = await fixture(257);
  try {
    await db.exec(
      "DELETE FROM unit_segments;DELETE FROM recording_units;UPDATE unit_index SET revision=-1,segment='',ready=0",
    );
    expect(await units.build(32)).toBe(true);
    expect((await db.prepare('SELECT count(*) n FROM unit_segments').get())!.n).toBe(32);
    expect(await db.prepare('SELECT revision FROM unit_index').get()).toEqual({ revision: 32 });
    while (await units.build(32)) {
      /* Smaller batches yield between durable checkpoints. */
    }
    expect((await db.prepare('SELECT count(*) n FROM unit_segments').get())!.n).toBe(257);
  } finally {
    await db.close();
  }
});
