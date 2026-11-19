import { afterEach, expect, it, vi } from 'vitest';
import { Postgres } from './postgres.js';
const doubles = vi.hoisted(() => {
  const query = () =>
    vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: { result: number }[] }>>(() =>
      Promise.resolve({ rows: [{ result: 1 }] }),
    );
  const makeClient = () => ({
    query: query(),
    release: vi.fn(),
  });
  const makePool = (options: unknown) => {
    const client = makeClient();
    return {
      client,
      options,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      on: vi.fn(),
      end: vi.fn(() => Promise.resolve()),
      query: query(),
      connect: vi.fn(() => Promise.resolve(client)),
    };
  };
  const pools: ReturnType<typeof makePool>[] = [];
  return {
    pools,
    create: vi.fn((options: unknown) => {
      const pool = makePool(options);
      pools.push(pool);
      return pool;
    }),
  };
});
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      return doubles.create(options);
    }
  },
  types: { setTypeParser: vi.fn() },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  doubles.pools.length = 0;
});
it('bounds interactive read statements without limiting durable writes or background work', async () => {
  const db = new Postgres({ connection: {} });
  await db.transaction(
    async () => {
      await db.query('SELECT 1');
    },
    { readOnly: true },
  );
  expect(doubles.pools[0].client.query.mock.calls[0][0]).toContain("statement_timeout = '15s'");
  await db.transaction(() => Promise.resolve(), { lane: 'background', readOnly: true });
  expect(doubles.pools[1].client.query.mock.calls[0][0]).not.toContain('statement_timeout');
  await db.close();
});
it('reserves independent pools and binds nested queries to one transaction client', async () => {
  const db = new Postgres({ connection: { database: 'test' } });
  await db.transaction(
    async () => {
      await db.query('SELECT $1', [42]);
      await db.transaction(async () => {
        await db.query('SELECT 2');
      });
    },
    { lane: 'background' },
  );
  expect(doubles.pools[0].connect).not.toHaveBeenCalled();
  expect(doubles.pools[1].connect).toHaveBeenCalledOnce();
  const client = doubles.pools[1].client;
  expect(
    client.query.mock.calls.flatMap((call) => call[0].split(';').map((sql) => sql.trim())),
  ).toEqual([
    'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    "SET LOCAL lock_timeout = '3s'",
    "SET LOCAL idle_in_transaction_session_timeout = '30s'",
    'SELECT $1',
    'SELECT 2',
    'COMMIT',
  ]);
  expect(client.query.mock.calls).toHaveLength(4);
  expect(client.release).toHaveBeenCalledWith(false);
  await db.close();
});
it('uses an independent bounded pool for long-lived read snapshots', async () => {
  const db = new Postgres({ connection: {} });
  const client = await db.snapshot();
  expect(doubles.pools[0].connect).not.toHaveBeenCalled();
  expect(doubles.pools[1].connect).not.toHaveBeenCalled();
  expect(doubles.pools[2].connect).toHaveBeenCalledOnce();
  expect(client).toBe(doubles.pools[2].client);
  expect(doubles.pools[2].options).toMatchObject({ max: 4 });
  expect(doubles.pools[2].client.query).toHaveBeenCalledWith(
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  client.release();
  await db.close();
});
it('reserves execution capacity for playback, including single-statement reads', async () => {
  const db = new Postgres({ connection: {}, playbackConnections: 2, snapshotConnections: 3 });
  await db.inLane('playback', async () => {
    await db.query('SELECT 42');
    await db.transaction(
      async () => {
        await db.query('SELECT 43');
      },
      { readOnly: true },
    );
  });
  expect(doubles.pools[0].query).not.toHaveBeenCalled();
  expect(doubles.pools[0].connect).not.toHaveBeenCalled();
  const playback = doubles.pools.find(
    (pool) =>
      (pool.options as { application_name: string }).application_name === 'st-vault:playback',
  )!;
  expect(playback.options).toMatchObject({ max: 2 });
  expect(playback.client.query).toHaveBeenCalledWith('SELECT 42', []);
  expect(playback.connect).toHaveBeenCalledTimes(2);
  expect(playback.client.query).toHaveBeenCalledWith('SELECT 43', []);
  expect(doubles.pools[2].options).toMatchObject({ max: 3 });
  await db.close();
});
it('reports connection queue time separately and rate-limits each execution lane', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const report = vi.fn();
  const db = new Postgres({ connection: {}, report, interactiveConnections: 1 });
  const ordinary = doubles.pools[0];
  ordinary.connect.mockImplementation(() => {
    now += 150;
    return Promise.resolve(ordinary.client);
  });
  await db.query('SELECT 1');
  await db.query('SELECT 2');
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'database_pool_wait',
      lane: 'interactive',
      code: 'POOL_WAIT',
      waitMs: 150,
      capacity: 1,
    }),
  );
  await db.close();
});
it('keeps committed results and invalidates caches when an after-commit hook fails', async () => {
  const db = new Postgres({ connection: {} }),
    invalidate = vi.fn(),
    nextHook = vi.fn();
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db.onCommittedHookFailure(invalidate);
  const result = await db.transaction(() => {
    db.afterCommit(() => {
      throw Error('CACHE_FAILED');
    });
    db.afterCommit(nextHook);
    return Promise.resolve('committed');
  });
  expect(result).toBe('committed');
  expect(nextHook).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledOnce();
  expect(invalidate.mock.calls[0][0]).toBeInstanceOf(AggregateError);
  expect(report).toHaveBeenCalledWith(
    'database_after_commit_hook_failed',
    expect.any(AggregateError),
  );
  const sql = doubles.pools[0].client.query.mock.calls.map((call) => call[0]);
  expect(sql.at(-1)).toBe('COMMIT');
  expect(sql).not.toContain('ROLLBACK');
  await db.close();
});
it('rolls back once without retrying side effects', async () => {
  const db = new Postgres({ connection: {} });
  const action = vi.fn(() => Promise.reject(Error('TEST_FAILURE')));
  await expect(db.transaction(action)).rejects.toThrow('TEST_FAILURE');
  expect(action).toHaveBeenCalledOnce();
  const client = doubles.pools[0].client;
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  await db.close();
  await expect(db.query('SELECT 1')).rejects.toThrow('DATABASE_CLOSING');
});
it('rejects invalid connection budgets before allocating pools', () => {
  expect(() => new Postgres({ connection: {}, backgroundConnections: 0 })).toThrow(
    'INVALID_DATABASE_CONNECTION_BUDGET',
  );
  expect(doubles.create).not.toHaveBeenCalled();
});

