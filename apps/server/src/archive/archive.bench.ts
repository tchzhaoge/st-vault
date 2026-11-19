/** Synthetic metadata benchmark only: no network, credentials, or real media.
 * Run: node --import tsx apps/server/src/archive/archive.bench.ts [row-count]
 * Always creates and removes its own temporary root; accepts no data path.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform } from 'node:os';
import path from 'node:path';
import { SqlDatabase } from '../database/sql.js';
import { EmbeddedPostgres } from '../database/embedded.js';
import { performance } from 'node:perf_hooks';
import { openArchive } from './index.js';
import { libraryIndexPath } from '../library/paths.js';
import type { Segment } from '@st-vault/api-schema';

const rows = Number(process.argv[2] ?? 1000000);
const repeats = Number(process.argv[3] ?? 0);
if (!Number.isSafeInteger(rows) || rows < 1000 || rows > 2000000)
  throw new Error('ROW_COUNT_MUST_BE_1000_TO_2000000');
if (!Number.isSafeInteger(repeats) || repeats < 0 || repeats > 10000)
  throw new Error('REPEATS_MUST_BE_0_TO_10000');
const root = await mkdtemp(path.join(tmpdir(), 'stv-metadata-bench-'));
const subjectId = 'stripchat:123';
const base = Date.UTC(2026, 0, 1);
let embedded: EmbeddedPostgres | undefined;
if (!process.env.STV_DATABASE_SOCKET || !process.env.STV_DATABASE_PASSWORD) {
  embedded = await EmbeddedPostgres.open({
    root: path.join(root, 'engine'),
    binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
  });
  process.env.STV_DATABASE_SOCKET = String(embedded.connection.host);
  process.env.STV_DATABASE_PASSWORD = String(embedded.connection.password);
}
let archive = await openArchive({ root }).catch(async (error: unknown) => {
  try {
    await embedded?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  throw error;
});
const namespace = libraryIndexPath(root);
try {
  await archive.upsertSubjects([{ id: subjectId, providerId: 123, handle: 'synthetic-benchmark' }]);
  await archive.close();
  const seedStarted = performance.now();
  const db = await SqlDatabase.open(namespace);
  let pending: {
    id: string;
    subject: string;
    epoch: string;
    sequence: string;
    media: string;
    start: number;
    end: number;
    json: string;
    created_revision: number;
  }[] = [];
  let minutes: {
    subject: string;
    minute: number;
    spans: string;
    starts: string;
    ends: string;
    count: number;
    covered_ms: number;
    start_count: number;
    end_count: number;
  }[] = [];
  const flush = async () => {
    if (!pending.length) return;
    await db.transaction(async () => {
      // This benchmark deliberately seeds only its disposable hot projection.
      await db.exec("SET LOCAL stv.replay='on'");
      await db
        .prepare(
          `INSERT INTO segments(id,subject,epoch,sequence,media,start,"end",json,created_revision)
        SELECT id,subject,epoch,sequence,media,start,"end",json,created_revision
        FROM json_to_recordset(?::json) AS r(id TEXT,subject TEXT,epoch TEXT,sequence TEXT,media TEXT,start DOUBLE PRECISION,"end" DOUBLE PRECISION,json TEXT,created_revision BIGINT)`,
        )
        .run(JSON.stringify(pending));
      if (minutes.length)
        await db
          .prepare(
            `INSERT INTO coverage_minutes
        SELECT subject,minute,spans,starts,ends,count,covered_ms,start_count,end_count
        FROM json_to_recordset(?::json) AS r(subject TEXT,minute BIGINT,spans TEXT,starts TEXT,ends TEXT,count BIGINT,covered_ms BIGINT,start_count BIGINT,end_count BIGINT)`,
          )
          .run(JSON.stringify(minutes));
    });
    pending = [];
    minutes = [];
  };
  let spans: number[][] = [],
    starts: number[] = [],
    ends: number[] = [];
  const idFor = (index: number) =>
    '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
  for (let i = 0; i < rows; i++) {
    const id = idFor(i),
      start = base + i * 2000;
    const segment: Segment = {
      id,
      subjectId,
      sourceEpoch: 'synthetic-epoch',
      sourceSequence: String(i),
      mediaObjectId: id,
      initObjectId: null,
      durationSeconds: 1.5,
      wallStartMs: start,
      wallEndMs: start + 1500,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    };
    pending.push({
      id,
      subject: subjectId,
      epoch: segment.sourceEpoch,
      sequence: segment.sourceSequence,
      media: id,
      start,
      end: start + 1500,
      json: JSON.stringify(segment),
      created_revision: 1,
    });
    const offset = (i % 30) * 2000;
    spans.push([offset, offset + 1500]);
    starts.push(offset);
    ends.push(offset + 1500);
    if (i % 30 === 29 || i === rows - 1) {
      minutes.push({
        subject: subjectId,
        minute: base + Math.floor(i / 30) * 60000,
        spans: JSON.stringify(spans),
        starts: JSON.stringify(starts),
        ends: JSON.stringify(ends),
        count: spans.length,
        covered_ms: spans.length * 1500,
        start_count: starts.length,
        end_count: ends.length,
      });
      spans = [];
      starts = [];
      ends = [];
    }
    if (pending.length === 2000) await flush();
    if (i % 200000 === 199999) console.error(JSON.stringify({ seeded: i + 1 }));
  }
  await flush();
  await db.transaction(async () => {
    await db.exec("SET LOCAL stv.replay='on'");
    await db
      .prepare('INSERT INTO source_checkpoints VALUES(?,?,?,?)')
      .run(subjectId, 'synthetic-epoch', String(rows - 1), base + (rows - 1) * 2000);
    await db
      .prepare(
        `INSERT INTO recording_units(id,subject,start,"end",sample,last_start,created_revision,closed,deleted)
      SELECT id,subject,start,LEAST(start+59500,?),start,LEAST(start+58000,?),1,CASE WHEN start+60000>? THEN 0 ELSE 1 END,0
      FROM segments WHERE sequence::bigint%30=0`,
      )
      .run(base + (rows - 1) * 2000 + 1500, base + (rows - 1) * 2000, base + (rows - 1) * 2000);
    await db.exec(`INSERT INTO unit_segments SELECT id,'00000000-0000-4000-8000-'||lpad(to_hex((sequence::bigint/30)*30),12,'0') FROM segments;
      UPDATE unit_index SET ready=1,revision=1;UPDATE counters SET revision=1;ANALYZE segments;ANALYZE coverage_minutes;ANALYZE recording_units;ANALYZE unit_segments`);
  });
  const databaseBytes = (await db
    .prepare(
      `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'`,
    )
    .get<{ bytes: number }>())!.bytes;
  await db.close();
  const seedMs = performance.now() - seedStarted;
  const openStarted = performance.now();
  archive = await openArchive({ root });
  const reopenMs = performance.now() - openStarted;
  const results: Record<string, { p50Ms: number; p95Ms: number; maxMs: number }> = {};
  const measure = async (name: string, task: () => Promise<unknown>): Promise<void> => {
    for (let i = 0; i < 3; i++) await task();
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const begin = performance.now();
      await task();
      times.push(performance.now() - begin);
    }
    times.sort((a, b) => a - b);
    const round = (v: number): number => Math.round(v * 100) / 100;
    results[name] = { p50Ms: round(times[9]), p95Ms: round(times[18]), maxMs: round(times[19]) };
  };
  await measure('coverage31days720buckets', () =>
    archive.coverage(subjectId, base + 137, base + 31 * 86400000, 720),
  );
  await measure('timeline7days2000', () =>
    archive.timeline(subjectId, base + 10 * 86400000, base + 17 * 86400000, 2000),
  );
  const first = await archive.timeline(subjectId, base, base + 7 * 86400000, 2000);
  await measure('timelineSecondStablePage', () =>
    archive.timeline(subjectId, base, base + 7 * 86400000, 2000, first.nextCursor ?? undefined),
  );
  await measure('locateFarFutureGap', () =>
    archive.locate(subjectId, base + 90 * 86400000, 'report'),
  );
  await measure('locateRecentGap', () =>
    archive.locate(subjectId, base + rows * 2000 - 100, 'report'),
  );
  await measure('snapshotUnitRecentGap', () =>
    archive.snapshotUnit!(subjectId, base + rows * 2000 + 60000),
  );
  const coverage = await archive.coverage(subjectId, base, base + 31 * 86400000, 720);
  const sum = coverage.buckets.reduce((n, b) => n + b.coveredMs, 0);
  if (sum !== rows * 1500) throw new Error('BENCHMARK_UNION_MISMATCH');
  const repeated: {
    batches: number;
    firstP95Ms: number;
    lastP95Ms: number;
    rssStartMiB: number;
    rssEndMiB: number;
  } | null = repeats
    ? {
        batches: repeats,
        firstP95Ms: 0,
        lastP95Ms: 0,
        rssStartMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
        rssEndMiB: 0,
      }
    : null;
  if (repeated) {
    const times: number[] = [];
    const toMs = base + rows * 2000,
      fromMs = toMs - 1800000;
    for (let i = 0; i < repeats; i++) {
      const started = performance.now();
      await Promise.all([
        archive.locate(subjectId, toMs - 100, 'report'),
        archive.snapshotPages!(subjectId, fromMs, 1, 30, { fromMs, toMs }),
        archive.timeline(subjectId, fromMs, toMs, 2000),
      ]);
      times.push(performance.now() - started);
    }
    const size = Math.max(1, Math.floor(repeats / 5));
    const p95 = (samples: number[]): number =>
      Math.round(samples.sort((a, b) => a - b)[Math.floor((samples.length - 1) * 0.95)] * 100) /
      100;
    repeated.firstP95Ms = p95(times.slice(0, size));
    repeated.lastP95Ms = p95(times.slice(-size));
    repeated.rssEndMiB = Math.round(process.memoryUsage().rss / 1024 ** 2);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: platform(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
        rows,
        minutes: Math.ceil(rows / 30),
        databaseBytes,
        engine: 'PostgreSQL',
        seedMs: Math.round(seedMs),
        reopenMs: Math.round(reopenMs),
        samples: 20,
        results,
        repeated,
        coveredMs: sum,
        maxTimelineRows: 2000,
        coverageBuckets: coverage.buckets.length,
        rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2),
        scope:
          'Synthetic query benchmark, one subject, 1.5s segments every 2s. No media files or commit/fsync throughput claim.',
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await archive.close();
    const cleanup = await SqlDatabase.open(namespace);
    try {
      await cleanup.exec('DROP SCHEMA "' + cleanup.schema + '" CASCADE');
    } finally {
      await cleanup.close();
    }
  } finally {
    try {
      await embedded?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
