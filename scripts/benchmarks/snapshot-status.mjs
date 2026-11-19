// Synthetic task metadata only. No deployment state, upstream requests or media files.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScreenshotJobs } from '../../build/apps/server/src/previews/jobs.js';
import { readJobStatistics } from '../../build/apps/server/src/previews/job-statistics.js';

const root = await mkdtemp(path.join(tmpdir(), 'stv-snapshot-status-benchmark-'));
let db;
try {
  const queue = await ScreenshotJobs.open({
    root,
    archive: { listSubjects: async () => [], locate: async () => null },
    render: async () => {
      throw Error('UNUSED_RENDER');
    },
    validate: async () => {},
    canGenerate: () => false,
  });
  await queue.close();
  db = new DatabaseSync(path.join(root, 'jobs.sqlite'));
  db.exec('PRAGMA synchronous=OFF'); // Synthetic generation only, not a deployment setting.
  db.exec(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<13)
    INSERT INTO jobs(subject,at,end,slot,created,priority,state)
    SELECT 'stripchat:2',v*60000,v*60000+500,v*60000,1000+v,0,
    CASE WHEN v<=8 THEN 'pending' WHEN v<=10 THEN 'running' ELSE 'failed' END FROM n`);
  const legacy = () => ({
    counts: db.prepare('SELECT state,COUNT(*) AS n FROM jobs GROUP BY state').all(),
    oldest: db
      .prepare("SELECT MIN(created) AS created FROM jobs WHERE state IN ('pending','running')")
      .get(),
  });
  const sample = (work, rounds) => {
    for (let i = 0; i < 5; i++) work();
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const start = performance.now();
      work();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return {
      rounds,
      p50Ms: samples[Math.floor(rounds * 0.5)],
      p95Ms: samples[Math.floor(rounds * 0.95)],
    };
  };
  const results = [];
  let previous = 0;
  for (const count of [1000, 300000, 1000000]) {
    const generationAt = performance.now();
    db.prepare(
      `WITH RECURSIVE n(v) AS (VALUES(?) UNION ALL SELECT v+1 FROM n WHERE v<?)
      INSERT INTO jobs(subject,at,end,slot,created,priority,state)
      SELECT 'stripchat:1',v*60000,v*60000+500,v*60000,0,0,'done' FROM n`,
    ).run(previous + 1, count);
    const generatedMs = performance.now() - generationAt;
    previous = count;
    assert.deepEqual(
      { ...readJobStatistics(db) },
      {
        pending: 10,
        failed: 3,
        completed: count,
        oldestCreated: 1001,
      },
    );
    results.push({
      completed: count,
      active: 13,
      generatedMs,
      legacy: sample(legacy, 20),
      incremental: sample(() => readJobStatistics(db), 1000),
    });
  }
  const plans = [];
  for (const sql of [
    'SELECT * FROM job_statistics WHERE id=1',
    "SELECT created FROM jobs INDEXED BY jobs_oldest WHERE state IN ('pending','running') ORDER BY created LIMIT 1",
  ])
    plans.push(
      ...db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail),
    );
  console.log(
    JSON.stringify({
      synthetic: true,
      node: process.version,
      sqlite: db.prepare('SELECT sqlite_version() version').get().version,
      results,
      plans,
    }),
  );
} finally {
  db?.close();
  await rm(root, { recursive: true, force: true });
}
