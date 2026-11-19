import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { SqlDatabase } from '../database/sql.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { attachWorkerRpc } from './worker-rpc.js';
import { metadataMutations, metadataBackgroundMutations } from '../archive/metadata-policy.js';
let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it('shares one durable barrier and isolates a rejected command with a savepoint', async () => {
  const db = await SqlDatabase.open('/tmp/worker-rpc-' + randomUUID());
  await db.exec('CREATE TABLE facts(id BIGINT PRIMARY KEY,value TEXT)');
  const replies: { id: number; value?: unknown; error?: string }[] = [];
  const barrier = vi.fn((action: () => Promise<void>) => db.transaction(action));
  const port = Object.assign(new EventEmitter(), {
    postMessage: (value: (typeof replies)[number]) => replies.push(value),
    close: vi.fn(),
  });
  attachWorkerRpc({
    port,
    mutations: new Set(['write']),
    transaction: barrier,
    savepoint: (sql) => db.exec(sql),
    afterBatch: vi.fn(),
    handlers: {
      write: async (value) => {
        const id = Number(value);
        await db.prepare('INSERT INTO facts VALUES(?,?)').run(id, 'accepted');
        if (id === 2) throw Error('INVALID_INPUT');
        return id;
      },
      read: () => db.prepare('SELECT id FROM facts ORDER BY id').all(),
      close: () => db.close(),
    },
  });
  try {
    for (const id of [1, 2, 3]) port.emit('message', { id, method: 'write', input: id });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(barrier).toHaveBeenCalledTimes(1);
    expect(replies[1]).toMatchObject({ error: 'INVALID_INPUT' });
    // Reads have their own lane. Ask for the committed state after the write acknowledgement.
    port.emit('message', { id: 4, method: 'read' });
    await vi.waitFor(() => expect(replies).toHaveLength(4));
    expect(replies[3].value).toEqual([{ id: 1 }, { id: 3 }]);
    port.emit('message', { id: 5, method: 'close' });
    await vi.waitFor(() => expect(port.close).toHaveBeenCalledTimes(1));
  } finally {
    await db.close();
  }
});

it('discards commit notifications for a rejected command without losing accepted notifications', async () => {
  const db = await SqlDatabase.open('/tmp/worker-rpc-hooks-' + randomUUID());
  await db.exec('CREATE TABLE facts(id BIGINT PRIMARY KEY)');
  const effects: number[] = [];
  const replies: { id: number; error?: string }[] = [];
  const port = Object.assign(new EventEmitter(), {
    postMessage: (value: (typeof replies)[number]) => replies.push(value),
    close: vi.fn(),
  });
  attachWorkerRpc({
    port,
    mutations: new Set(['write']),
    transaction: (action) => db.transaction(action),
    savepoint: (sql) => db.exec(sql),
    commitHookPosition: () => db.postgres.commitHookPosition(),
    rollbackCommitHooks: (position) => db.postgres.rollbackCommitHooks(position),
    afterBatch: vi.fn(),
    handlers: {
      write: async (value) => {
        const id = Number(value);
        await db.prepare('INSERT INTO facts VALUES(?)').run(id);
        db.afterCommit(() => {
          effects.push(id);
        });
        if (id === 2) throw Error('INVALID_INPUT');
        return id;
      },
    },
  });
  try {
    for (const id of [1, 2, 3]) port.emit('message', { id, method: 'write', input: id });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[1]).toMatchObject({ error: 'INVALID_INPUT' });
    expect(await db.prepare('SELECT id FROM facts ORDER BY id').all()).toEqual([
      { id: 1 },
      { id: 3 },
    ]);
    expect(effects).toEqual([1, 3]);
  } finally {
    await db.close();
  }
});

it('never acknowledges individual writes if the shared durable barrier fails', async () => {
  const replies: { error?: string }[] = [];
  const port = Object.assign(new EventEmitter(), {
    postMessage: (value: (typeof replies)[number]) => replies.push(value),
    close: vi.fn(),
  });
  attachWorkerRpc({
    port,
    mutations: new Set(['write']),
    transaction: () => Promise.reject(Error('LIBRARY_REQUIRES_RECOVERY')),
    savepoint: () => Promise.resolve(),
    afterBatch: vi.fn(),
    handlers: { write: () => true },
  });
  for (let id = 0; id < 20; id++) port.emit('message', { id, method: 'write' });
  await vi.waitFor(() => expect(replies).toHaveLength(20));
  expect(replies.every((reply) => reply.error === 'LIBRARY_REQUIRES_RECOVERY')).toBe(true);
});

