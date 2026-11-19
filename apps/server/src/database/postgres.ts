import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types } from 'pg';
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

function safeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw Error('DATABASE_INTEGER_OUT_OF_RANGE');
  return parsed;
}
// Keep timestamp/counter contracts numeric without silently rounding BIGINT.
types.setTypeParser(20, safeInteger);

export type DatabaseLane = 'interactive' | 'background' | 'playback' | 'writer';
interface TransactionContext {
  active: boolean;
  client: PoolClient;
  lane: DatabaseLane;
  readOnly: boolean;
  committed: (() => void)[];
}
interface DatabaseOptions {
  connection: PoolConfig;
  interactiveConnections?: number;
  backgroundConnections?: number;
  playbackConnections?: number;
  snapshotConnections?: number;
  writerConnections?: number;
  report?: (event: {
    event: string;
    lane: DatabaseLane | 'snapshot';
    code: string;
    waitMs?: number;
    capacity?: number;
    active?: number;
    idle?: number;
    waiting?: number;
    executionMs?: number;
  }) => void;
}

/** Bounded pools reserve interactive capacity; transactions never change clients. */
export class Postgres {
  private readonly pools: Record<DatabaseLane, Pool | undefined>;
  private readonly snapshots: Pool | undefined;
  private readonly context = new AsyncLocalStorage<TransactionContext>();
  private readonly lane = new AsyncLocalStorage<DatabaseLane>();
  private readonly capacities = new Map<Pool, number>();
  private readonly lastWaitDiagnostic = new Map<string, number>();
  private closing: Promise<void> | undefined;
  private committedHookFailure: ((error: AggregateError) => void) | undefined;
  constructor(private readonly options: DatabaseOptions) {
    const interactive = options.interactiveConnections ?? 6;
    const background = options.backgroundConnections ?? 2;
    const playback = options.playbackConnections ?? 2;
    const snapshots = options.snapshotConnections ?? 4;
    const writer = options.writerConnections ?? 1;
    if (
      ![interactive, background].every((n) => Number.isInteger(n) && n > 0 && n <= 64) ||
      ![playback, snapshots, writer].every((n) => Number.isInteger(n) && n >= 0 && n <= 32)
    )
      throw Error('INVALID_DATABASE_CONNECTION_BUDGET');
    const pool = (lane: DatabaseLane | 'snapshot', max: number): Pool => {
      const result = new Pool({
        ...options.connection,
        max,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        application_name: `st-vault:${lane}`,
      });
      result.on('error', (error: Error & { code?: string }) => {
        const event = {
          event: 'database_idle_connection_error',
          lane,
          code: error.code ?? 'UNKNOWN',
        };
        if (options.report) options.report(event);
        else console.error(JSON.stringify(event));
      });
      this.capacities.set(result, max);
      return result;
    };
    this.pools = {
      interactive: pool('interactive', interactive),
      background: pool('background', background),
      playback: undefined,
      writer: undefined,
    };
    this.snapshots = snapshots ? pool('snapshot', snapshots) : undefined;
    if (playback) this.pools.playback = pool('playback', playback);
    if (writer) this.pools.writer = pool('writer', writer);
  }
  /** Execution priority follows the entire read handler, including bare statements. */
  inLane<T>(lane: DatabaseLane, action: () => Promise<T>): Promise<T> {
    return this.lane.run(lane, action);
  }
  /** Create independent async resources without inheriting a borrowed client.
   * Keep the resource lane: background scheduling must stay background. */
  detached<T>(action: () => T): T {
    return this.context.exit(action);
  }
  private currentTransaction(): TransactionContext | undefined {
    const current = this.context.getStore();
    if (current && !current.active) throw Error('DATABASE_TRANSACTION_CONTEXT_EXPIRED');
    return current;
  }
  private executionPool(lane: DatabaseLane): Pool {
    const pool = this.pools[lane];
    if (!pool) throw Error('DATABASE_LANE_UNAVAILABLE');
    return pool;
  }
  private async acquire(pool: Pool, lane: DatabaseLane | 'snapshot'): Promise<PoolClient> {
    const started = performance.now(),
      client = await pool.connect(),
      waitMs = performance.now() - started;
    if (
      waitMs >= 100 &&
      performance.now() - (this.lastWaitDiagnostic.get(lane) ?? -Infinity) >= 10000
    ) {
      this.lastWaitDiagnostic.set(lane, performance.now());
      const event = {
        event: 'database_pool_wait',
        lane,
        code: 'POOL_WAIT',
        waitMs,
        capacity: this.capacities.get(pool)!,
        active: pool.totalCount - pool.idleCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
      if (this.options.report) this.options.report(event);
      else console.warn(JSON.stringify(event));
    }
    return client;
  }
  private async queryOn<Row extends QueryResultRow>(
    client: PoolClient,
    sql: string,
    values: unknown[],
    lane: DatabaseLane,
  ): Promise<QueryResult<Row>> {
    const started = performance.now();
    try {
      return await client.query<Row>(sql, values);
    } finally {
      const executionMs = performance.now() - started,
        key = 'query:' + lane;
      if (
        executionMs >= 500 &&
        performance.now() - (this.lastWaitDiagnostic.get(key) ?? -Infinity) >= 10000
      ) {
        this.lastWaitDiagnostic.set(key, performance.now());
        const event = { event: 'database_query_slow', lane, code: 'SLOW_QUERY', executionMs };
        if (this.options.report) this.options.report(event);
        else console.warn(JSON.stringify(event));
      }
    }
  }
  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
    lane: DatabaseLane = this.lane.getStore() ?? 'interactive',
  ): Promise<Row[]> {
    return (await this.execute<Row>(sql, values, lane)).rows;
  }
  async execute<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
    lane: DatabaseLane = this.lane.getStore() ?? 'interactive',
  ): Promise<QueryResult<Row>> {
    const current = this.currentTransaction();
    if (this.closing && !current) throw Error('DATABASE_CLOSING');
    if (current) return this.queryOn<Row>(current.client, sql, [...values], current.lane);
    const client = await this.acquire(this.executionPool(lane), lane);
    try {
      return await this.queryOn<Row>(client, sql, [...values], lane);
    } finally {
      client.release();
    }
  }
  async snapshot(): Promise<PoolClient> {
    this.currentTransaction();
    if (this.closing) throw Error('DATABASE_CLOSING');
    if (!this.snapshots) throw Error('DATABASE_SNAPSHOT_UNAVAILABLE');
    const client = await this.acquire(this.snapshots, 'snapshot');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
  async transaction<T>(
    action: () => Promise<T>,
    options: { lane?: DatabaseLane; readOnly?: boolean; repeatableRead?: boolean } = {},
  ): Promise<T> {
    const parent = this.currentTransaction();
    if (parent) {
      if (parent.readOnly && options.readOnly === false)
        throw Error('DATABASE_READ_ONLY_TRANSACTION');
      return action();
    }
    if (this.closing) throw Error('DATABASE_CLOSING');
    const lane = options.lane ?? this.lane.getStore() ?? 'interactive';
    const client = await this.acquire(this.executionPool(lane), lane);
    let discard = false;
    let context: TransactionContext | undefined;
    try {
      // Background work cannot hold a recording write indefinitely; callers
      // retry durable jobs, never replay an arbitrary transaction callback. Send
      // the fixed setup in one simple-query message, preserving statement order.
      await client.query(
        `BEGIN ISOLATION LEVEL ${options.repeatableRead ? 'REPEATABLE READ' : 'READ COMMITTED'} ${options.readOnly ? 'READ ONLY' : 'READ WRITE'}; SET LOCAL lock_timeout = '3s'; SET LOCAL idle_in_transaction_session_timeout = '30s'${options.readOnly && (lane === 'interactive' || lane === 'playback') ? "; SET LOCAL statement_timeout = '15s'" : ''}`,
      );
      context = {
        active: true,
        client,
        lane,
        readOnly: options.readOnly ?? false,
        committed: [],
      };
      let value: T;
      try {
        value = await this.context.run(context, action);
      } finally {
        // The callback owns the client only while awaited. Timers and detached
        // promises must not append queries during COMMIT/ROLLBACK or after release.
        context.active = false;
      }
      const commit = await client.query('COMMIT');
      // PostgreSQL answers ROLLBACK instead of throwing if a caller caught an
      // earlier SQL error inside the transaction. Never acknowledge that as success.
      if (commit.command === 'ROLLBACK') throw Error('DATABASE_TRANSACTION_ABORTED');
      const hookErrors: unknown[] = [];
      for (const action of context.committed) {
        try {
          action();
        } catch (error) {
          hookErrors.push(error);
        }
      }
      if (hookErrors.length) {
        const failure = new AggregateError(hookErrors, 'DATABASE_AFTER_COMMIT_HOOK_FAILED');
        console.error('database_after_commit_hook_failed', failure);
        try {
          this.committedHookFailure?.(failure);
        } catch (recoveryError) {
          console.error('database_after_commit_recovery_failed', recoveryError);
          // Persistence has succeeded. A broken cache owner must restart rather
          // than return a fictional rollback or continue serving stale views.
          queueMicrotask(() => {
            throw new AggregateError([failure, recoveryError], 'DATABASE_COMMITTED_CACHE_FAILURE');
          });
        }
      }
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], 'DATABASE_TRANSACTION_RECOVERY_FAILED');
      }
      throw error;
    } finally {
      if (context) context.active = false;
      client.release(discard);
    }
  }
  stats(): Record<DatabaseLane | 'snapshot', { total: number; idle: number; waiting: number }> {
    const stats = (pool: Pool | undefined) => ({
      total: pool?.totalCount ?? 0,
      idle: pool?.idleCount ?? 0,
      waiting: pool?.waitingCount ?? 0,
    });
    return {
      interactive: stats(this.pools.interactive),
      background: stats(this.pools.background),
      playback: stats(this.pools.playback),
      writer: stats(this.pools.writer),
      snapshot: stats(this.snapshots),
    };
  }
  get inTransaction(): boolean {
    return this.context.getStore()?.active === true;
  }
  afterCommit(action: () => void): void {
    const context = this.currentTransaction();
    if (context) context.committed.push(action);
    else action();
  }
  onCommittedHookFailure(action: (error: AggregateError) => void): void {
    this.committedHookFailure = action;
  }
  commitHookPosition(): number {
    const context = this.currentTransaction();
    if (!context) throw Error('DATABASE_TRANSACTION_REQUIRED');
    return context.committed.length;
  }
  rollbackCommitHooks(position: number): void {
    const context = this.currentTransaction();
    if (!context) throw Error('DATABASE_TRANSACTION_REQUIRED');
    if (!Number.isInteger(position) || position < 0 || position > context.committed.length)
      throw Error('INVALID_COMMIT_HOOK_POSITION');
    context.committed.length = position;
  }
  close(): Promise<void> {
    this.closing ??= Promise.all(
      [...Object.values(this.pools), this.snapshots]
        .filter((pool): pool is Pool => pool !== undefined)
        .map((pool) => pool.end()),
    ).then(() => undefined);
    return this.closing;
  }
}
