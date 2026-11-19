import type { SqlDatabase } from '../database/sql.js';
import { initializeJobStatistics } from './job-statistics.js';

/** Shared schema install for normal startup and offline SQLite migration. No tasks are started here. */
export async function initializeScreenshotSchema(db: SqlDatabase): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS jobs(subject TEXT NOT NULL,unit TEXT NOT NULL CHECK(unit<>''),at BIGINT NOT NULL,\"end\" BIGINT NOT NULL,slot BIGINT NOT NULL,coverage_end BIGINT,created BIGINT NOT NULL DEFAULT 0,priority BIGINT NOT NULL,attempts BIGINT NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',due BIGINT NOT NULL DEFAULT 0,hash TEXT,rendered_to BIGINT,media_ids TEXT,error TEXT,PRIMARY KEY(subject,at,\"end\",unit));\n    CREATE UNIQUE INDEX IF NOT EXISTS jobs_unit ON jobs(subject,unit) WHERE unit<>'';\n    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(state,due,priority DESC,at DESC);\n    CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(priority DESC,at DESC,due) WHERE state IN ('pending','failed');\n    CREATE INDEX IF NOT EXISTS jobs_fair ON jobs(created,at) WHERE state IN ('pending','failed');\n    CREATE TABLE IF NOT EXISTS scan(subject TEXT PRIMARY KEY,unit_cursor TEXT);\n    CREATE TABLE IF NOT EXISTS retired(subject TEXT NOT NULL,at BIGINT NOT NULL,\"end\" BIGINT NOT NULL,unit TEXT NOT NULL CHECK(unit<>''),PRIMARY KEY(subject,at,\"end\",unit));\n    CREATE TABLE IF NOT EXISTS invalidations(subject TEXT PRIMARY KEY,from_ms BIGINT NOT NULL,to_ms BIGINT NOT NULL,cursor_at BIGINT NOT NULL DEFAULT -1,cursor_end BIGINT NOT NULL DEFAULT -1,cursor_unit TEXT NOT NULL DEFAULT '',generation BIGINT NOT NULL DEFAULT 0);\n    CREATE INDEX IF NOT EXISTS jobs_coverage ON jobs(subject,coalesce(coverage_end,\"end\"),slot);",
  );
  await db.exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claim_token TEXT');
  await initializeJobStatistics(db);
}
