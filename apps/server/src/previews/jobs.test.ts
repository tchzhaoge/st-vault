import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  opendir,
  mkdir,
  open,
  readdir,
} from 'node:fs/promises';
import type { Dir } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqlDatabase } from '../database/sql.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Segment, SnapshotItem, Subject } from '@st-vault/api-schema';
import type { ArchivePort, MediaChange } from '../ports.js';
import { ScreenshotJobs, type SnapshotFrame, type SnapshotJob } from './jobs.js';
import * as statisticsModule from './job-statistics.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    opendir: vi.fn(actual.opendir),
    open: vi.fn(actual.open),
  };
});

type Options = Parameters<typeof ScreenshotJobs.open>[0];
const subject = 'stripchat:42';
const image = Buffer.from([255, 216, 255, 217]);
const subjects: Subject[] = [
  {
    id: subject,
    providerId: 42,
    handle: 'test',
    monitorEnabled: false,
    autoRecord: false,
    providerStatus: 'OFFLINE',
    observedAtMs: null,
  },
];
const fixtures: { root: string; queues: ScreenshotJobs[] }[] = [];
const item = (at: number): SnapshotItem => ({
  unitId: `unit-${at}`,
  open: false,
  atMs: at,
  slotFromMs: at,
  slotToMs: at + 500,
  url: '/snapshot',
  timeBasis: 'source-pdt',
  uncertaintyMs: 0,
});
const frame = (job: SnapshotJob): SnapshotFrame => ({ bytes: image, throughMs: job.end });
const idleArchive = (): Options['archive'] => ({
  listSubjects: () => Promise.resolve([]),
  locate: () => Promise.resolve(null),
  snapshotUnits: () => Promise.resolve({ items: [], cursor: null }),
  snapshotForSegment: () => Promise.resolve(null),
});
const dependencyArchive = (hasMedia: ArchivePort['hasMedia']): Options['archive'] => ({
  ...idleArchive(),
  hasMedia,
  snapshotUnit: (_subject, at, unitId) =>
    Promise.resolve({ ...item(at), unitId: unitId ?? item(at).unitId }),
  locate: () =>
    Promise.resolve({
      id: 'initial',
      subjectId: subject,
      sourceEpoch: 'test',
      sourceSequence: '1',
      mediaObjectId: 'initial-media',
      initObjectId: null,
      durationSeconds: 0.5,
      wallStartMs: 60000,
      wallEndMs: 60500,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    }),
});
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function untilAborted(signal: AbortSignal): Promise<SnapshotFrame> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(new Error('interrupted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
async function fixture(overrides: Partial<Options> = {}): Promise<{
  root: string;
  queue: ScreenshotJobs;
  reopen: (options?: Partial<Options>) => Promise<ScreenshotJobs>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-screenshot-jobs-test-'));
  const entry = { root, queues: [] as ScreenshotJobs[] };
  fixtures.push(entry);
  const options: Options = {
    root,
    archive: idleArchive(),
    render: (job) => Promise.resolve(frame(job)),
    validate: () => Promise.resolve(),
    pollMs: 5,
    auditMs: 60000,
    ...overrides,
  };
  const reopen = async (changes: Partial<Options> = {}): Promise<ScreenshotJobs> => {
    const queue = await ScreenshotJobs.open({ ...options, ...changes });
    entry.queues.push(queue);
    return queue;
  };
  return { root, queue: await reopen(), reopen };
}
const done = (queue: ScreenshotJobs, count = 1): Promise<void> =>
  vi.waitFor(
    () => {
      expect(queue.status().completed).toBe(count);
    },
    { interval: 5, timeout: 3000 },
  );
const filename = (root: string, at = 60000, unitId = `unit-${at}`): string =>
  path.join(
    root,
    '42',
    `${at}-${at + 500}-${createHash('sha256').update(unitId).digest('hex')}.jpg`,
  );

it('retries new input immediately without resetting backoff for repeated observations', async () => {
  const render = vi.fn((job: SnapshotJob) =>
    render.mock.calls.length === 1
      ? Promise.reject(Error('no frame yet'))
      : Promise.resolve(frame(job)),
  );
  const { root, queue } = await fixture({ render, retryMs: 60000 });
  await queue.enqueue(subject, { ...item(60000), imageToMs: 60500 });
  await vi.waitFor(() => expect(queue.status().failed).toBe(1));
  await queue.enqueue(subject, { ...item(60000), imageToMs: 60500 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(render).toHaveBeenCalledOnce();
  await queue.enqueue(subject, { ...item(60000), imageToMs: 60500, slotToMs: 61000 });
  await done(queue);
  expect(render).toHaveBeenCalledTimes(2);
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  expect(await db.prepare('SELECT coverage_end FROM jobs').get()).toEqual({ coverage_end: 61000 });
  await db.close();
});

it('merges overlapping invalidations into one bounded dependency reconciliation owner', async () => {
  let concurrent = 0,
    maximum = 0;
  const gate = deferred<void>();
  const archive = dependencyArchive(() => Promise.resolve(true));
  archive.snapshotUnit = async (_subject, at) => {
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    await gate.promise;
    concurrent--;
    return item(at);
  };
  const { queue } = await fixture({ archive, canGenerate: () => false });
  await vi.waitFor(() => expect(queue.maintenanceStatus().state).toBe('idle'));
  for (let n = 0; n < 80; n++) await queue.enqueue(subject, item(n * 1000));
  const operations = Array.from({ length: 12 }, () => queue.invalidate(subject, 0, 100000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve();
  await Promise.all(operations);
  expect(maximum).toBeLessThanOrEqual(1);
});

it('gives old ready work progress despite a continuous higher priority backlog', async () => {
  let allowed = false;
  const order: number[] = [];
  const { root, queue } = await fixture({
    canGenerate: () => allowed,
    render: (job) => {
      order.push(job.at);
      return Promise.resolve(frame(job));
    },
  });
  await queue.enqueue(subject, item(0));
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  await db.prepare('UPDATE jobs SET created=? WHERE at=0').run(Date.now() - 60000);
  await db.close();
  for (let n = 1; n <= 12; n++) await queue.enqueue(subject, item(n * 1000), 60);
  allowed = true;
  await done(queue, 13);
  expect(order.indexOf(0)).toBeLessThan(12);
});

it('resumes durable invalidation after shutdown while dependency reconciliation is in flight', async () => {
  const gate = deferred<void>();
  let checking = false;
  const archive = dependencyArchive(() => Promise.resolve(true));
  archive.snapshotUnit = async (_subject, at) => {
    checking = true;
    await gate.promise;
    return item(at);
  };
  const { root, queue, reopen } = await fixture({ archive, canGenerate: () => false });
  await vi.waitFor(() => expect(queue.maintenanceStatus().state).toBe('idle'));
  await queue.enqueue(subject, item(60000));
  const invalidation = queue.invalidate(subject, 0, 100000);
  await vi.waitFor(() => expect(checking).toBe(true));
  const closing = queue.close();
  gate.resolve();
  await Promise.all([closing, invalidation]);
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  expect(await db.prepare('SELECT subject FROM invalidations').all()).toEqual([{ subject }]);
  await db.close();
  const recovered = await reopen({
    archive: { ...archive, snapshotUnit: () => Promise.resolve(null) },
  });
  await vi.waitFor(() => expect(recovered.status().pending).toBe(0));
  await vi.waitFor(() => expect(recovered.maintenanceStatus().pending).toBe(0));
});

it('keeps failed dependency reconciliation durable without mistaking an outage for deleted media', async () => {
  let failing = false,
    present = true;
  const archive = dependencyArchive(() =>
    failing ? Promise.reject(Error('metadata outage')) : Promise.resolve(present),
  );
  const { root, queue } = await fixture({
    archive,
    render: (job) => Promise.resolve({ ...frame(job), mediaIds: ['source'] }),
  });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  failing = true;
  await expect(queue.invalidate(subject, 60000, 60500)).rejects.toThrow('metadata outage');
  expect(queue.status().completed).toBe(1);
  expect(await readFile(filename(root))).toEqual(image);
  expect(queue.maintenanceStatus()).toMatchObject({ state: 'retrying', pending: 1 });
  failing = false;
  present = false;
  await vi.waitFor(() => expect(queue.status().completed).toBe(0), { timeout: 2500, interval: 10 });
  await vi.waitFor(() => expect(queue.maintenanceStatus().pending).toBe(0));
});

it('cleans a canonical sidecar that finishes publishing after its unit was deleted', async () => {
  const { root, queue, reopen } = await fixture({ canGenerate: () => false });
  await queue.close();
  const mediaRoot = path.join(root, 'media');
  await mkdir(path.join(mediaRoot, 'subjects'), { recursive: true });
  const gate = deferred<void>();
  const published = deferred<void>();
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const sidecar = path.join(
    mediaRoot,
    'subjects',
    'stripchat-42',
    'thumbnails',
    '1970-01-01',
    '00',
    path.basename(filename(root)) + '.json',
  );
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to) === sidecar) {
      published.resolve();
      await gate.promise;
    }
    await actual.rename(from, to);
  });
  let present = true;
  const archive = {
    ...idleArchive(),
    snapshotUnit: () => Promise.resolve(present ? item(60000) : null),
  };
  const running = await reopen({ mediaRoot, archive, canGenerate: () => true });
  await running.enqueue(subject, item(60000));
  await published.promise;
  present = false;
  try {
    await running.invalidate(subject, 60000, 60500);
    gate.resolve();
    await vi.waitFor(() => expect(running.status().completed).toBe(0));
    await vi.waitFor(async () => {
      await expect(readFile(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect((await readdir(path.dirname(sidecar))).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  } finally {
    gate.resolve();
  }
});

it.each(['write', 'sync', 'close'] as const)(
  'cleans screenshot %s failures without replacing the previous JPEG',
  async (phase) => {
    const { root, queue } = await fixture({ retryMs: 60000 });
    await queue.enqueue(subject, item(60000));
    await done(queue);
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    const closeHandles: (() => Promise<void>)[] = [];
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      closeHandles.push(file.close.bind(file));
      if (phase === 'write') {
        const write = file.writeFile.bind(file);
        vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
          await write('partial');
          throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
        });
      } else
        vi.spyOn(file, phase).mockRejectedValueOnce(
          Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' }),
        );
      return file;
    });
    try {
      const db = await SqlDatabase.open(path.join(root, 'jobs'));
      await db.exec("UPDATE jobs SET state='pending',due=0");
      await db.close();
      await vi.waitFor(() => expect(queue.status().failed).toBe(1), { interval: 5 });
      expect(await readFile(filename(root))).toEqual(image);
      expect(
        (await readdir(path.join(root, '42'))).filter((file) => file.endsWith('.tmp')),
      ).toHaveLength(0);
    } finally {
      vi.mocked(open).mockReset();
      for (const close of closeHandles) await close();
      await queue.close();
      logs.mockRestore();
    }
  },
);

it('aggregates repeated dependency outages and flushes diagnostics without deleting valid JPEGs', async () => {
  const hasMedia = vi.fn(() => Promise.resolve(true));
  const { queue } = await fixture({
    archive: dependencyArchive(hasMedia),
    render: (job) => Promise.resolve({ ...frame(job), mediaIds: ['initial-media'] }),
  });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  hasMedia.mockRejectedValue(
    Object.assign(new Error('metadata unavailable'), { code: 'METADATA_WORKER_UNAVAILABLE' }),
  );
  try {
    for (let n = 0; n < 1000; n++) expect(await queue.read(subject, 60000, 60500)).toEqual(image);
    expect(logs.mock.calls.length).toBeLessThanOrEqual(1);
    await queue.close();
    const summaries = logs.mock.calls.map(
      ([line]) =>
        JSON.parse(String(line)) as { event: string; occurrences: number; summary?: string },
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toMatchObject({
      event: 'screenshot_dependency_reconciliation_failed',
      summary: 'close',
    });
    expect(summaries.reduce((sum, value) => sum + value.occurrences, 0)).toBeGreaterThanOrEqual(
      1000,
    );
  } finally {
    await queue.close();
    logs.mockRestore();
  }
});

it('closes its database when constructor schema initialization fails', async () => {
  const { root, queue, reopen } = await fixture();
  await queue.close();
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  await db.exec('DROP TABLE job_statistics;CREATE TABLE job_statistics(invalid TEXT)');
  await db.close();
  const close = vi.spyOn(SqlDatabase.prototype, 'close');
  try {
    await expect(reopen()).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    close.mockRestore();
  }
});

it('closes recovery directory cursors and the database if initial retired cleanup fails', async () => {
  const { root, queue, reopen } = await fixture();
  await queue.close();
  await mkdir(path.join(root, '42'), { recursive: true });
  for (let n = 0; n < 64; n++) await writeFile(path.join(root, '42', `unrelated-${n}.dat`), 'keep');
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  await db.prepare('INSERT INTO retired VALUES(?,?,?,?)').run(subject, 60000, 60500, `unit-60000`);
  await db.close();
  const directories: Dir[] = [];
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  vi.mocked(opendir).mockImplementation(async (...args) => {
    const dir = await actual.opendir(...args);
    directories.push(dir);
    return dir;
  });
  vi.mocked(unlink).mockRejectedValue(
    Object.assign(new Error('retired cleanup denied'), { code: 'EACCES' }),
  );
  const close = vi.spyOn(SqlDatabase.prototype, 'close');
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await expect(reopen()).rejects.toMatchObject({ code: 'EACCES' });
    expect(close).toHaveBeenCalledOnce();
    expect(directories.length).toBeGreaterThan(0);
    for (const dir of directories)
      await expect(dir.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
  } finally {
    vi.mocked(unlink).mockReset();
    vi.mocked(opendir).mockReset();
    close.mockRestore();
    logs.mockRestore();
  }
});

it('keeps status exact across render failure, retry, file repair, retirement and restart', async () => {
  let enabled = true;
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  render.mockRejectedValueOnce(new Error('synthetic decode failure'));
  const { root, queue, reopen } = await fixture({
    render,
    retryMs: 60000,
    canGenerate: () => enabled,
  });
  await queue.enqueue(subject, item(60000));
  await vi.waitFor(
    () => expect(queue.status()).toMatchObject({ pending: 0, failed: 1, completed: 0 }),
    { interval: 5 },
  );
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  await db.exec('UPDATE jobs SET due=0');
  await db.close();
  await done(queue);
  expect(queue.status()).toMatchObject({ pending: 0, failed: 0, completed: 1 });
  enabled = false;
  await unlink(filename(root));
  expect(await queue.read(subject, 60000, 60500)).toBeNull();
  expect(queue.status()).toMatchObject({ pending: 1, failed: 0, completed: 0 });
  enabled = true;
  await done(queue);
  enabled = false;
  await queue.invalidate(subject, 60000, 60500);
  expect(queue.status()).toMatchObject({ pending: 0, failed: 0, completed: 0 });
  await queue.enqueue(subject, item(60001));
  expect(queue.status()).toMatchObject({ pending: 1, failed: 0, completed: 0 });
  await queue.invalidate(subject, 60000, 61000);
  expect(queue.status()).toMatchObject({ pending: 0, failed: 0, completed: 0 });
  await queue.enqueue(subject, item(120000));
  await queue.close();
  const recovered = await reopen({ canGenerate: () => false });
  expect(recovered.status()).toMatchObject({ pending: 1, failed: 0, completed: 0 });
});

it('reads status without scanning or sorting the complete screenshot history', async () => {
  const { root, queue } = await fixture({ canGenerate: () => false });
  const prepare = vi.spyOn(SqlDatabase.prototype, 'prepare');
  let queries: string[];
  try {
    expect(queue.status()).toMatchObject({ pending: 0, failed: 0, completed: 0 });
    queries = prepare.mock.calls.map(([sql]) => sql);
  } finally {
    prepare.mockRestore();
  }
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    for (const sql of queries) {
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all())
        .map((row) => String(row.detail))
        .join('\n');
      expect(plan).not.toContain('TEMP B-TREE');
      if (/\bSCAN jobs\b/.test(plan)) expect(sql).toMatch(/LIMIT 1(?:\s*\)|\s*$)/i);
    }
  } finally {
    await db.close();
  }
});

it('selects runnable screenshots without sorting or scanning completed jobs', async () => {
  const { root, queue } = await fixture();
  await queue.close();
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    await db.exec(`INSERT INTO jobs(subject,unit,at,"end",slot,priority,state)
      SELECT 'stripchat:42','plan-'||n,n*1000,n*1000+500,n*1000,0,CASE WHEN n>10000 THEN 'pending' ELSE 'done' END FROM generate_series(1,10010) n;ANALYZE jobs`);
    const plan = (
      await db
        .prepare(
          "EXPLAIN (FORMAT JSON) SELECT * FROM jobs  WHERE state IN ('pending','failed') AND due<=? ORDER BY priority DESC,at DESC LIMIT 1",
        )
        .all(Date.now())
    )
      .map((row) => JSON.stringify(row))
      .join('\n');
    expect(plan).toContain('jobs_ready');
    expect(plan).not.toContain('Seq Scan');
    expect(plan).not.toContain('Sort');
  } finally {
    await db.close();
  }
});

