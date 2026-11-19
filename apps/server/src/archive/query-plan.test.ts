import { libraryIndexPath } from '../library/paths.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTestDatabase, planNodes } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { openArchive } from './index.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});
it('filters empty recording windows inside a covering index instead of reading historical payloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-query-plan-'));
  const archive = await openArchive({ root });
  await archive.close();
  const db = await openTestDatabase(libraryIndexPath(root));
  try {
    await db.exec(`INSERT INTO segments(id,subject,epoch,sequence,media,start,"end",json,created_revision)
    SELECT 'plan-'||n,'stripchat:1','plan',n::text,'plan-'||n,n*2000,n*2000+1000,repeat('x',2048),1 FROM generate_series(1,5000)n;ANALYZE segments`);
    const forward = planNodes(
      await db
        .prepare(
          'EXPLAIN (FORMAT JSON) SELECT id,start,"end" FROM segments WHERE subject=? AND deleted=0 AND start>? AND start<=? AND "end">? ORDER BY start DESC,id LIMIT 1',
        )
        .all('stripchat:1', 0, 86400000, 86400000),
    );
    expect(
      forward.some(
        (node) =>
          node['Node Type'] === 'Index Only Scan' &&
          ['segment_window', 'segment_finish'].includes(node['Index Name'] ?? ''),
      ),
      JSON.stringify(forward),
    ).toBe(true);
    const columns = await db
      .prepare(
        `SELECT a.attname AS name FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinal)
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
    WHERE i.indexrelid='segment_window'::regclass ORDER BY k.ordinal`,
      )
      .all<{ name: string }>();
    expect(columns.map((row) => row.name)).toEqual([
      'subject',
      'deleted',
      'start',
      'id',
      'end',
      'created_revision',
    ]);
    const reverse = planNodes(
      await db
        .prepare(
          'EXPLAIN (FORMAT JSON) SELECT id,start,"end" FROM segments WHERE subject=? AND deleted=0 AND "end">? AND start<? ORDER BY "end" DESC LIMIT 1',
        )
        .all('stripchat:1', 0, 86400000),
    );
    expect(
      reverse.some(
        (node) =>
          node['Node Type'] === 'Index Only Scan' && node['Index Name'] === 'segment_finish',
      ),
    ).toBe(true);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
