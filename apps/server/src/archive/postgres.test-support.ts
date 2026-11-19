import { randomUUID } from 'node:crypto';
import { SqlDatabase } from '../database/sql.js';

/** White-box fixtures deliberately mutate the hot projection, not the production journal. */
export async function openTestDatabase(
  namespace = '/tmp/archive-store-' + randomUUID(),
): Promise<SqlDatabase> {
  const db = await SqlDatabase.open(namespace);
  const transaction = db.transaction.bind(db),
    exec = db.exec.bind(db),
    prepare = db.prepare.bind(db);
  db.transaction = <T>(action: () => Promise<T>): Promise<T> => {
    if (db.isTransaction) return transaction(action);
    return transaction(async () => {
      await exec("SET LOCAL stv.replay='on'");
      return action();
    });
  };
  db.exec = (sql: string) => db.transaction(() => exec(sql));
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    return {
      ...statement,
      run: (...values: Parameters<typeof statement.run>) =>
        db.transaction(() => statement.run(...values)),
    };
  };
  return db;
}
export interface PostgreSqlPlan {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Index Cond'?: string;
  Alias?: string;
  Plans?: PostgreSqlPlan[];
}
/** Inspect PostgreSQL plan nodes directly rather than translating SQLite EXPLAIN strings. */
export function planNodes(rows: Record<string, unknown>[]): PostgreSqlPlan[] {
  const encoded = rows[0]?.['QUERY PLAN'];
  const document: unknown = Array.isArray(encoded) ? encoded[0] : undefined;
  if (!Array.isArray(encoded) || !document || typeof document !== 'object' || !('Plan' in document))
    throw Error('INVALID_TEST_QUERY_PLAN');
  const root = document.Plan as PostgreSqlPlan;
  const nodes: PostgreSqlPlan[] = [];
  const visit = (plan: PostgreSqlPlan) => {
    nodes.push(plan);
    for (const child of plan.Plans ?? []) visit(child);
  };
  visit(root);
  return nodes;
}
export async function dropTestDatabase(namespace: string): Promise<void> {
  const db = await openTestDatabase(namespace);
  try {
    await db.exec('DROP SCHEMA "' + db.schema + '" CASCADE');
  } finally {
    await db.close();
  }
}