it('validates completed screenshot dependencies without repeating time-range location', async () => {
  const archive = dependencyArchive(() => Promise.resolve(true));
  const locate = vi.fn(archive.locate);
  archive.locate = locate;
  const { queue } = await fixture({
    archive,
    render: (job) => Promise.resolve({ ...frame(job), mediaIds: ['initial-media'] }),
  });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  locate.mockClear();
  expect(await queue.read(subject, 60000, 60500)).toEqual(image);
  expect(locate).not.toHaveBeenCalled();
});

it('refuses a persisted JPEG whose later decode dependency was deleted while its initial segment remains', async () => {
  let available = true;
  const hasMedia = vi.fn(() => Promise.resolve(available));
  const mediaIds = ['initial-media', 'later-media', 'initialization'];
  const render = (job: SnapshotJob): Promise<SnapshotFrame> =>
    Promise.resolve({ ...frame(job), mediaIds });
  const { root, queue, reopen } = await fixture({ archive: dependencyArchive(hasMedia), render });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.close();
  const recovered = await reopen();
  available = false;
  expect(await recovered.read(subject, 60000, 60500)).toBeNull();
  expect(hasMedia).toHaveBeenCalledWith(mediaIds);
  expect(recovered.status()).toMatchObject({ pending: 0, failed: 0, completed: 0 });
  // Restart audit can retire the row before read; physical GC remains asynchronous.
  await vi.waitFor(async () => {
    await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('rejects an audit-retired image immediately while durable physical cleanup is still running', async () => {
  let available = true;
  const { root, queue, reopen } = await fixture({
    archive: dependencyArchive(() => Promise.resolve(available)),
    render: (job) => Promise.resolve({ ...frame(job), mediaIds: ['dependency'] }),
  });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.close();
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const gate = deferred<void>();
  vi.mocked(unlink).mockImplementation(async (file) => {
    if (file === filename(root)) await gate.promise;
    return actual.unlink(file);
  });
  available = false;
  const recovered = await reopen();
  try {
    await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith(filename(root)));
    expect(await recovered.read(subject, 60000, 60500)).toBeNull();
    expect(recovered.status().completed).toBe(0);
    expect(await readFile(filename(root))).toEqual(image);
    gate.resolve();
    await vi.waitFor(async () => {
      await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  } finally {
    gate.resolve();
    await recovered.close();
    vi.mocked(unlink).mockImplementation(actual.unlink);
  }
});

it('persists and checks the maximum supported 600 decode dependencies', async () => {
  const mediaIds = Array.from({ length: 600 }, (_, index) => `media-${index}`);
  const hasMedia = vi.fn(() => Promise.resolve(true));
  const { queue } = await fixture({
    archive: dependencyArchive(hasMedia),
    render: (job) => Promise.resolve({ ...frame(job), mediaIds }),
  });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  expect(await queue.read(subject, 60000, 60500)).toEqual(image);
  expect(hasMedia).toHaveBeenCalledWith(mediaIds);
});

it.each([0, 601])(
  'rejects incomplete or oversized decode dependencies (%s IDs) before publishing',
  async (count) => {
    const mediaIds = Array.from({ length: count }, (_, index) => `media-${index}`);
    const { root, queue } = await fixture({
      archive: dependencyArchive(() => Promise.resolve(true)),
      render: (job) => Promise.resolve({ ...frame(job), mediaIds }),
      retryMs: 60000,
    });
    await queue.enqueue(subject, item(60000));
    await vi.waitFor(
      () => {
        expect(queue.status().failed).toBe(1);
      },
      { interval: 5 },
    );
    expect(await queue.hasCompleted(subject, 60000)).toBe(false);
    await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('preserves a completed JPEG when dependency queries fail instead of reporting deletion', async () => {
  let failing = false;
  const hasMedia = vi.fn(() =>
    failing ? Promise.reject(new Error('archive unavailable')) : Promise.resolve(true),
  );
  const mediaIds = ['later-media', 'initialization'];
  const { root, queue } = await fixture({
    archive: dependencyArchive(hasMedia),
    render: (job) => Promise.resolve({ ...frame(job), mediaIds }),
  });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  failing = true;
  hasMedia.mockClear();
  expect(await queue.read(subject, 60000, 60500)).toEqual(image);
  expect(hasMedia).toHaveBeenCalledWith(mediaIds);
  expect(queue.status().completed).toBe(1);
  expect(await readFile(filename(root))).toEqual(image);
});
it('requires positive dependency evidence before publishing a newly generated JPEG', async () => {
  const { root, queue } = await fixture({
    archive: dependencyArchive(() => Promise.reject(Error('metadata unavailable'))),
    render: (job) => Promise.resolve({ ...frame(job), mediaIds: ['source'] }),
    retryMs: 60000,
  });
  await queue.enqueue(subject, item(60000));
  await vi.waitFor(() => expect(queue.status().failed).toBe(1));
  expect(queue.status().completed).toBe(0);
  await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('keeps completed images whose media survives a sparse deletion envelope', async () => {
  const render = vi.fn((job: SnapshotJob) =>
    Promise.resolve({ ...frame(job), mediaIds: ['surviving-media'] }),
  );
  const { queue } = await fixture({
    archive: dependencyArchive(() => Promise.resolve(true)),
    render,
  });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.invalidate(subject, 0, 180000);
  expect(await queue.read(subject, 60000, 60500)).toEqual(image);
  expect(render).toHaveBeenCalledTimes(1);
});

it('rechecks decode dependencies before marking done when deletion occurs during persistence', async () => {
  let available = true;
  const entered = deferred<void>(),
    release = deferred<void>();
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    entered.resolve();
    await release.promise;
    await actual.rename(from, to);
  });
  const { root, queue } = await fixture({
    archive: dependencyArchive(() => Promise.resolve(available)),
    render: (job) => Promise.resolve({ ...frame(job), mediaIds: ['later-media'] }),
  });
  try {
    await queue.enqueue(subject, item(60000));
    await entered.promise;
    available = false;
    release.resolve();
    await vi.waitFor(
      () => {
        expect(queue.status()).toMatchObject({ pending: 0, failed: 0, completed: 0 });
      },
      { interval: 5 },
    );
    await queue.close();
    await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.resolve();
  }
});

it('rejects a changed immutable decoder boundary without modifying the queued unit', async () => {
  const { root, queue } = await fixture({ canGenerate: () => false });
  await queue.enqueue(subject, item(60000), 10);
  await expect(
    (async () => await queue.enqueue(subject, { ...item(60000), slotToMs: 61000 }, 30))(),
  ).rejects.toThrow('INCONSISTENT_SCREENSHOT_UNIT');
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    expect(await db.prepare('SELECT at,"end",slot,priority FROM jobs').all()).toEqual([
      { at: 60000, end: 60500, slot: 60000, priority: 10 },
    ]);
  } finally {
    await db.close();
  }
});
it('checks only the deleted unit rather than every stable image search window from the preceding day', async () => {
  const last = 1440 * 60000;
  const hasMedia = vi.fn((ids: string[]) => Promise.resolve(ids[0] !== `media-${last}`));
  const { root, queue } = await fixture({
    canGenerate: () => false,
    archive: dependencyArchive(hasMedia),
  });
  // Finish the initial empty-cache audit before seeding synthetic completed rows.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  for (let index = 1; index <= 1440; index++) {
    const at = index * 60000;
    await queue.enqueue(subject, { ...item(at), slotToMs: at + 60000, imageToMs: at + 86460000 });
  }
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    await db.exec("UPDATE jobs SET state='done',media_ids=json_build_array('media-'||slot)::text");
    hasMedia.mockClear();
    await queue.invalidate(subject, last, last + 60000);
    expect(hasMedia).toHaveBeenCalledTimes(1);
    expect(hasMedia).toHaveBeenCalledWith([`media-${last}`]);
    expect(queue.status().completed).toBe(1439);
  } finally {
    await db.close();
  }
});
it('extends unit coverage without replacing its stable image identity or creation time', async () => {
  const { root, queue } = await fixture({ canGenerate: () => false });
  const first = { ...item(61000), open: true, slotToMs: 63000, imageToMs: 86521000 };
  await queue.enqueue(subject, first, 10);
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    const original = await db.prepare('SELECT at,"end",created FROM jobs').get();
    await queue.enqueue(subject, { ...first, slotToMs: 71000 }, 30);
    expect(await db.prepare('SELECT at,"end",created FROM jobs').get()).toEqual(original);
    expect(await db.prepare('SELECT coverage_end,priority,state FROM jobs').get()).toMatchObject({
      coverage_end: 71000,
      priority: 30,
      state: 'pending',
    });
    expect(queue.status().pending).toBe(1);
  } finally {
    await db.close();
  }
});
it('keeps equal sample times in different recording units isolated across render, read, deletion and restart', async () => {
  const available = new Set(['a', 'b']);
  const render = vi.fn((job: SnapshotJob) =>
    Promise.resolve({ ...frame(job), mediaIds: [job.unit] }),
  );
  const { queue, reopen } = await fixture({
    archive: dependencyArchive((ids) => Promise.resolve(ids.every((id) => available.has(id)))),
    render,
  });
  const first = { ...item(60000), unitId: 'a', imageToMs: 86520000 };
  const second = { ...first, unitId: 'b' };
  await queue.enqueue(subject, first);
  await queue.enqueue(subject, second);
  await done(queue, 2);
  expect(render.mock.calls.map(([job]) => job.unit).sort()).toEqual(['a', 'b']);
  expect(await queue.read(subject, 60000, 86520000, 'a')).toEqual(image);
  expect(await queue.read(subject, 60000, 86520000, 'b')).toEqual(image);
  expect(await queue.read(subject, 60000, 86520000)).toBeNull();
  await queue.close();
  const recovered = await reopen();
  available.delete('a');
  await recovered.invalidate(subject, 60000, 60500);
  expect(await recovered.read(subject, 60000, 86520000, 'a')).toBeNull();
  expect(await recovered.read(subject, 60000, 86520000, 'b')).toEqual(image);
  expect(await recovered.hasCompleted(subject, 60000, 'a')).toBe(false);
  expect(await recovered.hasCompleted(subject, 60000, 'b')).toBe(true);
});
it('does not cancel a surviving pending unit when deletion shares another unit sample time', async () => {
  let enabled = false;
  const available = new Set(['a', 'b']);
  const archive = {
    ...idleArchive(),
    snapshotUnit: (_id: string, at: number, unitId?: string) =>
      Promise.resolve(unitId && available.has(unitId) ? { ...item(at), unitId } : null),
  };
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const { queue } = await fixture({ archive, canGenerate: () => enabled, render });
  await queue.enqueue(subject, { ...item(60000), unitId: 'a' });
  await queue.enqueue(subject, { ...item(60000), unitId: 'b' });
  available.delete('a');
  await queue.invalidate(subject, 60000, 60500);
  expect(queue.status()).toMatchObject({ pending: 1, completed: 0 });
  enabled = true;
  await done(queue);
  expect(render.mock.calls.map(([job]) => job.unit)).toEqual(['b']);
});
it('rejects unsupported time-keyed queues without rewriting metadata or image files', async () => {
  const { root, queue, reopen } = await fixture({ canGenerate: () => false });
  await queue.close();
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  await db.exec(
    'DROP TABLE jobs;CREATE TABLE jobs(subject TEXT,at INTEGER,"end" INTEGER,slot INTEGER,priority INTEGER,PRIMARY KEY(subject,at,"end"));\n    INSERT INTO jobs VALUES(\'stripchat:42\',60000,60500,60000,0);',
  );
  await db.close();
  await mkdir(path.join(root, '42'), { recursive: true });
  const old = path.join(root, '42', '60000-60500.jpg');
  await writeFile(old, image);
  await expect(reopen()).rejects.toThrow(/unit|coverage_end/);
  expect(await readFile(old)).toEqual(image);
  const inspected = await SqlDatabase.open(path.join(root, 'jobs'));
  expect(await inspected.prepare('SELECT count(*) count FROM jobs').get()).toEqual({ count: 1 });
  expect(
    await inspected
      .prepare(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() AND tablename='legacy_jobs'",
      )
      .get(),
  ).toBeUndefined();
  await inspected.close();
});
it('rejects unsupported coverage metadata without rewriting a usable unit JPEG', async () => {
  const { root, queue, reopen } = await fixture();
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.close();
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  await db.exec('DROP INDEX jobs_coverage;ALTER TABLE jobs DROP COLUMN coverage_end');
  await db.close();
  await expect(reopen()).rejects.toThrow(/unit|coverage_end/);
  expect(await readFile(filename(root))).toEqual(image);
});
it('requires recording unit identity instead of creating time-keyed screenshot jobs', async () => {
  const { queue } = await fixture({ canGenerate: () => false });
  await expect(
    (async () => await queue.enqueue(subject, { ...item(60000), unitId: '' }))(),
  ).rejects.toThrow('INVALID_SCREENSHOT_UNIT');
  expect(queue.status().pending).toBe(0);
});
it('reports catch-up from queue waiting time instead of the source timestamp and preserves it on duplicate enqueue', async () => {
  const render = vi.fn((_job: SnapshotJob, signal: AbortSignal) => untilAborted(signal));
  const { root, queue } = await fixture({ render });
  await queue.enqueue(subject, item(60000), 30);
  await vi.waitFor(
    () => {
      expect(render).toHaveBeenCalledOnce();
    },
    { interval: 5 },
  );
  expect(queue.status().mode).toBe('realtime');
  await queue.enqueue(subject, item(120000), 0);
  let queued = 0;
  let restoreClock = () => undefined;
  try {
    const db = await SqlDatabase.open(path.join(root, 'jobs'));
    try {
      queued = (await db
        .prepare('SELECT created FROM jobs ORDER BY created LIMIT 1')
        .get<{ created: number }>())!.created;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(queued + 61000);
      restoreClock = () => {
        clock.mockRestore();
        return undefined;
      };
    } finally {
      await db.close();
    }
    expect(queue.status().mode).toBe('catching-up');
    await queue.enqueue(subject, item(60000), 30);
    const checked = await SqlDatabase.open(path.join(root, 'jobs'));
    try {
      expect(await checked.prepare('SELECT created FROM jobs WHERE at=60000').get()).toMatchObject({
        created: queued,
      });
    } finally {
      await checked.close();
    }
    expect(queue.status().mode).toBe('catching-up');
    await queue.invalidate(subject, 60000, 60500);
    expect(queue.status().mode).toBe('catching-up');
  } finally {
    restoreClock();
  }
});

it('rejects a changed sample timestamp while retaining the completed unit and JPEG', async () => {
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const { root, queue } = await fixture({ render });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await expect(
    (async () =>
      await queue.enqueue(subject, { ...item(60300), unitId: 'unit-60000', slotFromMs: 60000 }))(),
  ).rejects.toThrow('INCONSISTENT_SCREENSHOT_UNIT');
  await done(queue);
  await queue.close();
  expect(render).toHaveBeenCalledOnce();
  expect(await readFile(filename(root))).toEqual(image);
  await expect(readFile(filename(root, 60300, 'unit-60000'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    expect(await db.prepare('SELECT at,slot FROM jobs').all()).toEqual([
      { at: 60000, slot: 60000 },
    ]);
  } finally {
    await db.close();
  }
});

it('rejects contradictory unit input without cancelling an in-flight canonical publication', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    entered.resolve();
    await release.promise;
    await actual.rename(from, to);
  });
  const { root, queue } = await fixture();
  try {
    await queue.enqueue(subject, item(60000));
    await entered.promise;
    await expect(
      (async () =>
        await queue.enqueue(subject, {
          ...item(60300),
          unitId: 'unit-60000',
          slotFromMs: 60000,
        }))(),
    ).rejects.toThrow('INCONSISTENT_SCREENSHOT_UNIT');
    release.resolve();
    await done(queue);
    await queue.close();
    expect(await readFile(filename(root))).toEqual(image);
    await expect(readFile(filename(root, 60300, 'unit-60000'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    release.resolve();
  }
});

it('resumes persisted retired-file cleanup on reopen', async () => {
  const { root, queue, reopen } = await fixture();
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.close();
  const duplicate = path.join(
    root,
    '42',
    `60000-61000-${createHash('sha256').update('retired-unit').digest('hex')}.jpg`,
  );
  const interrupted = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    await interrupted
      .prepare('INSERT INTO retired VALUES(?,?,?,?)')
      .run(subject, 60000, 61000, 'retired-unit');
  } finally {
    await interrupted.close();
  }
  await writeFile(duplicate, image);
  await reopen();
  await expect(readFile(duplicate)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('distinguishes a completed canonical frame from a request whose end is too narrow', async () => {
  const { queue } = await fixture();
  expect(await queue.hasCompleted(subject, 60000)).toBe(false);
  await queue.enqueue(subject, item(60000));
  await done(queue);
  expect(await queue.hasCompleted(subject, 60000)).toBe(true);
  expect(await queue.hasCompleted(subject, 60300)).toBe(false);
  expect(await queue.read(subject, 60000, 60499)).toBeNull();
  expect(await queue.hasCompleted(subject, 60000)).toBe(true);
  await queue.invalidate(subject, 60000, 60500);
  expect(await queue.hasCompleted(subject, 60000)).toBe(false);
});

it('reconciles missing source on startup for done, failed and pending jobs without a delete notification', async () => {
  const { root, queue, reopen } = await fixture();
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.close();
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    await db
      .prepare(
        'INSERT INTO jobs(subject,unit,at,"end",slot,priority,state,due) VALUES(?,?,?,?,?,?,\'failed\',?)',
      )
      .run(subject, 'unit-120000', 120000, 120500, 120000, 0, Date.now() + 60000);
    await db
      .prepare(
        'INSERT INTO jobs(subject,unit,at,"end",slot,priority,state) VALUES(?,?,?,?,?,?,\'pending\')',
      )
      .run(subject, 'unit-180000', 180000, 180500, 180000, 0);
    await db.prepare('INSERT INTO scan VALUES(?,?)').run(subject, 'preserved');
  } finally {
    await db.close();
  }
  const locate = vi.fn(() => Promise.resolve(null));
  const snapshotUnit = vi.fn(() => Promise.resolve(null));
  const archive: Options['archive'] = {
    ...idleArchive(),
    locate,
    snapshotUnit,
  };
  const recovered = await reopen({ archive, canGenerate: () => false });
  await vi.waitFor(
    () => {
      expect(recovered.status()).toMatchObject({ pending: 0, failed: 0, completed: 0 });
    },
    { interval: 5 },
  );
  await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(snapshotUnit).toHaveBeenCalledWith(subject, 60000, 'unit-60000');
  expect(snapshotUnit).toHaveBeenCalledWith(subject, 120000, 'unit-120000');
  expect(locate).not.toHaveBeenCalled();
  const checked = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    expect(
      await checked.prepare('SELECT unit_cursor FROM scan WHERE subject=?').get(subject),
    ).toMatchObject({
      unit_cursor: 'preserved',
    });
  } finally {
    await checked.close();
  }
});

it('periodically removes source-less completed jobs while retaining data on source query failure', async () => {
  const { root, queue, reopen } = await fixture();
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.close();
  let missing = false;
  const lookup = vi.fn(() =>
    missing ? Promise.resolve(null) : Promise.reject(new Error('archive unavailable')),
  );
  const archive: Options['archive'] = {
    ...idleArchive(),
    snapshotUnit: lookup,
  };
  const recovered = await reopen({ archive, auditMs: 10, canGenerate: () => false });
  await vi.waitFor(
    () => {
      expect(lookup).toHaveBeenCalledWith(subject, 60000, 'unit-60000');
    },
    { interval: 5 },
  );
  expect(recovered.status().completed).toBe(1);
  expect(await readFile(filename(root))).toEqual(image);
  await vi.waitFor(() =>
    expect(recovered.maintenanceStatus()).toMatchObject({
      state: 'retrying',
      error: 'screenshot_audit_failed',
      lastSuccessAtMs: null,
    }),
  );
  missing = true;
  await vi.waitFor(
    () => {
      expect(recovered.status().completed).toBe(0);
      expect(recovered.maintenanceStatus().error).toBeNull();
    },
    { interval: 5 },
  );
  await recovered.close();
  await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not checkpoint a stale history page after concurrent source removal invalidates the scan', async () => {
  const report = deferred<SnapshotItem | null>(),
    next = deferred<{ items: SnapshotItem[]; cursor: string | null }>(),
    scanning = deferred<void>();
  const { root, queue, reopen } = await fixture();
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await queue.close();
  const seed = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    await seed.prepare('INSERT INTO scan VALUES(?,?)').run(subject, 'after-existing');
  } finally {
    await seed.close();
  }
  const archive: Options['archive'] = {
    ...idleArchive(),
    listSubjects: () => Promise.resolve(subjects),
    snapshotUnit: () => report.promise,
    snapshotUnits: () => {
      scanning.resolve();
      return next.promise;
    },
  };
  const recovered = await reopen({ archive, canGenerate: () => false });
  try {
    await scanning.promise;
    report.resolve(null);
    await vi.waitFor(
      () => {
        expect(recovered.status().completed).toBe(0);
      },
      { interval: 5 },
    );
    next.resolve({ items: [], cursor: 'late-page' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const db = await SqlDatabase.open(path.join(root, 'jobs'));
    try {
      expect(
        await db.prepare('SELECT unit_cursor FROM scan WHERE subject=?').get(subject),
      ).toMatchObject({
        unit_cursor: 'after-existing',
      });
    } finally {
      await db.close();
    }
  } finally {
    report.resolve(null);
    next.resolve({ items: [], cursor: 'late-page' });
  }
});

afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    for (const queue of entry.queues) await queue.close();
    await rm(entry.root, { recursive: true, force: true });
  }
  vi.mocked(rename).mockRestore();
  vi.mocked(unlink).mockRestore();
});

it('deduplicates jobs, raises their priority and defaults to one execution slot', async () => {
  const release = deferred<void>(),
    order: number[] = [];
  let active = 0,
    maximum = 0;
  const render = vi.fn(async (job: SnapshotJob, signal: AbortSignal) => {
    active++;
    maximum = Math.max(maximum, active);
    order.push(job.at);
    try {
      if (order.length === 1) await Promise.race([release.promise, untilAborted(signal)]);
      return frame(job);
    } finally {
      active--;
    }
  });
  let allowed = false;
  const { queue } = await fixture({ render, canGenerate: () => allowed });
  try {
    await queue.enqueue(subject, item(1000));
    await queue.enqueue(subject, item(2000), 10);
    await queue.enqueue(subject, item(3000), 10);
    await queue.enqueue(subject, item(2000), 20);
    // All commands must be admitted before asserting their priority order;
    // async PostgreSQL admission intentionally yields between independent calls.
    allowed = true;
    await vi.waitFor(
      () => {
        expect(order).toEqual([2000]);
      },
      { interval: 5 },
    );
    expect(queue.status().pending).toBe(3);
    expect(maximum).toBe(1);
    release.resolve();
    await done(queue, 3);
    expect(order).toEqual([2000, 3000, 1000]);
    expect(maximum).toBe(1);
    await queue.enqueue(subject, item(2000), 30);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(render).toHaveBeenCalledTimes(3);
  } finally {
    release.resolve();
  }
});

it('fills independent execution slots immediately while a slow unit remains active', async () => {
  const slow = deferred<void>();
  const started: number[] = [];
  let allowed = false;
  const { queue } = await fixture({
    concurrency: 2,
    canGenerate: () => allowed,
    render: async (job, signal) => {
      started.push(job.at);
      if (job.at === 3000) await Promise.race([slow.promise, untilAborted(signal)]);
      return frame(job);
    },
  });
  try {
    await queue.enqueue(subject, item(1000));
    await queue.enqueue(subject, item(2000));
    await queue.enqueue(subject, item(3000));
    allowed = true;
    await vi.waitFor(() => expect(queue.status().completed).toBe(2), { interval: 5 });
    expect(started).toEqual([3000, 2000, 1000]);
    expect(queue.status()).toMatchObject({ active: 1, limit: 2, running: true });
    slow.resolve();
    await done(queue, 3);
  } finally {
    slow.resolve();
  }
});

it('acknowledges a committed enqueue without waiting for later statistics revisions to become idle', async () => {
  const listed = vi.fn(() => Promise.resolve([]));
  const { queue } = await fixture({
    archive: { ...idleArchive(), listSubjects: listed },
    canGenerate: () => false,
    pollMs: 60000,
  });
  await vi.waitFor(() => expect(listed).toHaveBeenCalled());
  const entered = deferred<void>(),
    secondEntered = deferred<void>(),
    releaseFirst = deferred<void>(),
    releaseSecond = deferred<void>();
  const original = statisticsModule.readJobStatistics;
  let reads = 0,
    firstDone = false;
  const read = vi.spyOn(statisticsModule, 'readJobStatistics').mockImplementation(async (db) => {
    const value = await original(db);
    if (++reads === 1) {
      entered.resolve();
      await releaseFirst.promise;
    } else if (reads === 2) {
      secondEntered.resolve();
      await releaseSecond.promise;
    }
    return value;
  });
  const first = queue.enqueue(subject, item(1000)).then(() => {
    firstDone = true;
  });
  let second: Promise<void> | undefined;
  try {
    await entered.promise;
    second = queue.enqueue(subject, item(2000));
    // A fixed snapshot is already being read; the second commit requests the next.
    await vi.waitFor(async () => {
      const db = await SqlDatabase.open(path.join(fixtures.at(-1)!.root, 'jobs'));
      try {
        expect(await db.prepare('SELECT count(*) AS n FROM jobs').get()).toMatchObject({ n: 2 });
      } finally {
        await db.close();
      }
    });
    releaseFirst.resolve();
    await secondEntered.promise;
    await vi.waitFor(() => expect(firstDone).toBe(true), { timeout: 200 });
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.all([first, second]);
    read.mockRestore();
  }
  expect(queue.status().pending).toBe(2);
});

it('fences a revoked attempt before publication and lets its replacement finish', async () => {
  const stale = deferred<void>();
  const fresh = Buffer.from([255, 216, 255, 1, 255, 217]);
  let calls = 0;
  const { root, queue } = await fixture({
    concurrency: 2,
    render: async (job) => {
      if (++calls === 1) {
        await stale.promise;
        return frame(job);
      }
      return { ...frame(job), bytes: fresh };
    },
  });
  try {
    await queue.enqueue(subject, item(60000));
    await vi.waitFor(() => expect(calls).toBe(1));
    const db = await SqlDatabase.open(path.join(root, 'jobs'));
    try {
      await db
        .prepare("UPDATE jobs SET state='pending',claim_token=NULL WHERE subject=?")
        .run(subject);
    } finally {
      await db.close();
    }
    stale.resolve();
    await done(queue);
    expect(calls).toBe(2);
    expect(await queue.read(subject, 60000, 60500)).toEqual(fresh);
  } finally {
    stale.resolve();
  }
});

it('aborts and drains every admitted slot before releasing queue ownership on close', async () => {
  let allowed = false;
  const render = vi.fn((_job: SnapshotJob, signal: AbortSignal) => untilAborted(signal));
  const { root, queue, reopen } = await fixture({
    concurrency: 3,
    canGenerate: () => allowed,
    render,
  });
  for (const at of [1000, 2000, 3000]) await queue.enqueue(subject, item(at));
  allowed = true;
  await vi.waitFor(() => expect(queue.status().active).toBe(3));
  await expect(
    ScreenshotJobs.open({
      root,
      archive: idleArchive(),
      render: (job) => Promise.resolve(frame(job)),
      validate: () => Promise.resolve(),
    }),
  ).rejects.toThrow('DATABASE_DIRECTORY_LOCKED');
  await queue.close();
  expect(queue.status().active).toBe(0);
  const resumed = await reopen({ render: (job) => Promise.resolve(frame(job)) });
  await done(resumed, 3);
});

it('keeps ready decoding independent of a slow invalidation source check', async () => {
  const checking = deferred<void>(),
    release = deferred<void>();
  let allowed = false;
  const archive = {
    ...idleArchive(),
    snapshotUnit: async (_id: string, at: number) => {
      if (at === 1000) {
        checking.resolve();
        await release.promise;
        return null;
      }
      return item(at);
    },
  };
  const { queue } = await fixture({ archive, concurrency: 2, canGenerate: () => allowed });
  try {
    await queue.enqueue(subject, item(1000));
    await queue.enqueue(subject, item(2000));
    const invalidation = queue.invalidate(subject, 1000, 1500);
    await checking.promise;
    allowed = true;
    await vi.waitFor(() => expect(queue.status().completed).toBe(1));
    expect(await queue.read(subject, 2000, 2500)).toEqual(image);
    release.resolve();
    await invalidation;
  } finally {
    release.resolve();
  }
});

it('keeps scheduled claims outside the discovering transaction and its eventual rollback', async () => {
  const scanning = deferred<void>(),
    page = deferred<void>(),
    held = deferred<void>(),
    rollback = deferred<void>();
  let allowed = false,
    inherited: boolean | undefined;
  const policy = vi.fn(() => allowed);
  const { queue, root } = await fixture({
    pollMs: 60000,
    canGenerate: policy,
    archive: {
      ...idleArchive(),
      listSubjects: () => Promise.resolve(subjects),
      snapshotUnits: async () => {
        scanning.resolve();
        await page.promise;
        return { items: [item(1000)], cursor: 'admitted' };
      },
    },
  });
  await scanning.promise;
  const previousTurns = policy.mock.calls.length;
  await queue.enqueue(subject, item(2000), 100);
  await vi.waitFor(() => expect(policy.mock.calls.length).toBeGreaterThan(previousTurns));
  const original = SqlDatabase.prototype.transaction;
  const prepare = SqlDatabase.prototype.prepare;
  const claimRead = vi.spyOn(SqlDatabase.prototype, 'prepare').mockImplementation(function (
    this: SqlDatabase,
    sql: string,
  ) {
    if (sql.startsWith('SELECT * FROM jobs WHERE state IN')) inherited = this.isTransaction;
    return prepare.call(this, sql);
  });
  const transaction = vi.spyOn(SqlDatabase.prototype, 'transaction').mockImplementation(function <
    T,
  >(this: SqlDatabase, action: () => Promise<T>): Promise<T> {
    return original.call(this, async () => {
      await action();
      held.resolve();
      await rollback.promise;
      throw Error('SYNTHETIC_SCAN_ROLLBACK');
    }) as Promise<T>;
  });
  try {
    allowed = true;
    page.resolve();
    await held.promise;
    // The independent claim can wait on the statistics trigger's row lock,
    // but must acquire/read outside the still-open discovery transaction.
    await vi.waitFor(() => expect(inherited).toBe(false));
    rollback.resolve();
    transaction.mockRestore();
    const db = await SqlDatabase.open(path.join(root, 'jobs'));
    try {
      await vi.waitFor(async () =>
        expect(await db.prepare('SELECT state FROM jobs WHERE unit=?').get('unit-2000')).toEqual({
          state: 'done',
        }),
      );
    } finally {
      await db.close();
    }
  } finally {
    page.resolve();
    rollback.resolve();
    transaction.mockRestore();
    claimRead.mockRestore();
  }
});

it('yields paused cache-adoption turns so enqueue and resume remain responsive with four slots', async () => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), 'stv-paused-adoption-'));
  await mkdir(path.join(mediaRoot, 'subjects'));
  let allowed = false;
  const render = vi.fn((job: SnapshotJob) =>
    Promise.resolve({ ...frame(job), mediaIds: ['media'] }),
  );
  const { queue } = await fixture({
    mediaRoot,
    concurrency: 4,
    canGenerate: () => allowed,
    render,
  });
  try {
    for (let i = 0; i < 12; i++) await queue.enqueue(subject, item(60000 + i * 1000));
    expect(render).not.toHaveBeenCalled();
    allowed = true;
    await queue.enqueue(subject, item(60000));
    await done(queue, 12);
    expect(render).toHaveBeenCalledTimes(12);
  } finally {
    allowed = true;
    await queue.close();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});

