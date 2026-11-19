import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { EmbeddedPostgres } from './embedded.js';

// Small Linux-only scratch cluster. Never reads deployment state or media.
const root = await mkdtemp(path.join(tmpdir(), 'stv-checkpoint-scan-'));
let server: EmbeddedPostgres | undefined;
let client: Client | undefined;
try {
  server = await EmbeddedPostgres.open({
    root,
    binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
  });
  client = new Client(server.connection);
  await client.connect();
  await client.query(`CREATE TABLE items(id UUID PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO items SELECT md5(n::text)::uuid,repeat(md5((n+1)::text),48) FROM generate_series(1,50000) n;
    ANALYZE items;`);
  const size = (
    await client.query<{ bytes: string }>("SELECT pg_relation_size('items')::bigint AS bytes")
  ).rows[0];
  const results = [];
  for (const ordered of [true, false, false, true]) {
    const sql = 'SELECT * FROM items' + (ordered ? ' ORDER BY id' : '');
    const plan = (
      await client.query<{ 'QUERY PLAN': unknown }>(
        'EXPLAIN (FORMAT JSON) DECLARE probe NO SCROLL CURSOR FOR ' + sql,
      )
    ).rows[0]['QUERY PLAN'];
    const start = performance.now();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let rows = 0;
    try {
      await client.query('DECLARE exported NO SCROLL CURSOR FOR ' + sql);
      for (;;) {
        const result = await client.query('FETCH FORWARD 128 FROM exported');
        rows += result.rows.length;
        if (result.rows.length < 128) break;
      }
      await client.query('CLOSE exported');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    if (rows !== 50000) throw Error('BENCHMARK_ROWS_MISSING');
    results.push({ ordered, rows, elapsedMs: performance.now() - start, plan });
  }
  console.log(
    JSON.stringify({
      synthetic: true,
      rows: 50000,
      ...size,
      storage: 'isolated container Linux /tmp',
      results,
    }),
  );
} finally {
  await client?.end();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
