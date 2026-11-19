import type { SqlDatabase } from '../database/sql.js';

/** Units own deletion identity; surviving members only establish media existence. */
export async function initializeUnitVisibility(
  db: SqlDatabase,
  deletionIntents = false,
): Promise<void> {
  await db.exec(`CREATE OR REPLACE VIEW visible_recording_units AS
    SELECT u.* FROM recording_units u WHERE u.deleted=0
    ${deletionIntents ? 'AND NOT EXISTS(SELECT 1 FROM deletion_intent_units x WHERE x.unit=u.id)' : ''}
    AND EXISTS(SELECT 1 FROM unit_segments m JOIN segments s ON s.id=m.segment
      WHERE m.unit=u.id AND s.deleted=0)`);
}
