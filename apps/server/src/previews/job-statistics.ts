import type { SqlDatabase } from '../database/sql.js';
const states = [
  ['pending', 'pending'],
  ['running', 'running'],
  ['failed', 'failed'],
  ['completed', 'done'],
] as const;
function changes(added: 'NEW' | null, removed: 'OLD' | null): string {
  return states
    .map(
      ([column, state]) =>
        `${column}=${column}${added ? `+(${added}.state='${state}')::integer` : ''}${removed ? `-(${removed}.state='${state}')::integer` : ''}`,
    )
    .join(',');
}
/** Counts change in the jobs transaction; old completed history is scanned only once. */
export async function initializeJobStatistics(db: SqlDatabase): Promise<void> {
  await db.transaction(async () => {
    await db.exec(`LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE;
      CREATE TABLE IF NOT EXISTS job_statistics(id BIGINT PRIMARY KEY CHECK(id=1),${states.map(([column]) => `${column} BIGINT NOT NULL CHECK(${column}>=0)`).join(',')});
      CREATE INDEX IF NOT EXISTS jobs_oldest ON jobs(created) WHERE state IN ('pending','running')`);
    if (!(await db.prepare('SELECT id FROM job_statistics WHERE id=1').get()))
      await db.exec(
        `INSERT INTO job_statistics SELECT 1,${states.map(([, state]) => `COUNT(*) FILTER (WHERE state='${state}')`).join(',')} FROM jobs`,
      );
    await db.exec(`CREATE OR REPLACE FUNCTION maintain_job_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' THEN UPDATE job_statistics SET ${changes('NEW', null)} WHERE id=1;
        ELSIF TG_OP='DELETE' THEN UPDATE job_statistics SET ${changes(null, 'OLD')} WHERE id=1;
        ELSE UPDATE job_statistics SET ${changes('NEW', 'OLD')} WHERE id=1;
        END IF;
        RETURN NULL;
      END $$`);
    for (const [name, event, condition] of [
      ['insert', 'INSERT', ''],
      ['delete', 'DELETE', ''],
      ['state', 'UPDATE OF state', 'WHEN (NEW.state IS DISTINCT FROM OLD.state)'],
    ]) {
      await db.exec(`DROP TRIGGER IF EXISTS job_statistics_${name} ON jobs;
        CREATE TRIGGER job_statistics_${name} AFTER ${event} ON jobs FOR EACH ROW ${condition} EXECUTE FUNCTION maintain_job_statistics()`);
    }
  });
}
export interface JobStatistics {
  pending: number;
  failed: number;
  completed: number;
  oldestCreated: number | null;
}
/** Counters and oldest age are read from one PostgreSQL statement snapshot. */
export async function readJobStatistics(db: SqlDatabase): Promise<JobStatistics> {
  const row = await db
    .prepare(
      `SELECT pending+running AS pending,failed,completed,
    (SELECT created FROM jobs WHERE state IN ('pending','running') ORDER BY created LIMIT 1) AS "oldestCreated"
    FROM job_statistics WHERE id=1`,
    )
    .get<JobStatistics>();
  if (!row) throw Error('SCREENSHOT_STATISTICS_UNAVAILABLE');
  return row;
}