it('prioritizes repair and live recording notifications above background history', async () => {
  let allowed = true,
    listener: ((change: MediaChange) => void) | undefined;
  const segment: Segment = {
    id: 'live',
    subjectId: subject,
    sourceEpoch: 'test',
    sourceSequence: '1',
    mediaObjectId: 'media',
    initObjectId: null,
    durationSeconds: 0.5,
    wallStartMs: 60000,
    wallEndMs: 60500,
    timeBasis: 'source-pdt',
    uncertaintyMs: 0,
    discontinuity: false,
  };
  const archive: Options['archive'] = {
    ...idleArchive(),
    snapshotUnit: (_id, at, unitId) =>
      Promise.resolve(unitId ? { ...item(at), unitId } : item(60000)),
    snapshotForSegment: () => Promise.resolve(item(60000)),
    locate: (_id, at) => Promise.resolve({ ...segment, wallStartMs: at, wallEndMs: at + 500 }),
    subscribeMedia: (value) => {
      listener = value;
      return () => {
        listener = undefined;
      };
    },
  };
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const { root, queue } = await fixture({ archive, render, canGenerate: () => allowed });
  await queue.enqueue(subject, item(0));
  await done(queue);
  allowed = false;
  await vi.waitFor(
    () => {
      expect(queue.status().mode).toBe('paused');
    },
    { interval: 5 },
  );
  await writeFile(filename(root, 0), Buffer.from('broken'));
  expect(await queue.read(subject, 0, 500)).toBeNull();
  await queue.enqueue(subject, item(120000));
  listener?.({ kind: 'commit', segment });
  allowed = true;
  await done(queue, 3);
  expect(render.mock.calls.map((call) => call[0].at)).toEqual([0, 0, 60000, 120000]);
});

