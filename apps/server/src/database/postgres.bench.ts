/** Isolated historical-metadata benchmark. Never opens an archive or touches media files. */
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { fileHashAsync } from '../library/files.js';
import { EmbeddedPostgres } from './embedded.js';
import { SqlDatabase } from './sql.js';
import { importSqlite } from './import-sqlite.js';
import { initializeCatalogSchema } from './catalog-schema.js';
import { MediaSelectionStore } from '../archive/media-selection-store.js';

type Row = Record<string, unknown>;
export interface Sample {
  subject: string;
  end: number;
  revision: number;
  unitId: string;
}
export interface Query {
  name: string;
  sqlite: string;
  postgres?: string;
  values: (sample: Sample) => (string | number)[];
}
export interface Executor {
  read: (sql: string, values: (string | number)[]) => Promise<Row[]>;
  step: () => Promise<void>;
}
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const progress = (stage: string, detail: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ event: 'database_benchmark', stage, ...detail }));
const resource = async () => {
  const fields = async (file: string) =>
    Object.fromEntries(
      (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => {
          const [key, value] = line.split(' ');
          return [key, Number(value)];
        }),
    );
  return {
    cpu: (await fields('/sys/fs/cgroup/cpu.stat')).usage_usec,
    memory: Number(await readFile('/sys/fs/cgroup/memory.current', 'utf8')),
    anon: (await fields('/sys/fs/cgroup/memory.stat')).anon,
  };
};
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
};
const canonical = (rows: Row[]) =>
  JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((key) => [key, row[key]]),
      ),
    ),
  );
