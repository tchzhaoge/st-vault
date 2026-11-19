import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { writeCheckpoint } from './portable-checkpoint.js';
import { fileHashAsync } from '../library/files.js';

// Isolated output-only comparison: no business database, video or credentials.
const parent = process.argv[2];
if (!parent) throw Error('BENCHMARK_DIRECTORY_REQUIRED');
const root = await mkdtemp(path.join(parent, 'stv-checkpoint-bench-'));
const count = 100000;
const tables = [{ name: 'items', columns: ['id', 'value'], keys: ['id'] }];
const row = (id: number) => ({ id, value: 'synthetic-frame-metadata-'.repeat(10) });
const start = performance.now();
let baselineMs = 0;
try {
  const filename = path.join(root, 'baseline.ndjson');
  const output = await open(filename, 'wx');
  const hash = createHash('sha256');
  try {
    const line = async (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      await output.writeFile(bytes);
      hash.update(bytes);
    };
    await line({ format: 1, library: 'synthetic', sequence: 1, tables });
    for (let id = 0; id < count; id++) await line({ table: 'items', row: row(id) });
    await line({ complete: true, rows: count });
    await output.sync();
  } finally {
    await output.close();
  }
  baselineMs = performance.now() - start;
  let offset = 0;
  const client = {
    query: (sql: string) => {
      if (!sql.startsWith('FETCH')) return Promise.resolve({ rows: [] });
      const rows = Array.from({ length: Math.min(128, count - offset) }, () => row(offset++));
      return Promise.resolve({ rows });
    },
  } as unknown as PoolClient;
  const next = performance.now();
  const checkpoint = await writeCheckpoint({
    client,
    mediaRoot: root,
    library: 'synthetic',
    sequence: 1,
    tables,
  });
  const batchedMs = performance.now() - next;
  const actual = await fileHashAsync(path.join(root, checkpoint.file));
  const expected = hash.digest('hex');
  if (actual !== expected || checkpoint.hash !== expected) throw Error('OUTPUT_MISMATCH');
  console.log(
    JSON.stringify({
      directory: parent,
      rows: count,
      bytes: (await stat(filename)).size,
      baselineMs,
      batchedMs,
      speedup: baselineMs / batchedMs,
      sha256: actual,
      equivalent: true,
      includes: 'serialize + hash + write + fsync; batched includes cursor stub/rename/dir sync',
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