it('validates before publishing, persists JPEGs and reads them after reopen without rendering', async () => {
  const validated = deferred<void>();
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const validate = vi.fn(() => validated.promise);
  const { root, queue, reopen } = await fixture({ render, validate });
  try {
    await queue.enqueue(subject, item(60000));
    await vi.waitFor(
      () => {
        expect(validate).toHaveBeenCalledOnce();
      },
      { interval: 5 },
    );
    expect(await queue.read(subject, 60000, 60500)).toBeNull();
    await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
    validated.resolve();
    await done(queue);
    expect(await readFile(filename(root))).toEqual(image);
    expect(await queue.read(subject, 60000, 60499)).toBeNull();
    expect(await queue.read(subject, 60000, 60500)).toEqual(image);
    await queue.close();
    const reopened = await reopen();
    expect(await reopened.read(subject, 60000, 60500)).toEqual(image);
    expect(render).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
  } finally {
    validated.resolve();
  }
});

it('recovers a running job left by an interrupted process', async () => {
  const { root, queue, reopen } = await fixture();
  await queue.close();
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    await db
      .prepare(
        'INSERT INTO jobs(subject,unit,at,"end",slot,priority,state,due) VALUES(?,?,?,?,?,?,\'running\',?)',
      )
      .run(subject, 'unit-60000', 60000, 60500, 60000, 10, Date.now() + 60000);
  } finally {
    await db.close();
  }
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const recovered = await reopen({ render });
  await done(recovered);
  expect(render).toHaveBeenCalledOnce();
  expect(await recovered.read(subject, 60000, 60500)).toEqual(image);
});