it.each(['commit', 'rollback'])(
  'rejects escaped transaction resources after %s',
  async (outcome) => {
    const db = new Postgres({ connection: {} });
    let late!: Promise<{ inTransaction: boolean; results: PromiseSettledResult<unknown>[] }>;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = db.transaction(() => {
      late = new Promise((resolve) => {
        setTimeout(() => {
          void gate.then(async () => {
            const results = await Promise.allSettled([
              db.query('SELECT escaped'),
              db.transaction(() => Promise.resolve('nested')),
              db.snapshot(),
              Promise.resolve().then(() => db.afterCommit(() => undefined)),
            ]);
            resolve({ inTransaction: db.inTransaction, results });
          });
        }, 0);
      });
      if (outcome === 'rollback') throw Error('ROLLBACK_FIXTURE');
      return Promise.resolve();
    });
    if (outcome === 'rollback') await expect(work).rejects.toThrow('ROLLBACK_FIXTURE');
    else await work;
    release();
    try {
      const result = await late;
      expect(result.inTransaction).toBe(false);
      for (const operation of result.results) {
        expect(operation.status).toBe('rejected');
        if (operation.status === 'rejected')
          expect(operation.reason as unknown).toEqual(
            Error('DATABASE_TRANSACTION_CONTEXT_EXPIRED'),
          );
      }
      expect(doubles.pools[0].client.query.mock.calls.map((call) => call[0])).not.toContain(
        'SELECT escaped',
      );
      expect(doubles.pools[2].connect).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  },
);

it('detaches scheduled work from its parent transaction while preserving execution lane', async () => {
  const db = new Postgres({ connection: {} });
  let late!: Promise<unknown>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await db.inLane('background', () =>
    db.transaction(() => {
      late = db.detached(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              void gate.then(async () => {
                expect(db.inTransaction).toBe(false);
                resolve(await db.transaction(() => db.query('SELECT independent')));
              });
            }, 0);
          }),
      );
      return Promise.resolve();
    }),
  );
  release();
  try {
    await late;
    expect(doubles.pools[1].connect).toHaveBeenCalledTimes(2);
    expect(doubles.pools[0].connect).not.toHaveBeenCalled();
    expect(doubles.pools[1].client.release).toHaveBeenCalledTimes(2);
  } finally {
    await db.close();
  }
});

it('continues binding awaited parallel queries to the active transaction', async () => {
  const db = new Postgres({ connection: {} });
  try {
    await db.transaction(async () => {
      expect(db.inTransaction).toBe(true);
      await Promise.all([db.query('SELECT first'), db.query('SELECT second')]);
    });
    expect(doubles.pools[0].connect).toHaveBeenCalledTimes(1);
    expect(doubles.pools[0].client.release).toHaveBeenCalledTimes(1);
  } finally {
    await db.close();
  }
});
