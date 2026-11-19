import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { EmbeddedPostgres } from './embedded.js';
import { Postgres } from './postgres.js';
import { PortableTransactions } from './portable-transactions.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { importSqlite } from './import-sqlite.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
describe.skipIf(process.env.STV_TEST_POSTGRES !== '1')('embedded PostgreSQL contracts', () => {
  async function fixture(
    budgets: Omit<ConstructorParameters<typeof Postgres>[0], 'connection'> = {},
  ) {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-pg-contract-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let server = await EmbeddedPostgres.open({
      root,
      binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    });
    cleanup.push(() => server.close());
    let db = new Postgres({ connection: server.connection, ...budgets });
    cleanup.push(() => db.close());
    return {
      root,
      get db() {
        return db;
      },
      get server() {
        return server;
      },
      async restart() {
        await db.close();
        await server.close();
        server = await EmbeddedPostgres.open({
          root,
          binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
        });
        db = new Postgres({ connection: server.connection, ...budgets });
      },
    };
  }
  it('cancels an overlong interactive read and returns a clean reusable connection', async () => {
    const f = await fixture({ interactiveConnections: 1 });
    await expect(
      f.db.transaction(
        async () => {
          await f.db.query('SELECT pg_sleep(20)');
        },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: '57014' });
    expect(await f.db.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '0' }]);
    expect(await f.db.query('SELECT 1 AS value')).toEqual([{ value: 1 }]);
  }, 30000);
  it('durable admission retains a writer while ordinary and background pools are saturated', async () => {
    const f = await fixture({
      interactiveConnections: 1,
      backgroundConnections: 1,
      writerConnections: 1,
    });
    await f.db.query('CREATE TABLE writer_contract(id TEXT PRIMARY KEY)');
    const journal = await PortableTransactions.open(f.db, {
      mediaRoot: path.join(f.root, 'media'),
      libraryId: randomUUID(),
      tables: ['writer_contract'],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const blockers = (['interactive', 'background'] as const).map((lane) =>
      f.db.transaction(
        async () => {
          entered++;
          await gate;
        },
        { lane },
      ),
    );
    try {
      await vi.waitFor(() => expect(entered).toBe(2));
      let committed = false;
      const command = journal
        .transaction(async () => {
          await f.db.query("INSERT INTO writer_contract VALUES('accepted')");
        })
        .then(() => {
          committed = true;
        });
      await vi.waitFor(() => expect(committed).toBe(true));
      await command;
      expect(f.db.stats().writer.total).toBe(1);
    } finally {
      release();
      await Promise.all(blockers);
      await journal.close();
    }
    expect(await f.db.query('SELECT id FROM writer_contract')).toEqual([{ id: 'accepted' }]);
  }, 30000);
  it('playback completes while ordinary execution and its waiting queue are saturated', async () => {
    const f = await fixture({
      interactiveConnections: 1,
      backgroundConnections: 1,
      playbackConnections: 1,
      snapshotConnections: 1,
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ordinary = f.db.transaction(
      async () => {
        await f.db.query('SELECT 1');
        entered();
        await gate;
      },
      { readOnly: true },
    );
    await ready;
    const queued = f.db.query('SELECT 2 AS value');
    try {
      await vi.waitFor(() => expect(f.db.stats().interactive.waiting).toBe(1));
      expect(await f.db.inLane('playback', () => f.db.query('SELECT 3 AS value'))).toEqual([
        { value: 3 },
      ]);
      expect(f.db.stats().interactive.waiting).toBe(1);
    } finally {
      release();
      await ordinary;
      await queued;
    }
  }, 30000);
  it('imports a frozen SQLite backup in bounded batches and resumes after interruption', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'source.sqlite');
    const input = new DatabaseSync(source);
    input.exec(
      'CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL);BEGIN',
    );
    for (let index = 0; index < 301; index++)
      input.prepare('INSERT INTO items(value) VALUES(?)').run(`row-${index}`);
    input.exec('COMMIT');
    input.close();
    let interrupted = false;
    await expect(
      importSqlite({
        db: f.db,
        source,
        schema: 'import_contract',
        progress: (progress) => {
          if (!interrupted && !progress.completed) {
            interrupted = true;
            throw Error('SIMULATED_IMPORT_INTERRUPTION');
          }
        },
      }),
    ).rejects.toThrow('SIMULATED_IMPORT_INTERRUPTION');
    expect(await f.db.query('SELECT count(*) FROM import_contract.items')).toEqual([
      { count: 128 },
    ]);
    expect(await importSqlite({ db: f.db, source, schema: 'import_contract' })).toMatchObject({
      tables: 1,
      rows: 301,
    });
    expect(await f.db.query('SELECT value FROM import_contract.items WHERE id=301')).toEqual([
      { value: 'row-300' },
    ]);
    expect(
      await f.db.query("INSERT INTO import_contract.items(value) VALUES('next') RETURNING id"),
    ).toEqual([{ id: 302 }]);
  }, 30000);
  it('persists across restart with an unprivileged role and no TCP listener', async () => {
    const f = await fixture();
    await f.db.query('CREATE TABLE sample(id BIGINT PRIMARY KEY, value TEXT NOT NULL)');
    await f.db.query('INSERT INTO sample VALUES($1,$2)', [Number.MAX_SAFE_INTEGER, 'preserved']);
    const settings = await f.db.query<{ listen_addresses: string }>('SHOW listen_addresses');
    expect(settings[0].listen_addresses).toBe('');
    const role = await f.db.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    expect(role).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }]);
    const rejected = new Client({ ...f.server.connection, password: 'incorrect' });
    await expect(rejected.connect()).rejects.toMatchObject({ code: '28P01' });
    await rejected.end();
    await f.restart();
    expect(await f.db.query('SELECT * FROM sample')).toEqual([
      { id: Number.MAX_SAFE_INTEGER, value: 'preserved' },
    ]);
    await expect(f.db.query('SELECT 9007199254740992::bigint AS unsafe')).rejects.toThrow(
      'DATABASE_INTEGER_OUT_OF_RANGE',
    );
  }, 30000);
  it('interactive reads proceed while a background transaction owns an uncommitted update', async () => {
    const f = await fixture();
    await f.db.query('CREATE TABLE example(id BIGINT PRIMARY KEY,value BIGINT NOT NULL)');
    await f.db.query('INSERT INTO example VALUES(1,1)');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = f.db.transaction(
      async () => {
        await f.db.query('UPDATE example SET value=2 WHERE id=1');
        entered();
        await gate;
      },
      { lane: 'background' },
    );
    try {
      await ready;
      expect(await f.db.query('SELECT value FROM example WHERE id=1')).toEqual([{ value: 1 }]);
      expect(f.db.stats().background.total).toBe(1);
    } finally {
      release();
      await writer;
    }
    expect(await f.db.query('SELECT value FROM example WHERE id=1')).toEqual([{ value: 2 }]);
    await expect(
      f.db.transaction(async () => {
        await f.db.query('UPDATE example SET value=3');
        throw Error('ROLLBACK_TEST');
      }),
    ).rejects.toThrow('ROLLBACK_TEST');
    expect(await f.db.query('SELECT value FROM example')).toEqual([{ value: 2 }]);
    await expect(
      f.db.transaction(async () => {
        await f.db.query('UPDATE example SET value=4');
        await f.db.query('SELECT 1/0').catch((error: unknown) => {
          expect(error).toMatchObject({ code: '22012' });
        });
      }),
    ).rejects.toThrow('DATABASE_TRANSACTION_ABORTED');
    expect(await f.db.query('SELECT value FROM example')).toEqual([{ value: 2 }]);
  }, 30000);
  it('recovers a portable commit after losing its PostgreSQL transaction and hot tables', async () => {
    const f = await fixture();
    const media = path.join(f.root, 'media');
    const libraryId = randomUUID();
    await f.db.query('CREATE TABLE portable_test(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    let fail = true;
    let journal = await PortableTransactions.open(f.db, {
      mediaRoot: media,
      libraryId,
      tables: ['portable_test'],
      fault: (point) => {
        if (fail && point === 'after-portable-sync') {
          fail = false;
          throw Error('SIMULATED_CRASH');
        }
      },
    });
    await expect(
      journal.transaction(async () => {
        await f.db.query('INSERT INTO portable_test VALUES($1,$2)', ['a', 'durable']);
      }),
    ).rejects.toThrow('SIMULATED_CRASH');
    expect(await f.db.query('SELECT * FROM portable_test')).toEqual([]);
    await expect(journal.transaction(() => Promise.resolve())).rejects.toThrow(
      'PORTABLE_LIBRARY_REQUIRES_RECOVERY',
    );
    await journal.close();
    journal = await PortableTransactions.open(f.db, {
      mediaRoot: media,
      libraryId,
      tables: ['portable_test'],
    });
    expect(await f.db.query('SELECT * FROM portable_test')).toEqual([
      { id: 'a', value: 'durable' },
    ]);
    await expect(f.db.query("UPDATE portable_test SET value='unlogged'")).rejects.toThrow(
      'PORTABLE_WRITE_REQUIRES_TRANSACTION',
    );
    await journal.transaction(async () => {
      await f.db.query("UPDATE portable_test SET value='changed' WHERE id='a'");
    });
    await journal.close();
    await f.db.query('DROP TABLE portable_test;DROP TABLE stv_library_state');
    await f.db.query('CREATE TABLE portable_test(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    journal = await PortableTransactions.open(f.db, {
      mediaRoot: media,
      libraryId,
      tables: ['portable_test'],
    });
    try {
      expect(await f.db.query('SELECT * FROM portable_test')).toEqual([
        { id: 'a', value: 'changed' },
      ]);
      expect(await f.db.query('SELECT sequence FROM stv_library_state')).toEqual([{ sequence: 2 }]);
    } finally {
      await journal.close();
    }
  }, 30000);
  it('relaxes only the journal-backed projection commit after media sync and recovers acknowledged rows', async () => {
    const f = await fixture();
    await f.db.query('CREATE TABLE portable_test(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const mediaRoot = path.join(f.root, 'media'),
      libraryId = randomUUID();
    const queries = vi.spyOn(f.db, 'query');
    let synced = 0,
      acknowledged = 0;
    let journal = await PortableTransactions.open(f.db, {
      mediaRoot,
      libraryId,
      tables: ['portable_test'],
      publishCheckpoint: () => undefined,
      fault: async (point) => {
        if (point !== 'after-portable-sync') return;
        synced++;
        expect(await f.db.query('SHOW synchronous_commit')).toEqual([{ synchronous_commit: 'on' }]);
        expect(queries.mock.calls.some(([sql]) => sql === 'SET LOCAL synchronous_commit=off')).toBe(
          false,
        );
      },
    });
    try {
      queries.mockClear();
      await journal.transaction(async () => {
        await f.db.query("INSERT INTO portable_test VALUES('a','acknowledged')");
        f.db.afterCommit(() => {
          acknowledged++;
        });
      });
      expect(synced).toBe(1);
      expect(acknowledged).toBe(1);
      expect(queries).toHaveBeenCalledWith('SET LOCAL synchronous_commit=off');
      expect(await f.db.query('SHOW synchronous_commit')).toEqual([{ synchronous_commit: 'on' }]);
      expect(await f.db.query('SHOW fsync')).toEqual([{ fsync: 'on' }]);
      expect(await f.db.query('SHOW full_page_writes')).toEqual([{ full_page_writes: 'on' }]);
      queries.mockClear();
      await journal.checkpoint();
      expect(queries.mock.calls.some(([sql]) => sql === 'SET LOCAL synchronous_commit=off')).toBe(
        false,
      );
    } finally {
      await journal.close();
    }
    // Losing the entire hot projection is stronger than losing a recent WAL suffix.
    await f.db.query('DROP TABLE portable_test;DROP TABLE stv_library_state');
    await f.db.query('CREATE TABLE portable_test(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    queries.mockClear();
    journal = await PortableTransactions.open(f.db, {
      mediaRoot,
      libraryId,
      tables: ['portable_test'],
    });
    try {
      expect(await f.db.query('SELECT * FROM portable_test')).toEqual([
        { id: 'a', value: 'acknowledged' },
      ]);
      expect(await f.db.query('SELECT sequence FROM stv_library_state')).toEqual([{ sequence: 1 }]);
      expect(queries.mock.calls.some(([sql]) => sql === 'SET LOCAL synchronous_commit=off')).toBe(
        false,
      );
      // Private settings and screenshot jobs use ordinary transactions, never this journal path.
      for (let owner = 0; owner < 2; owner++) {
        const independent = new Postgres({ connection: f.server.connection });
        try {
          await independent.transaction(async () => {
            expect(await independent.query('SHOW synchronous_commit')).toEqual([
              { synchronous_commit: 'on' },
            ]);
          });
        } finally {
          await independent.close();
        }
      }
    } finally {
      await journal.close();
      queries.mockRestore();
    }
  }, 30000);
});
