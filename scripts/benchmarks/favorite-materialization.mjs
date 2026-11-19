import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaSelectionStore } from '../../apps/server/src/archive/media-selection-store.ts';
import { FavoriteCommands } from '../../apps/server/src/archive/favorite-commands.ts';
// Synthetic local-container WAL/FULL + Session cost; excludes portable-journal fsync, NAS disks, JPEG and browser work.
// UUID identities match production width. Run only in an isolated Docker container.
const root = mkdtempSync(join(tmpdir(), 'stv-favorite-bench-'));
const db = new DatabaseSync(join(root, 'benchmark.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
CREATE TABLE subjects(id TEXT PRIMARY KEY,deletion_revision INTEGER);INSERT INTO subjects VALUES('stripchat:1',0);
CREATE TABLE personal_owner(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO personal_owner VALUES(1,0);
CREATE TABLE recording_units(id TEXT PRIMARY KEY,subject TEXT,start INTEGER,end INTEGER,deleted INTEGER,created_revision INTEGER);
CREATE INDEX unit_window ON recording_units(subject,start,id);
CREATE TABLE segments(id TEXT PRIMARY KEY,end INTEGER,deleted INTEGER,created_revision INTEGER);
CREATE TABLE unit_segments(unit TEXT,segment TEXT);CREATE INDEX unit_members ON unit_segments(unit,segment);
CREATE TABLE unit_favorites(unit TEXT PRIMARY KEY,created INTEGER);CREATE TABLE media_deletions(id TEXT,state TEXT,created INTEGER);
CREATE VIEW visible_segments AS SELECT * FROM segments WHERE deleted=0;
BEGIN;
WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
INSERT INTO recording_units SELECT printf('%08d-0000-4000-8000-%012d',i,i),'stripchat:1',i*1000,i*1000+1000,0,1 FROM n;
INSERT INTO segments SELECT id,end,0,1 FROM recording_units;INSERT INTO unit_segments SELECT id,id FROM recording_units;COMMIT;`);
const selections = new MediaSelectionStore(db, () => 1),
  favorites = new FavoriteCommands(db, selections);
const tx = (fn) => {
  db.exec('BEGIN');
  try {
    const v = fn();
    db.exec('COMMIT');
    return v;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};
const id = tx(() => selections.begin('stripchat:1', { fromMs: 0, toMs: 100001000 }, 'all'));
while (tx(() => selections.build('stripchat:1', id))) {}
let t = performance.now();
tx(() => favorites.accept('stripchat:1', id, true, 0));
const acceptMs = performance.now() - t;
t = performance.now();
const immediate = db.prepare('SELECT count(*) n FROM effective_unit_favorites').get().n;
const readMs = performance.now() - t;
let maxMs = 0,
  maxDelta = 0,
  batches = 0,
  total = 0;
for (;;) {
  const session = db.createSession();
  t = performance.now();
  db.exec('BEGIN');
  const more = favorites.step();
  const changes = session.changeset();
  db.exec('COMMIT');
  const ms = performance.now() - t;
  session.close();
  if (!more) break;
  maxMs = Math.max(maxMs, ms);
  maxDelta = Math.max(maxDelta, changes.length);
  total += ms;
  batches++;
  await new Promise((r) => setImmediate(r));
}
console.log(
  JSON.stringify({
    count: immediate,
    acceptMs,
    readMs,
    batches,
    maxBatchMs: maxMs,
    maxChangesetBytes: maxDelta,
    totalProjectionMs: total,
  }),
);
db.close();
rmSync(root, { recursive: true, force: true });