it('separates handler cost from a shared durability barrier', async () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const replies: { handlerMs?: number; barrierMs?: number; executionMs: number }[] = [];
  const port = Object.assign(new EventEmitter(), {
    postMessage: (value: (typeof replies)[number]) => replies.push(value),
    close: vi.fn(),
  });
  try {
    attachWorkerRpc({
      port,
      mutations: new Set(['write']),
      savepoint: () => Promise.resolve(),
      afterBatch: vi.fn(),
      transaction: async (action) => {
        await action();
        now += 200;
      },
      handlers: {
        write: (value) => {
          now += Number(value);
          return true;
        },
      },
    });
    port.emit('message', { id: 1, method: 'write', input: 20 });
    port.emit('message', { id: 2, method: 'write', input: 1 });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies).toEqual([
      {
        id: 1,
        value: true,
        handlerMs: 20,
        barrierMs: 200,
        executionMs: 221,
        slowestMethod: 'write',
        slowestHandlerMs: 20,
      },
      {
        id: 2,
        value: true,
        handlerMs: 1,
        barrierMs: 200,
        executionMs: 221,
        slowestMethod: 'write',
        slowestHandlerMs: 20,
      },
    ]);
  } finally {
    clock.mockRestore();
  }
});

it('keeps interactive reads responsive while a durable write is waiting', async () => {
  const replies: { id: number; value?: unknown }[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const port = Object.assign(new EventEmitter(), {
    postMessage: (value: (typeof replies)[number]) => replies.push(value),
    close: vi.fn(),
  });
  attachWorkerRpc({
    port,
    mutations: new Set(['write']),
    savepoint: () => Promise.resolve(),
    afterBatch: vi.fn(),
    transaction: (action) => action(),
    handlers: {
      write: async () => {
        entered();
        await gate;
        return 'committed';
      },
      read: () => 'visible',
    },
  });
  port.emit('message', { id: 1, method: 'write' });
  try {
    await ready;
    port.emit('message', { id: 2, method: 'read' });
    await vi.waitFor(() =>
      expect(replies).toEqual([expect.objectContaining({ id: 2, value: 'visible' })]),
    );
  } finally {
    release();
  }
  await vi.waitFor(() => expect(replies).toHaveLength(2));
});

it('never puts a same-tick read ahead of a write inside the durable transaction', async () => {
  const replies: { id: number; value?: unknown }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inWrite = false;
  const readContexts: boolean[] = [];
  const port = Object.assign(new EventEmitter(), {
    postMessage: (reply: (typeof replies)[number]) => replies.push(reply),
    close: vi.fn(),
  });
  attachWorkerRpc({
    port,
    mutations: new Set(['write']),
    savepoint: () => Promise.resolve(),
    afterBatch: vi.fn(),
    transaction: async (action) => {
      inWrite = true;
      try {
        await action();
      } finally {
        inWrite = false;
      }
    },
    handlers: {
      read: async () => {
        readContexts.push(inWrite);
        await gate;
        return 'read';
      },
      write: () => 'committed',
    },
  });
  port.emit('message', { id: 1, method: 'read' });
  port.emit('message', { id: 2, method: 'write' });
  try {
    await vi.waitFor(() =>
      expect(replies).toContainEqual(expect.objectContaining({ id: 2, value: 'committed' })),
    );
    expect(readContexts).toEqual([false]);
  } finally {
    release();
  }
  await vi.waitFor(() => expect(replies).toHaveLength(2));
});
it('admits a user command between bounded background steps without starving maintenance', async () => {
  const replies: { id: number }[] = [];
  const order: string[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const port = Object.assign(new EventEmitter(), {
    postMessage: (reply: { id: number }) => replies.push(reply),
    close: vi.fn(),
  });
  attachWorkerRpc({
    port,
    mutations: new Set(['maintenance', 'command']),
    backgroundMutations: new Set(['maintenance']),
    transaction: (action) => action(),
    savepoint: () => Promise.resolve(),
    afterBatch: vi.fn(),
    handlers: {
      maintenance: async (input: { first?: boolean }) => {
        order.push('maintenance');
        if (input.first) {
          entered();
          await gate;
        }
        return true;
      },
      command: () => {
        order.push('command');
        return true;
      },
      close: () => true,
    },
  });
  port.emit('message', { id: 1, method: 'maintenance', input: { first: true } });
  await ready;
  for (let id = 2; id <= 9; id++) port.emit('message', { id, method: 'maintenance', input: {} });
  port.emit('message', { id: 10, method: 'command' });
  port.emit('message', { id: 11, method: 'close' });
  release();
  await vi.waitFor(() => expect(replies).toHaveLength(11));
  expect(order.slice(0, 2)).toEqual(['maintenance', 'command']);
  expect(replies.at(-1)?.id).toBe(11);
});

it('keeps historical unit indexing out of the recording commit barrier', async () => {
  const replies: { id: number }[] = [];
  const batches: string[][] = [];
  const port = Object.assign(new EventEmitter(), {
    postMessage: (reply: { id: number }) => replies.push(reply),
    close: vi.fn(),
  });
  attachWorkerRpc({
    port,
    mutations: metadataMutations,
    backgroundMutations: metadataBackgroundMutations,
    transaction: async (action) => {
      batches.push([]);
      await action();
    },
    savepoint: () => Promise.resolve(),
    afterBatch: () => undefined,
    handlers: {
      buildRecordingUnits: () => batches.at(-1)!.push('index'),
      apply: () => batches.at(-1)!.push('recording'),
    },
  });
  port.emit('message', { id: 1, method: 'buildRecordingUnits' });
  port.emit('message', { id: 2, method: 'apply' });
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  expect(batches).toEqual([['recording'], ['index']]);
  expect(replies.map(({ id }) => id)).toEqual([2, 1]);
});
