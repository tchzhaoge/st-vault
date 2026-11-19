// Synthetic metadata stress only: no production state, streams or video unlink.
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DeletionStore } from '../../build/apps/server/src/archive/deletion-store.js';
const root = await mkdtemp(path.join(tmpdir(), 'stv-delete-workload-'));
const db = new DatabaseSync(path.join(root, 'metadata.sqlite'));
const transaction = (fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
try {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE subjects(id TEXT PRIMARY KEY);
    CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT,start REAL,end REAL,deleted INTEGER,created_revision INTEGER,media TEXT);
    CREATE INDEX segment_window ON segments(subject,deleted,start,id,end,created_revision);
    CREATE TABLE objects(id TEXT PRIMARY KEY,bytes INTEGER);
    CREATE TABLE favorite_ranges(subject TEXT,from_ms INTEGER,to_ms INTEGER);
    INSERT INTO subjects VALUES('stripchat:1'); INSERT INTO objects VALUES('media',10);`);
  const insert = db.prepare('INSERT INTO segments VALUES(?,?,?,?,0,?,?)');
  transaction(() => {
    for (let i = 0; i < 100000; i++)
      insert.run(
        String(i).padStart(8, '0'),
        'stripchat:1',
        i * 1000,
        i * 1000 + 1000,
        i + 1,
        'media',
      );
  });
  const store = new DeletionStore(db, () => 0);
  const before = process.memoryUsage();
  const begin = performance.now();
  const id = transaction(() =>
    store.begin('stripchat:1', [{ fromMs: 0, toMs: 100000000 }], 100000),
  );
  let more = true,
    maxPlanBatchMs = 0,
    peakHeap = before.heapUsed,
    planBatches = 0;
  while (more) {
    const at = performance.now();
    more = transaction(() => store.build(id));
    maxPlanBatchMs = Math.max(maxPlanBatchMs, performance.now() - at);
    planBatches++;
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const planMs = performance.now() - begin;
  const plan = store.plan(id);
  assert.equal(plan.total, 100000);
  assert(!('segmentIds' in plan));
  const at = performance.now();
  transaction(() => store.accept('stripchat:1', id, 0));
  const acceptanceMs = performance.now() - at;
  let maxExecutionBatch = 0,
    batches = 0;
  const mark = db.prepare('UPDATE segments SET deleted=1 WHERE id=?');
  for (let job = transaction(() => store.next()); job; job = transaction(() => store.next())) {
    maxExecutionBatch = Math.max(maxExecutionBatch, job.segmentIds.length);
    transaction(() => {
      for (const segment of job.segmentIds) mark.run(segment);
      store.advance(job.id, job.processed + job.segmentIds.length, 0);
    });
    batches++;
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(maxExecutionBatch, 128);
  assert.equal(store.list()[0].processed, 100000);
  assert.equal(db.prepare('SELECT count(*) n FROM deletion_items').get().n, 0);
  console.log(
    JSON.stringify({
      syntheticMetadataOnly: true,
      files: plan.total,
      planBatches,
      planMs,
      maxPlanBatchMs,
      acceptanceMs,
      batches,
      maxExecutionBatch,
      peakHeapMiB: peakHeap / 1048576,
      heapGrowthMiB: (peakHeap - before.heapUsed) / 1048576,
      completed: true,
    }),
  );
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