export const metadataQueries: Query[] = [
  {
    name: 'timeline_day',
    sqlite: `SELECT s.id,s.start,s."end",s.json FROM visible_segments s
    WHERE s.subject=? AND s.deleted=0 AND s.start>? AND s.start<? AND s."end">? AND s.created_revision<=?
    ORDER BY s.start,s.id LIMIT 256`,
    values: (s) => [s.subject, s.end - 2 * 86400000, s.end, s.end - 86400000, s.revision],
  },
  {
    name: 'coverage_week',
    sqlite: `SELECT CAST(((minute-?)*?)/(1.0*?) AS INTEGER) AS bucket,
    sum(covered_ms) AS covered_ms,sum(count) AS count FROM coverage_minutes
    WHERE subject=? AND minute>=? AND minute<? AND covered_ms>0 GROUP BY bucket ORDER BY bucket`,
    postgres: `SELECT floor(((minute-?)*?)/(1.0*?))::bigint AS bucket,
    sum(covered_ms)::bigint AS covered_ms,sum(count)::bigint AS count FROM coverage_minutes
    WHERE subject=? AND minute>=? AND minute<? AND covered_ms>0 GROUP BY bucket ORDER BY bucket`,
    values: (s) => [
      s.end - 7 * 86400000,
      1000,
      7 * 86400000,
      s.subject,
      s.end - 7 * 86400000,
      s.end,
    ],
  },
  {
    name: 'snapshot_units_30m',
    sqlite: `SELECT u.id,u.start,u."end",u.sample,u.closed FROM recording_units u
    WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">? AND u.deleted=0
    AND EXISTS(SELECT 1 FROM unit_segments m JOIN visible_segments s ON s.id=m.segment WHERE m.unit=u.id AND s.deleted=0)
    ORDER BY u.start,u.id LIMIT 256`,
    postgres: `SELECT u.id,u.start,u."end",u.sample,u.closed FROM visible_recording_units u
      WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">? ORDER BY u.start,u.id LIMIT 256`,
    values: (s) => [s.subject, s.end - 1800000 - 86460000, s.end, s.end - 1800000],
  },
  {
    name: 'locate',
    sqlite: `SELECT s.id,s.start,s."end",s.json FROM visible_segments s
    WHERE s.subject=? AND s.deleted=0 AND s.start>? AND s.start<=? AND s."end">? ORDER BY s.start DESC,s.id LIMIT 1`,
    values: (s) => [s.subject, s.end - 900000 - 86400000, s.end - 900000, s.end - 900000],
  },
  {
    name: 'selection_left_week',
    sqlite: `SELECT u.id,u.start,u."end" FROM recording_units u
    WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">? AND u.deleted=0
    AND EXISTS(SELECT 1 FROM unit_segments m JOIN visible_segments s ON s.id=m.segment
      WHERE m.unit=u.id AND s.deleted=0 AND s.start<? AND s."end">?) ORDER BY u.start,u.id LIMIT 1`,
    postgres: `SELECT u.id,u.start,u."end" FROM visible_recording_units u
      WHERE u.subject=? AND u.start>? AND u.start<? AND u."end">?
      AND EXISTS(SELECT 1 FROM unit_segments m JOIN segments s ON s.id=m.segment
        WHERE m.unit=u.id AND s.deleted=0 AND s.start<? AND s."end">?) ORDER BY u.start,u.id LIMIT 1`,
    values: (s) => [
      s.subject,
      s.end - 7 * 86400000 - 86460000,
      s.end,
      s.end - 7 * 86400000,
      s.end,
      s.end - 7 * 86400000,
    ],
  },
  {
    name: 'representative_frame',
    sqlite: `WITH candidates AS MATERIALIZED(
      SELECT s.id,s.json,s.deleted FROM unit_segments m JOIN segments s ON s.id=m.segment
      WHERE m.unit=? AND s.subject=? ORDER BY s.start,s.id)
      SELECT c.json FROM candidates c WHERE c.deleted=0 AND EXISTS(SELECT 1 FROM visible_segments v WHERE v.id=c.id) LIMIT 1`,
    postgres: `SELECT s.json FROM visible_recording_units u JOIN unit_segments m ON m.unit=u.id
      JOIN segments s ON s.id=m.segment WHERE u.id=? AND u.subject=? AND s.deleted=0 ORDER BY s.start,s.id LIMIT 1`,
    values: (s) => [s.unitId, s.subject],
  },
];
export async function measureMetadataWorkload(
  executor: Executor,
  engine: 'sqlite' | 'postgres',
  samples: Sample[],
  mixed: boolean,
  rounds = 200,
  queries = metadataQueries,
) {
  const start = performance.now(),
    before = await resource();
  let memory = before.memory,
    anon = before.anon;
  const timings = Object.fromEntries(queries.map((query) => [query.name, [] as number[]]));
  const cases = Object.fromEntries(
    queries.map((query) => [query.name, samples.map(() => [] as number[])]),
  );
  const record = (query: Query, sample: Sample, elapsed: number) => {
    if (timings[query.name].length < 10000) timings[query.name].push(elapsed);
    const values = cases[query.name][samples.indexOf(sample)];
    if (values.length < 10000) values.push(elapsed);
  };
  let operations = 0,
    steps = 0;
  const read = async (query: Query, sample: Sample) =>
    executor.read(
      engine === 'postgres' ? (query.postgres ?? query.sqlite) : query.sqlite,
      query.values(sample),
    );
  if (!mixed) {
    for (let round = 0; round < rounds || performance.now() - start < 5000; round++) {
      for (const query of queries) {
        const selected = samples[round % samples.length],
          began = performance.now();
        await read(query, selected);
        record(query, selected, performance.now() - began);
        operations++;
      }
      if (round % 32 === 0) {
        const current = await resource();
        memory = Math.max(memory, current.memory);
        anon = Math.max(anon, current.anon);
      }
    }
  } else {
    for (let wave = 0; wave < Math.max(60, Math.ceil(rounds / 3)); wave++) {
      const jobs = Array.from({ length: 15 }, (_, index) => ({
        query: queries[(wave * 15 + index) % queries.length],
        sample: samples[(wave + index) % samples.length],
      }));
      const began = performance.now();
      if (engine === 'sqlite') {
        // The previous worker batches at most 16 messages; any write makes the
        // batch one transaction and all replies wait for its commit barrier.
        await executor.step();
        for (const job of jobs) await read(job.query, job.sample);
        const elapsed = performance.now() - began;
        for (const job of jobs) record(job.query, job.sample, elapsed);
      } else {
        const background = executor.step();
        await Promise.all(
          jobs.map(async (job) => {
            await read(job.query, job.sample);
            record(job.query, job.sample, performance.now() - began);
          }),
        );
        await background;
      }
      operations += jobs.length;
      steps++;
      const current = await resource();
      memory = Math.max(memory, current.memory);
      anon = Math.max(anon, current.anon);
    }
  }
  const after = await resource();
  return {
    layer: mixed
      ? 'SQL dispatcher model; old serial batch versus new concurrent pools; excludes IPC and media journal fsync'
      : 'direct SQL; warmed database and prepared driver path',
    elapsedMs: performance.now() - start,
    operations,
    backgroundSteps: steps,
    cpuMs: (after.cpu - before.cpu) / 1000,
    memoryCurrentStart: before.memory,
    memoryCurrentPeak: memory,
    anonymousMemoryPeak: anon,
    queries: Object.fromEntries(
      queries.map((query) => [query.name, summarize(timings[query.name])]),
    ),
    cases: Object.fromEntries(
      queries.map((query) => [
        query.name,
        cases[query.name].map((values, index) => ({ case: index + 1, ...summarize(values) })),
      ]),
    ),
  };
}
export async function runBenchmark(): Promise<void> {
  const argumentsMap = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    if (
      !['--source', '--legacy-selection', '--report', '--rounds', '--hold'].includes(
        process.argv[index],
      ) ||
      !process.argv[index + 1]
    )
      throw Error('INVALID_BENCHMARK_ARGUMENT');
    argumentsMap.set(process.argv[index], process.argv[index + 1]);
  }
  const source = argumentsMap.get('--source'),
    legacyModule = argumentsMap.get('--legacy-selection'),
    reportFile = argumentsMap.get('--report');
  const rounds = Number(argumentsMap.get('--rounds') ?? 200);
  if (!source || !legacyModule || !reportFile || !Number.isSafeInteger(rounds) || rounds < 100)
    throw Error('BENCHMARK_ARGUMENT_REQUIRED');
  const root = await mkdtemp(path.join(tmpdir(), 'stv-pg-performance-'));
  const queries = metadataQueries;
  let server: EmbeddedPostgres | undefined,
    pg: SqlDatabase | undefined,
    sqlite: DatabaseSync | undefined;
  try {
    const frozen = path.join(root, 'frozen.sqlite'),
      working = path.join(root, 'sqlite-working.sqlite');
    progress('copy_frozen_snapshot');
    await copyFile(source, frozen);
    const hash = await fileHashAsync(frozen);
    await copyFile(frozen, working);
    sqlite = new DatabaseSync(working);
    sqlite.exec(
      'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA cache_size=-32768;PRAGMA busy_timeout=5000',
    );
    const counts = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => ({
        table: String(row.name),
        rows: Number(
          sqlite!.prepare(`SELECT count(*) AS count FROM ${quote(String(row.name))}`).get()!.count,
        ),
      }));
    const revision = Number(
      sqlite.prepare('SELECT revision FROM counters WHERE id=1').get()!.revision,
    );
    const samples = sqlite
      .prepare(
        `SELECT subject,max("end") AS ending FROM segments WHERE deleted=0 AND start IS NOT NULL GROUP BY subject ORDER BY count(*) DESC LIMIT 8`,
      )
      .all()
      .map((row) => ({
        subject: String(row.subject),
        end: Math.ceil(Number(row.ending) / 60000) * 60000,
        revision,
        unitId: String(
          sqlite!
            .prepare(
              'SELECT id FROM recording_units WHERE subject=? AND deleted=0 ORDER BY start DESC,id LIMIT 1',
            )
            .get(String(row.subject))?.id ?? '',
        ),
      }));
    if (!samples.length) throw Error('BENCHMARK_REQUIRES_RECORDED_HISTORY');
    progress('source_profile', {
      sha256: hash,
      tables: counts.length,
      rows: counts.reduce((sum, row) => sum + row.rows, 0),
      subjects: samples.length,
    });
    const legacy = (await import(pathToFileURL(path.resolve(legacyModule)).href)) as {
      MediaSelectionStore: new (
        db: DatabaseSync,
        revision: () => number,
      ) => {
        begin(subject: string, window: { fromMs: number; toMs: number }, mode: string): string;
        build(subject: string, id: string): boolean;
      };
    };
    const oldSelections = new legacy.MediaSelectionStore(sqlite, () => revision);
    let oldSelection = '';
    const sample = samples[0];
    const sqliteExecutor: Executor = {
      read: (sql, values) => Promise.resolve(sqlite!.prepare(sql).all(...values)),
      step: () => {
        sqlite!.exec('BEGIN IMMEDIATE');
        try {
          if (!oldSelection)
            oldSelection = oldSelections.begin(
              sample.subject,
              { fromMs: sample.end - 7 * 86400000, toMs: sample.end },
              'unliked',
            );
          if (!oldSelections.build(sample.subject, oldSelection)) oldSelection = '';
          sqlite!.exec('COMMIT');
          return Promise.resolve();
        } catch (error) {
          sqlite!.exec('ROLLBACK');
          throw error;
        }
      },
    };
    const equivalence = [];
    for (const [index, selected] of samples.entries())
      for (const query of queries)
        equivalence.push({
          case: index,
          name: query.name,
          values: await sqliteExecutor.read(query.sqlite, query.values(selected)),
        });
    progress('sqlite_direct');
    const sqliteDirect = await measureMetadataWorkload(
      sqliteExecutor,
      'sqlite',
      samples,
      false,
      rounds,
    );
    progress('sqlite_mixed_dispatch');
    const sqliteMixed = await measureMetadataWorkload(
      sqliteExecutor,
      'sqlite',
      samples,
      true,
      rounds,
    );
    sqlite.close();
    sqlite = undefined;
    await rm(working);
    await rm(working + '-wal', { force: true });
    await rm(working + '-shm', { force: true });
    progress('postgres_boot');
    server = await EmbeddedPostgres.open({
      root: path.join(root, 'state'),
      binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    });
    process.env.STV_DATABASE_SOCKET = server.connection.host;
    if (typeof server.connection.password !== 'string') throw Error('BENCHMARK_PASSWORD_REQUIRED');
    process.env.STV_DATABASE_PASSWORD = server.connection.password;
    pg = await SqlDatabase.open(path.join(root, 'catalog'));
    await initializeCatalogSchema(pg, Date.now());
    const staged = pg.schema + '_source',
      importStarted = performance.now();
    progress('postgres_import');
    const imported = await importSqlite({
      db: pg.postgres,
      source: frozen,
      schema: staged,
      progress: (item) => {
        if (item.completed)
          progress('postgres_import_table', { table: item.table, rows: item.rows });
      },
    });
    const sourceTables = counts
      .map((row) => row.table)
      .filter((table) => table !== 'library_state');
    const foreign = await pg
      .prepare(
        `SELECT c.conname AS constraint,t.relname AS relation FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=? AND c.contype='f' AND NOT c.condeferrable`,
      )
      .all<{ constraint: string; relation: string }>(pg.schema);
    if (foreign.length) throw Error('BENCHMARK_TARGET_HAS_NONDEFERRED_FOREIGN_KEYS');
    await pg.transaction(async () => {
      await pg!.exec('SET CONSTRAINTS ALL DEFERRED');
      for (const table of sourceTables) await pg!.exec(`DELETE FROM ${quote(table)}`);
      for (const table of sourceTables) {
        const columns = sqliteColumns(frozen, table);
        const fields = columns.map(quote).join(',');
        await pg!.exec(
          `INSERT INTO ${quote(table)}(${fields}) SELECT ${fields} FROM ${quote(staged)}.${quote(table)}`,
        );
      }
    });
    const analyzeTables = await pg
      .prepare('SELECT tablename AS name FROM pg_tables WHERE schemaname=?')
      .all<{ name: string }>(pg.schema);
    for (const table of analyzeTables) await pg.exec('ANALYZE ' + quote(table.name));
    const importMs = performance.now() - importStarted;
    const pgCounts = [];
    for (const table of sourceTables) {
      const row = await pg
        .prepare(`SELECT count(*) AS count FROM ${quote(table)}`)
        .get<{ count: number }>();
      pgCounts.push({ table, rows: row!.count });
    }
    for (const row of pgCounts)
      if (counts.find((item) => item.table === row.table)?.rows !== row.rows)
        throw Error('BENCHMARK_IMPORT_COUNT_MISMATCH');
    const selections = new MediaSelectionStore(pg, () => Promise.resolve(revision));
    let selected = '';
    const pgExecutor: Executor = {
      read: (sql, values) => pg!.prepare(sql).all(...values),
      step: () =>
        pg!.postgres.transaction(
          async () => {
            if (!selected)
              selected = await selections.begin(
                sample.subject,
                { fromMs: sample.end - 7 * 86400000, toMs: sample.end },
                'unliked',
              );
            if (!(await selections.build(sample.subject, selected))) selected = '';
          },
          { lane: 'background' },
        ),
    };
    for (const expected of equivalence) {
      const query = queries.find((query) => query.name === expected.name)!;
      const actual = await pgExecutor.read(
        query.postgres ?? query.sqlite,
        query.values(samples[expected.case]),
      );
      if (canonical(actual) !== canonical(expected.values))
        throw Error('BENCHMARK_RESULT_MISMATCH_' + query.name.toUpperCase());
    }
    progress('postgres_direct');
    const postgresDirect = await measureMetadataWorkload(
      pgExecutor,
      'postgres',
      samples,
      false,
      rounds,
    );
    progress('postgres_mixed_dispatch');
    const postgresMixed = await measureMetadataWorkload(
      pgExecutor,
      'postgres',
      samples,
      true,
      rounds,
    );
    const plans: Record<string, unknown> = {};
    for (const query of queries) {
      plans[query.name] = await pg
        .prepare('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + (query.postgres ?? query.sqlite))
        .all(...query.values(sample));
    }
    const casePlans = [];
    for (const [index, selected] of samples.entries()) {
      const query = queries.find((query) => query.name === 'snapshot_units_30m')!;
      casePlans.push({
        case: index + 1,
        plan: await pg
          .prepare('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + (query.postgres ?? query.sqlite))
          .all(...query.values(selected)),
      });
    }
    const report = {
      format: 1,
      source: { sha256: hash, counts, sampledSubjects: samples.length },
      environment: {
        node: process.version,
        postgres: '18',
        platform: process.platform,
        rounds,
        storage:
          'Both database query workloads use this container Linux temporary filesystem; original snapshot is read-only; caches are warmed; no cache-drop or user-perceived latency claim',
      },
      import: { ...imported, elapsedMs: importMs },
      results: {
        sqlite: { direct: sqliteDirect, mixedDispatcher: sqliteMixed },
        postgres: { direct: postgresDirect, mixedDispatcher: postgresMixed },
      },
      plans,
      casePlans,
    };
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    progress('complete', { report: reportFile, sha256: hash });
    if (argumentsMap.get('--hold') === '1') {
      progress('holding_isolated_database');
      await new Promise<void>((resolve) => {
        process.once('SIGTERM', () => resolve());
        process.once('SIGINT', () => resolve());
      });
    }
  } finally {
    sqlite?.close();
    await pg?.close();
    await server?.close();
    if (!path.basename(root).startsWith('stv-pg-performance-'))
      throw Error('UNSAFE_BENCHMARK_CLEANUP');
    await rm(root, { recursive: true, force: true });
  }
}
function sqliteColumns(filename: string, table: string): string[] {
  const input = new DatabaseSync(filename, { readOnly: true });
  try {
    return input
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => String(row.name));
  } finally {
    input.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runBenchmark();
