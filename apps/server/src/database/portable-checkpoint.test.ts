import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { restoreCheckpoint, writeCheckpoint } from './portable-checkpoint.js';
import type { Postgres } from './postgres.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(rows: Record<string, unknown>[], onFetch?: () => void) {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-checkpoint-output-'));
  roots.push(root);
  const probe = await open(path.join(root, 'probe'), 'w');
  const writes = vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'writeFile');
  await probe.close();
  let offset = 0;
  const client = {
    query: vi.fn((sql: string) => {
      if (!sql.startsWith('FETCH')) return Promise.resolve({ rows: [] });
      onFetch?.();
      const batch = rows.slice(offset, offset + 128);
      offset += batch.length;
      return Promise.resolve({ rows: batch });
    }),
  } as unknown as PoolClient;
  const options = {
    client,
    mediaRoot: root,
    library: 'test-library',
    sequence: 17,
    tables: [{ name: 'items', columns: ['id', 'value'], keys: ['id'] }],
  };
  return { root, options, writes };
}

it('batches small rows, preserves oversized batch rows and hashes exactly the complete output', async () => {
  const rows = Array.from({ length: 2000 }, (_, id) => ({ id, value: '图'.repeat(100) }));
  rows.splice(777, 0, { id: 2001, value: 'large'.repeat(65000) });
  const f = await fixture(rows);
  const checkpoint = await writeCheckpoint(f.options);
  const contents = await readFile(path.join(f.root, checkpoint.file));
  const expected = [
    { format: 1, library: 'test-library', sequence: 17, tables: f.options.tables },
    ...rows.map((row) => ({ table: 'items', row })),
    { complete: true, rows: rows.length },
  ]
    .map((value) => JSON.stringify(value) + '\n')
    .join('');
  expect(contents.toString()).toBe(expected);
  expect(checkpoint.hash).toBe(createHash('sha256').update(contents).digest('hex'));
  expect(f.writes.mock.calls.length).toBeLessThan(10);
  expect(await readdir(path.join(f.root, 'catalog'))).toEqual([path.basename(checkpoint.file)]);
});

it('rejects a row over the existing byte limit and removes its unpublished output', async () => {
  const f = await fixture([{ id: 1, value: 'x'.repeat(16 * 1024 ** 2) }]);
  await expect(writeCheckpoint(f.options)).rejects.toThrow('PORTABLE_CHECKPOINT_ROW_TOO_LARGE');
  expect(await readdir(path.join(f.root, 'catalog'))).toEqual([]);
});

it('discards a pending partial batch on abort and closes its cursor', async () => {
  const abort = new AbortController();
  const f = await fixture([{ id: 1, value: 'pending' }], () => abort.abort(Error('TEST_ABORT')));
  await expect(writeCheckpoint({ ...f.options, signal: abort.signal })).rejects.toThrow(
    'TEST_ABORT',
  );
  expect(await readdir(path.join(f.root, 'catalog'))).toEqual([]);
  expect(f.options.client.query).toHaveBeenCalledWith('CLOSE stv_checkpoint_rows');
});

it('bounds restore batches by UTF-8 bytes as well as row count', async () => {
  const rows = Array.from({ length: 4 }, (_, id) => ({ id, value: '图'.repeat(1800000) }));
  const f = await fixture(rows);
  const checkpoint = await writeCheckpoint(f.options);
  const batches: string[] = [];
  const db = {
    transaction: (action: () => Promise<void>) => action(),
    query: (sql: string, values?: unknown[]) => {
      if (sql.startsWith('INSERT INTO')) batches.push(String(values?.[0]));
      return Promise.resolve([]);
    },
  } as unknown as Postgres;
  await restoreCheckpoint({
    db,
    mediaRoot: f.root,
    checkpoint,
    library: f.options.library,
    tables: f.options.tables,
  });
  expect(batches).toHaveLength(2);
  expect(batches.every((batch) => Buffer.byteLength(batch) <= 16 * 1024 ** 2)).toBe(true);
  expect(batches.flatMap((batch) => JSON.parse(batch) as typeof rows)).toEqual(rows);
});

it('exports the snapshot cursor without imposing primary-key row order', async () => {
  const rows = [
    { id: 'z', value: 'first' },
    { id: 'a', value: 'second' },
  ];
  const f = await fixture(rows);
  const checkpoint = await writeCheckpoint(f.options);
  expect(f.options.client.query).toHaveBeenCalledWith(
    'DECLARE stv_checkpoint_rows NO SCROLL CURSOR FOR SELECT * FROM "items"',
  );
  const output = (await readFile(path.join(f.root, checkpoint.file), 'utf8')).trim().split('\n');
  expect(output.slice(1, -1).map((line) => (JSON.parse(line) as { row: unknown }).row)).toEqual(
    rows,
  );
});
