import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PoolClient, QueryResultRow } from 'pg';
import { Postgres } from './postgres.js';
import { getExecutionPolicy } from '../runtime/execution-policy.js';
let nextCursor = 0;

export type SQLInputValue = string | number | bigint | null | Uint8Array;
export function databaseSchema(namespace: string): string {
  return 'stv_' + createHash('sha256').update(path.resolve(namespace)).digest('hex').slice(0, 24);
}
/** Parameter binding only: SQL itself is PostgreSQL, including every schema/view. */
export function bindParameters(sql: string): string {
  let output = '',
    index = 0,
    parameter = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      const quote = character;
      output += character;
      index++;
      while (index < sql.length) {
        const next = sql[index++];
        output += next;
        if (next === quote) {
          if (sql[index] === quote) {
            output += sql[index++];
          } else break;
        }
      }
    } else if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      const stop = end < 0 ? sql.length : end;
      output += sql.slice(index, stop);
      index = stop;
    } else if (sql.startsWith('/*', index)) {
      let depth = 1;
      output += '/*';
      index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) {
          depth++;
          output += '/*';
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth--;
          output += '*/';
          index += 2;
        } else output += sql[index++];
      }
    } else if (character === '$' && /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.test(sql.slice(index))) {
      const delimiter = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(index))![0];
      const end = sql.indexOf(delimiter, index + delimiter.length);
      const stop = end < 0 ? sql.length : end + delimiter.length;
      output += sql.slice(index, stop);
      index = stop;
    } else if (character === '?') {
      output += '$' + ++parameter;
      index++;
    } else output += sql[index++];
  }
  return output;
}
export class SqlDatabase {
  readonly postgres: Postgres;
  readonly schema: string;
  private readonly snapshotClient?: PoolClient;
  private closed = false;
  private constructor(postgres: Postgres, schema: string, client?: PoolClient) {
    this.postgres = postgres;
    this.schema = schema;
    this.snapshotClient = client;
  }
  static async open(namespace: string): Promise<SqlDatabase> {
    const host = process.env.STV_DATABASE_SOCKET,
      password = process.env.STV_DATABASE_PASSWORD;
    if (!host || !password) throw Error('POSTGRES_CONNECTION_REQUIRED');
    const schema = databaseSchema(namespace);
    const privateNamespace = namespace.endsWith('/private');
    const jobsNamespace = namespace.endsWith('/jobs');
    const budgets = getExecutionPolicy().database;
    const postgres = new Postgres({
      connection: {
        host,
        password,
        user: 'stvault',
        database: 'stvault',
        options: `-c search_path=${schema},public`,
      },
      interactiveConnections: privateNamespace
        ? 1
        : jobsNamespace
          ? budgets.jobsInteractiveConnections
          : budgets.interactiveConnections,
      backgroundConnections: privateNamespace
        ? 1
        : jobsNamespace
          ? budgets.jobsBackgroundConnections
          : budgets.backgroundConnections,
      playbackConnections: privateNamespace || jobsNamespace ? 0 : budgets.playbackConnections,
      snapshotConnections: privateNamespace || jobsNamespace ? 0 : budgets.snapshotConnections,
      writerConnections: privateNamespace || jobsNamespace ? 0 : budgets.writerConnections,
    });
    try {
      await postgres.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      return new SqlDatabase(postgres, schema);
    } catch (error) {
      await postgres.close();
      throw error;
    }
  }
  get isTransaction(): boolean {
    return this.snapshotClient !== undefined || this.postgres.inTransaction;
  }
  get isOpen(): boolean {
    return !this.closed;
  }
  afterCommit(action: () => void): void {
    this.postgres.afterCommit(action);
  }
  onCommittedHookFailure(action: (error: AggregateError) => void): void {
    this.postgres.onCommittedHookFailure(action);
  }
  async exec(sql: string): Promise<void> {
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)(?:\s|;|$)/i.test(sql) && !this.isTransaction)
      throw Error('USE_DATABASE_TRANSACTION_CALLBACK');
    await this.execute(sql, []);
  }
  private async execute(sql: string, parameters: readonly SQLInputValue[]) {
    if (this.closed) throw Error('DATABASE_CLOSED');
    const values = parameters.map((value) =>
      value instanceof Uint8Array ? Buffer.from(value) : value,
    );
    if (this.snapshotClient) return this.snapshotClient.query(sql, values);
    return this.postgres.execute(sql, values);
  }
  private async *iterate<T>(bound: string, parameters: SQLInputValue[]): AsyncGenerator<T> {
    const database = this.isTransaction ? this : await this.snapshot();
    const cursor = 'stv_cursor_' + ++nextCursor;
    let failed = false;
    try {
      await database.execute(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${bound}`, parameters);
      for (;;) {
        const rows = (await database.execute(`FETCH FORWARD 128 FROM ${cursor}`, [])).rows as T[];
        for (const row of rows) yield row;
        if (rows.length < 128) break;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (!failed) await database.exec(`CLOSE ${cursor}`);
      } finally {
        if (database !== this) await database.close();
      }
    }
  }
  prepare(sql: string) {
    const bound = bindParameters(sql);
    return {
      iterate: <T = Record<string, unknown>>(...parameters: SQLInputValue[]): AsyncGenerator<T> =>
        this.iterate<T>(bound, parameters),
      get: async <T = Record<string, unknown>>(
        ...parameters: SQLInputValue[]
      ): Promise<T | undefined> => (await this.execute(bound, parameters)).rows[0] as T | undefined,
      all: async <T = Record<string, unknown>>(...parameters: SQLInputValue[]): Promise<T[]> =>
        (await this.execute(bound, parameters)).rows as T[],
      run: async (
        ...parameters: SQLInputValue[]
      ): Promise<{ changes: number; lastInsertRowid?: number }> => {
        const result = await this.execute(bound, parameters);
        const row = result.rows[0] as QueryResultRow | undefined;
        return {
          changes: result.rowCount ?? 0,
          ...(typeof row?.id === 'number' ? { lastInsertRowid: row.id } : {}),
        };
      },
    };
  }
  transaction<T>(action: () => Promise<T>): Promise<T> {
    if (this.snapshotClient) throw Error('DATABASE_SNAPSHOT_IS_READ_ONLY');
    return this.postgres.transaction(action);
  }
  async snapshot(): Promise<SqlDatabase> {
    return new SqlDatabase(this.postgres, this.schema, await this.postgres.snapshot());
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.snapshotClient) {
      let discard = true;
      try {
        await this.snapshotClient.query('ROLLBACK');
        discard = false;
      } finally {
        // A failed rollback leaves transaction/connection state unknown.
        this.snapshotClient.release(discard);
      }
    } else await this.postgres.close();
  }
}
