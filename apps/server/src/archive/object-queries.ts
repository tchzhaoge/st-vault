// The request owns the outer loop. Do not let batch cardinality turn a handful
// of primary-key probes into a scan of every live object via object_verify.
export const hasMediaSql = `WITH requested AS MATERIALIZED (
  SELECT DISTINCT value AS id FROM json_array_elements_text(?::json)
) SELECT COUNT(*) AS count FROM requested r
  JOIN objects o ON o.id=r.id
  WHERE o.deleted=0 AND
  (o.kind='init' OR EXISTS(SELECT 1 FROM visible_segments s WHERE s.id=o.id AND s.deleted=0))`;
export const liveObjectsSql =
  'SELECT * FROM objects WHERE deleted=0 AND id>? ORDER BY id LIMIT 128';
export const liveObjectsIndexSql = 'CREATE INDEX IF NOT EXISTS object_live ON objects(deleted,id)';
