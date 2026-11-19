import type { SqlDatabase } from './sql.js';
import { liveObjectsIndexSql } from '../archive/object-queries.js';
import { EventStore } from '../archive/events-store.js';
import { PersonalStore } from '../archive/personal-store.js';
import { RecordingUnits } from '../archive/recording-units.js';
import { DeletionStore } from '../archive/deletion-store.js';
import { MediaSelectionStore } from '../archive/media-selection-store.js';
import { FavoriteCommands } from '../archive/favorite-commands.js';
import { DeletionIntents } from '../archive/deletion-intents.js';
import { AccountSubjects } from '../archive/account-subjects.js';
export async function initializeBaseSchema(db: SqlDatabase, origin = Date.now()): Promise<void> {
  const prior = await db
    .prepare(
      "SELECT to_regclass('catalog_schema') IS NOT NULL AS versioned,to_regclass('subjects') IS NOT NULL AS existing",
    )
    .get<{ versioned: boolean; existing: boolean }>();
  if (prior?.versioned) {
    const version = await db
      .prepare('SELECT version FROM catalog_schema WHERE id=1')
      .get<{ version: number }>();
    if (version?.version !== 1) throw Error('UNSUPPORTED_ARCHIVE_VERSION');
  } else if (prior?.existing) throw Error('UNSUPPORTED_ARCHIVE_VERSION');
  await db.transaction(async () => {
    await db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY, provider_id BIGINT NOT NULL, handle TEXT NOT NULL,
      monitor BIGINT NOT NULL DEFAULT 1, auto_record BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'UNKNOWN', observed BIGINT, unlocated BIGINT NOT NULL DEFAULT 0, deletion_revision BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subject_images (subject TEXT PRIMARY KEY,preview TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subject_name_history(subject TEXT NOT NULL REFERENCES subjects(id) DEFERRABLE INITIALLY DEFERRED,handle TEXT NOT NULL,changed_at BIGINT NOT NULL,PRIMARY KEY(subject,handle));
    CREATE TABLE IF NOT EXISTS account_subjects (subject TEXT PRIMARY KEY,following BIGINT NOT NULL CHECK(following IN(0,1)));
    CREATE TABLE IF NOT EXISTS journal_heads (subject TEXT PRIMARY KEY, revision BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (id BIGINT PRIMARY KEY, revision BIGINT NOT NULL);
    INSERT INTO counters VALUES(1,0) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, filename TEXT NOT NULL,
      bytes BIGINT NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL,
      deleted BIGINT NOT NULL DEFAULT 0, gc_done BIGINT NOT NULL DEFAULT 0, needs_verify BIGINT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS object_init ON objects(subject,kind,hash,deleted);
    CREATE INDEX IF NOT EXISTS object_gc ON objects(subject,deleted,gc_done,id);
    ${liveObjectsIndexSql};
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, epoch TEXT NOT NULL, sequence TEXT NOT NULL,
      media TEXT NOT NULL, init TEXT, start DOUBLE PRECISION, "end" DOUBLE PRECISION,
      deleted BIGINT NOT NULL DEFAULT 0, json TEXT NOT NULL, created_revision BIGINT NOT NULL DEFAULT 0,
      UNIQUE(subject,epoch,sequence)
    );
    -- Empty windows must reject candidates from the index without fetching JSON
    -- payload pages. Both playback and screenshot reconciliation use this path.
    CREATE INDEX IF NOT EXISTS segment_window ON segments(subject,deleted,start,id,"end",created_revision);
    DROP INDEX IF EXISTS segment_start;
    DROP INDEX IF EXISTS segment_snapshot;
    CREATE INDEX IF NOT EXISTS segment_finish ON segments(subject,deleted,"end",id,start);
    CREATE INDEX IF NOT EXISTS segment_origin ON segments(subject,start,id,"end");
    DROP INDEX IF EXISTS segment_end;
    CREATE INDEX IF NOT EXISTS segment_init ON segments(init,deleted);
    ALTER TABLE segments ALTER COLUMN json SET STATISTICS 0;
    CREATE TABLE IF NOT EXISTS source_checkpoints(subject TEXT PRIMARY KEY,epoch TEXT NOT NULL,sequence TEXT NOT NULL,wall DOUBLE PRECISION);

    CREATE TABLE IF NOT EXISTS coverage_minutes(subject TEXT NOT NULL,minute BIGINT NOT NULL,spans TEXT NOT NULL,starts TEXT NOT NULL,ends TEXT NOT NULL,count BIGINT NOT NULL,covered_ms BIGINT NOT NULL DEFAULT 0,start_count BIGINT NOT NULL DEFAULT 0,end_count BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(subject,minute));
    CREATE INDEX IF NOT EXISTS object_verify ON objects(deleted,needs_verify,id);
    CREATE TABLE IF NOT EXISTS status_intervals(subject TEXT NOT NULL,start BIGINT NOT NULL,"end" BIGINT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(subject,start));
    CREATE INDEX IF NOT EXISTS status_interval_end ON status_intervals(subject,"end",start);
    CREATE INDEX IF NOT EXISTS status_interval_window ON status_intervals(subject,start,"end",status);
    CREATE INDEX IF NOT EXISTS status_interval_activity ON status_intervals(subject,start DESC,status) WHERE status IN ('PUBLIC','PRIVATE');
    DROP INDEX IF EXISTS status_interval_online;
    CREATE TABLE IF NOT EXISTS status_heads(subject TEXT PRIMARY KEY,start BIGINT NOT NULL,last_at BIGINT NOT NULL,valid_until BIGINT NOT NULL,status TEXT NOT NULL,active BIGINT NOT NULL,event_expired BIGINT NOT NULL DEFAULT 0);
  `);
    await db.exec(
      'CREATE TABLE IF NOT EXISTS catalog_schema(id SMALLINT PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);INSERT INTO catalog_schema VALUES(1,1) ON CONFLICT(id) DO NOTHING',
    );
    if (!prior?.versioned)
      await db
        .prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING')
        .run('timeline.deployed-at', String(origin));
  });
}

export async function initializeCatalogSchema(db: SqlDatabase, origin: number): Promise<void> {
  await initializeBaseSchema(db, origin);
  await db
    .prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING')
    .run('timeline.deployed-at', String(origin));
  const events = new EventStore(db);
  await events.initialize();
  const personal = new PersonalStore(db, origin);
  await personal.initialize();
  const units = new RecordingUnits(db);
  await units.initialize();
  const revision = async () =>
    (await db.prepare('SELECT revision FROM counters WHERE id=1').get<{ revision: number }>())
      ?.revision ?? 0;
  const deletion = new DeletionStore(db, () => personal.revision());
  await deletion.initialize();
  await db.exec(`CREATE OR REPLACE VIEW visible_segments AS SELECT s.* FROM segments s WHERE NOT EXISTS(
 SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job WHERE i.segment=s.id AND d.state IN ('queued','running','retry'))
 AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN recording_units u ON u.id=m.unit WHERE m.segment=s.id AND u.deleted=1)`);
  const selection = new MediaSelectionStore(db, revision);
  await selection.initialize();
  const favorites = new FavoriteCommands(db, selection);
  await favorites.initialize();
  const intents = new DeletionIntents(db, deletion, selection, revision, () => personal.revision());
  await intents.initialize();
  await db.exec(`CREATE OR REPLACE VIEW visible_segments AS SELECT s.* FROM segments s WHERE NOT EXISTS(
 SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job WHERE i.segment=s.id AND d.state IN ('queued','running','retry'))
 AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN recording_units u ON u.id=m.unit WHERE m.segment=s.id AND u.deleted=1)
 AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN deletion_intent_units x ON x.unit=m.unit WHERE m.segment=s.id)`);
  const account = new AccountSubjects(
    db,
    () => Promise.resolve(),
    () => Promise.resolve(),
  );
  await account.initialize();
}