it.each(['missing', 'corrupt'] as const)(
  'immediately requeues a %s JPEG detected by read and repairs it',
  async (mode) => {
    const repair = deferred<void>();
    const render = vi.fn(async (job: SnapshotJob, signal: AbortSignal) => {
      if (render.mock.calls.length > 1) await Promise.race([repair.promise, untilAborted(signal)]);
      return frame(job);
    });
    const { root, queue } = await fixture({ render });
    try {
      await queue.enqueue(subject, item(60000));
      await done(queue);
      if (mode === 'missing') await unlink(filename(root));
      else await writeFile(filename(root), Buffer.from([255, 216, 255, 0, 255, 217]));
      expect(await queue.read(subject, 60000, 60500)).toBeNull();
      await vi.waitFor(
        () => {
          expect(render).toHaveBeenCalledTimes(2);
        },
        { interval: 5 },
      );
      expect(queue.status().pending).toBe(1);
      expect(queue.status().completed).toBe(0);
      repair.resolve();
      await done(queue);
      expect(await queue.read(subject, 60000, 60500)).toEqual(image);
    } finally {
      repair.resolve();
    }
  },
);

it('audits a damaged JPEG without requiring a read', async () => {
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const { root, queue } = await fixture({ render, auditMs: 10 });
  await queue.enqueue(subject, item(60000));
  await done(queue);
  await writeFile(filename(root), Buffer.from('broken'));
  await vi.waitFor(
    () => {
      expect(render).toHaveBeenCalledTimes(2);
    },
    { interval: 5 },
  );
  await done(queue);
  expect(await readFile(filename(root))).toEqual(image);
});

