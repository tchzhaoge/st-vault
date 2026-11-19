import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { RecordingUnits } from '../../apps/server/src/archive/recording-units.ts';
import {
  recordingLayout,
  recordingGapParts,
} from '../../packages/api-schema/src/recording-layout.ts';
import { SnapshotLayoutIndex } from '../../apps/server/src/archive/snapshot-layout-index.ts';

// Synthetic in-memory SQL/layout work, not disk/JPEG/browser or a NAS throughput claim.
for (const size of [10000, 100000]) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT,start INTEGER,end INTEGER,
    deleted INTEGER,json TEXT,created_revision INTEGER);
    CREATE VIEW visible_segments AS SELECT * FROM segments;`);
  const units = new RecordingUnits(db);
  const segment = db.prepare('INSERT INTO segments VALUES(?,?,?,?,0,?,?)');
  const unit = db.prepare(
    'INSERT INTO recording_units(id,subject,start,end,sample,last_start,created_revision,closed,deleted) VALUES(?,?,?,?,?,?,?,1,0)',
  );
  const member = db.prepare('INSERT INTO unit_segments VALUES(?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < size; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      start = i * 7000;
    segment.run(
      id,
      'stripchat:1',
      start,
      start + 6000,
      JSON.stringify({ timeBasis: 'source-pdt', uncertaintyMs: 0 }),
      i + 1,
    );
    unit.run(id, 'stripchat:1', start, start + 6000, start, start, i + 1);
    member.run(id, id);
  }
  db.exec('COMMIT');
  const window = { fromMs: 0, toMs: size * 7000 };
  const times = [];
  let count = 0;
  for (let run = 0; run < 6; run++) {
    const start = performance.now();
    const rows = units.list('stripchat:1', window);
    const layout = recordingLayout(rows, window);
    assert.equal(rows.length, size, 'Benchmark must exercise occupied units, not an empty query');
    assert.equal(layout.length, size);
    for (const row of rows.slice(0, 30)) units.item(row);
    count = layout.length;
    if (run) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const index = new SnapshotLayoutIndex(units, recordingGapParts),
    coldStart = performance.now();
  let maxBatch = 0,
    done = false,
    batches = 0;
  while (!done) {
    const start = performance.now();
    done = index.prepare('stripchat:1', window, 'v');
    maxBatch = Math.max(maxBatch, performance.now() - start);
    batches++;
  }
  const coldMs = performance.now() - coldStart,
    hot = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now(),
      packet = index.page('stripchat:1', window, 'v', Math.floor(size / 60), 30);
    units.items(
      'stripchat:1',
      packet.cells.filter((c) => c.kind === 'unit').map((c) => c.unitId),
    );
    assert.equal(packet.total, size);
    assert.equal(packet.cells.length, 30);
    hot.push(performance.now() - start);
  }
  hot.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      size,
      cells: count,
      oldP50Ms: +times[2].toFixed(2),
      oldP95Ms: +times[4].toFixed(2),
      coldMs: +coldMs.toFixed(2),
      batches,
      maxBatchMs: +maxBatch.toFixed(2),
      hotP50Ms: +hot[10].toFixed(2),
      hotP95Ms: +hot[19].toFixed(2),
      heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    }),
  );
  db.close();
}