it('backs failures off exponentially before retrying and resets attempts after success', async () => {
  const times: number[] = [];
  const render = vi.fn((job: SnapshotJob) => {
    times.push(Date.now());
    return times.length < 3
      ? Promise.reject(new Error('decoder failed'))
      : Promise.resolve(frame(job));
  });
  const { root, queue } = await fixture({ render, retryMs: 40 });
  await queue.enqueue(subject, item(60000));
  await vi.waitFor(
    () => {
      expect(queue.status().failed).toBe(1);
    },
    { interval: 5 },
  );
  expect(await queue.read(subject, 60000, 60500)).toBeNull();
  await done(queue);
  expect(times).toHaveLength(3);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(40);
  expect(times[2] - times[1]).toBeGreaterThanOrEqual(80);
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    expect(await db.prepare('SELECT attempts,state FROM jobs').get()).toMatchObject({
      attempts: 0,
      state: 'done',
    });
  } finally {
    await db.close();
  }
});

it('rejects decoder output that fails JPEG validation and never publishes it', async () => {
  const validate = vi.fn(() => Promise.reject(new Error('invalid JPEG content')));
  const { root, queue } = await fixture({ validate, retryMs: 60000 });
  await queue.enqueue(subject, item(60000));
  await vi.waitFor(
    () => {
      expect(queue.status().failed).toBe(1);
    },
    { interval: 5 },
  );
  expect(validate).toHaveBeenCalledOnce();
  expect(await queue.read(subject, 60000, 60500)).toBeNull();
  await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves retry backoff when requests repeatedly enqueue the same failed job', async () => {
  const render = vi.fn(() => Promise.reject(new Error('decoder unavailable')));
  const { queue } = await fixture({ render, retryMs: 1000 });
  await queue.enqueue(subject, item(60000));
  await vi.waitFor(
    () => {
      expect(queue.status().failed).toBe(1);
    },
    { interval: 5 },
  );
  for (let priority = 10; priority <= 30; priority += 10)
    await queue.enqueue(subject, item(60000), priority);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(render).toHaveBeenCalledOnce();
  expect(queue.status().failed).toBe(1);
});

it('keeps work pending while disk protection pauses generation and resumes when allowed', async () => {
  let allowed = false;
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const { queue } = await fixture({ render, canGenerate: () => allowed });
  await queue.enqueue(subject, item(60000), 30);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(render).not.toHaveBeenCalled();
  expect(queue.status()).toMatchObject({ pending: 1, completed: 0, mode: 'paused' });
  allowed = true;
  await done(queue);
  expect(render).toHaveBeenCalledOnce();
  expect(queue.status()).toMatchObject({ pending: 0, completed: 1, mode: 'realtime' });
  expect(await queue.read(subject, 60000, 60500)).toEqual(image);
});

it.each(['render', 'validation'] as const)(
  'requeues in-flight work when disk protection activates during %s and resumes without restart',
  async (phase) => {
    let allowed = true;
    const release = deferred<void>();
    const render = vi.fn(async (job: SnapshotJob) => {
      if (phase === 'render' && render.mock.calls.length === 1) await release.promise;
      return frame(job);
    });
    const validate = vi.fn(() =>
      phase === 'validation' && validate.mock.calls.length === 1
        ? release.promise
        : Promise.resolve(),
    );
    const { root, queue } = await fixture({ render, validate, canGenerate: () => allowed });
    try {
      await queue.enqueue(subject, item(60000), 30);
      await vi.waitFor(
        () => {
          expect(phase === 'render' ? render : validate).toHaveBeenCalledOnce();
        },
        { interval: 5 },
      );
      allowed = false;
      release.resolve();
      await vi.waitFor(
        () => {
          expect(queue.status().mode).toBe('paused');
        },
        { interval: 5 },
      );
      expect(queue.status()).toMatchObject({ pending: 1, failed: 0, completed: 0 });
      const db = await SqlDatabase.open(path.join(root, 'jobs'));
      try {
        expect(
          await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='running'").get(),
        ).toMatchObject({ n: 0 });
        expect(await db.prepare('SELECT state,attempts FROM jobs').get()).toMatchObject({
          state: 'pending',
          attempts: 0,
        });
      } finally {
        await db.close();
      }
      allowed = true;
      await done(queue);
      expect(render).toHaveBeenCalledTimes(2);
      expect(await queue.read(subject, 60000, 60500)).toEqual(image);
    } finally {
      release.resolve();
    }
  },
);

it('cancels active rendering on close and resumes it without recording a failed attempt', async () => {
  let signal: AbortSignal | undefined;
  const render = vi.fn((_job: SnapshotJob, value: AbortSignal) => {
    signal = value;
    return untilAborted(value);
  });
  const { root, queue, reopen } = await fixture({ render });
  await queue.enqueue(subject, item(60000));
  await vi.waitFor(
    () => {
      expect(render).toHaveBeenCalledOnce();
    },
    { interval: 5 },
  );
  await queue.close();
  expect(signal?.aborted).toBe(true);
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    expect(await db.prepare('SELECT attempts,state FROM jobs').get()).toMatchObject({
      attempts: 0,
      state: 'pending',
    });
  } finally {
    await db.close();
  }
  const resumed = await reopen({ render: (job) => Promise.resolve(frame(job)) });
  await done(resumed);
});

it('does not resurrect a job or JPEG when deleted while rendering ignores cancellation', async () => {
  const release = deferred<void>();
  let signal: AbortSignal | undefined;
  const render = vi.fn(async (job: SnapshotJob, value: AbortSignal) => {
    signal = value;
    await release.promise;
    return frame(job);
  });
  const { root, queue } = await fixture({ render });
  try {
    await queue.enqueue(subject, item(60000));
    await vi.waitFor(
      () => {
        expect(render).toHaveBeenCalledOnce();
      },
      { interval: 5 },
    );
    await queue.invalidate(subject, 60000, 60500);
    expect(signal?.aborted).toBe(true);
    release.resolve();
    await queue.close();
    expect(await queue.read(subject, 60000, 60500)).toBeNull();
    await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.resolve();
  }
});

it('does not resurrect a JPEG when deletion races with the final atomic rename', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
    entered.resolve();
    await release.promise;
    await actual.rename(source, destination);
  });
  const { root, queue } = await fixture();
  try {
    await queue.enqueue(subject, item(60000));
    await entered.promise;
    await queue.invalidate(subject, 60000, 60500);
    release.resolve();
    await queue.close();
    await expect(readFile(filename(root))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.resolve();
  }
});

it('waits for an in-flight invalidation before closing its database', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const { queue } = await fixture();
  await queue.enqueue(subject, item(60000));
  await done(queue);
  vi.mocked(unlink).mockImplementationOnce(async (target) => {
    entered.resolve();
    await release.promise;
    await actual.unlink(target);
  });
  const invalidation = queue.invalidate(subject, 60000, 60500);
  const invalidationResult = invalidation.then(
    () => null,
    (error: unknown) => error,
  );
  await entered.promise;
  const closed = vi.fn();
  const closing = queue.close().then(() => {
    closed();
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closedBeforeDeletionFinished = closed.mock.calls.length > 0;
    release.resolve();
    expect(await invalidationResult).toBeNull();
    await closing;
    expect(closedBeforeDeletionFinished).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([invalidation, closing]);
  }
});

it('discovers equal sample times and backwards wall clocks through a persisted unit cursor on reopen', async () => {
  const units = Array.from({ length: 10 }, (_, index) => ({
    ...item(index < 2 ? 60000 : index === 2 ? 1000 : index * 60000),
    unitId: `history-${index}`,
  }));
  const snapshotUnits = vi.fn((_id: string, cursor?: string, limit?: number) => {
    const offset = cursor ? Number(cursor.slice('after-'.length)) : 0;
    const items = units.slice(offset, offset + (limit ?? 8));
    return Promise.resolve({
      items,
      cursor: items.length ? `after-${offset + items.length}` : (cursor ?? null),
    });
  });
  const locate = vi.fn(() => Promise.resolve(null));
  const archive: Options['archive'] = {
    ...idleArchive(),
    listSubjects: () => Promise.resolve(subjects),
    locate,
    snapshotUnits,
    snapshotUnit: (_id, _at, unitId) =>
      Promise.resolve(units.find((unit) => unit.unitId === unitId) ?? null),
  };
  const render = vi.fn((_job: SnapshotJob, signal: AbortSignal) => untilAborted(signal));
  const { root, queue, reopen } = await fixture({ archive, render });
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce(), { interval: 5 });
  await queue.close();
  const db = await SqlDatabase.open(path.join(root, 'jobs'));
  try {
    expect(
      (await db.prepare('SELECT unit FROM jobs ORDER BY unit').all()).map((row) => row.unit),
    ).toEqual(units.slice(0, 8).map((unit) => unit.unitId));
    expect(
      await db.prepare('SELECT unit_cursor FROM scan WHERE subject=?').get(subject),
    ).toMatchObject({
      unit_cursor: 'after-8',
    });
  } finally {
    await db.close();
  }
  expect(locate).not.toHaveBeenCalled();
  snapshotUnits.mockClear();
  await reopen();
  await vi.waitFor(() => expect(snapshotUnits).toHaveBeenCalled(), { interval: 5 });
  expect(snapshotUnits.mock.calls[0]).toEqual([subject, 'after-8', 8]);
});

it('skips bounded batches of empty subjects so unit history reaches the worker within two scans', async () => {
  const empty = Array.from({ length: 17 }, (_, index) => ({
    ...subjects[0],
    id: `stripchat:${index + 1}`,
    providerId: index + 1,
  }));
  const snapshotUnits = vi.fn((id: string, cursor?: string) =>
    Promise.resolve({
      items: id === subject && !cursor ? [item(60000)] : [],
      cursor: id === subject ? 'after-history' : (cursor ?? null),
    }),
  );
  const archive: Options['archive'] = {
    ...idleArchive(),
    listSubjects: () => Promise.resolve([...empty, ...subjects]),
    snapshotUnits,
    snapshotUnit: () => Promise.resolve(item(60000)),
  };
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const { queue } = await fixture({ archive, render });
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce(), { interval: 5, timeout: 1200 });
  await done(queue);
  expect(snapshotUnits.mock.calls.filter(([id]) => id !== subject)).toHaveLength(17);
});

it('cools empty unit scans while exact commit membership immediately discovers a second unit at the same sample time', async () => {
  let listener: ((change: MediaChange) => void) | undefined;
  const units: SnapshotItem[] = [];
  const snapshotUnits = vi.fn((_id: string, cursor?: string) =>
    Promise.resolve({ items: [], cursor: cursor ?? null }),
  );
  const snapshotForSegment = vi.fn((_id: string, segmentId: string) =>
    Promise.resolve(units.find((unit) => unit.unitId === segmentId) ?? null),
  );
  const archive: Options['archive'] = {
    ...idleArchive(),
    listSubjects: () => Promise.resolve(subjects),
    snapshotUnits,
    snapshotForSegment,
    snapshotUnit: (_id, _at, unitId) =>
      Promise.resolve(units.find((unit) => unit.unitId === unitId) ?? null),
    subscribeMedia: (value) => {
      listener = value;
      return () => {
        listener = undefined;
      };
    },
  };
  const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
  const { queue } = await fixture({ archive, render });
  await vi.waitFor(() => expect(snapshotUnits).toHaveBeenCalledOnce(), { interval: 5 });
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(snapshotUnits).toHaveBeenCalledOnce();
  for (const [index, id] of ['a', 'b'].entries()) {
    units.push({ ...item(60000), unitId: id });
    listener?.({
      kind: 'commit',
      segment: {
        id,
        subjectId: subject,
        sourceEpoch: id,
        sourceSequence: '1',
        mediaObjectId: id,
        initObjectId: null,
        durationSeconds: 0.5,
        wallStartMs: 60000,
        wallEndMs: 60500,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: true,
      },
    });
    await done(queue, index + 1);
  }
  expect(snapshotForSegment.mock.calls).toEqual([
    [subject, 'a'],
    [subject, 'b'],
  ]);
  expect(render.mock.calls.map(([job]) => job.unit)).toEqual(['a', 'b']);
});

it.each([
  { name: 'one source fragment crossing a minute', starts: [59900], expected: ['member-0'] },
  {
    name: 'several source fragments coalesced before the worker wakes',
    starts: [59900, 120010, 180010],
    expected: ['member-0', 'member-2'],
  },
])(
  'discovers first and last member identities for $name without decoding in the callback',
  async ({ starts, expected }) => {
    let listener: ((change: MediaChange) => void) | undefined;
    const units = starts.map((at, index) => ({
      ...item(at),
      unitId: `owner-${index}`,
      slotToMs: at + 500,
    }));
    const snapshotForSegment = vi.fn((_id: string, segmentId: string) =>
      Promise.resolve(units[Number(segmentId.slice('member-'.length))] ?? null),
    );
    const archive: Options['archive'] = {
      ...idleArchive(),
      snapshotForSegment,
      snapshotUnit: (_id, _at, unitId) =>
        Promise.resolve(units.find((unit) => unit.unitId === unitId) ?? null),
      subscribeMedia: (value) => {
        listener = value;
        return () => {
          listener = undefined;
        };
      },
    };
    const render = vi.fn((job: SnapshotJob) => Promise.resolve(frame(job)));
    const { queue } = await fixture({ archive, render });
    for (const [index, at] of starts.entries())
      listener?.({
        kind: 'commit',
        segment: {
          id: `member-${index}`,
          subjectId: subject,
          sourceEpoch: 'test',
          sourceSequence: String(index),
          mediaObjectId: `media-${index}`,
          initObjectId: null,
          durationSeconds: 0.5,
          wallStartMs: at,
          wallEndMs: at + 500,
          timeBasis: 'source-pdt',
          uncertaintyMs: 0,
          discontinuity: false,
        },
      });
    expect(render).not.toHaveBeenCalled();
    expect(snapshotForSegment).not.toHaveBeenCalled();
    await done(queue, expected.length);
    expect(snapshotForSegment.mock.calls.map((call) => call[1])).toEqual(expected);
    expect(new Set(render.mock.calls.map(([job]) => job.unit))).toEqual(
      new Set(expected.map((id) => units[Number(id.slice('member-'.length))].unitId)),
    );
  },
);

it('exposes generation separately from maintenance and only completes after publication', async () => {
  const gate = deferred<SnapshotFrame>();
  const { queue } = await fixture({ render: () => gate.promise });
  await queue.enqueue(subject, item(60000));
  await vi.waitFor(() => expect(queue.status().running).toBe(true));
  expect(queue.status().lastCompletedAtMs).toBeNull();
  expect(queue.maintenanceStatus()).toMatchObject({
    id: 'snapshot-maintenance',
    group: 'processing',
    error: null,
  });
  gate.resolve({ bytes: image, throughMs: 60500 });
  await done(queue);
  expect(queue.status().running).toBe(false);
  expect(queue.status().lastCompletedAtMs).toBeGreaterThan(0);
});
