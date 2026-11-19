import { libraryIndexPath } from '../library/paths.js';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openTestDatabase, dropTestDatabase, planNodes } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivePort, CommitInput } from '../ports.js';
import { openArchive } from './index.js';
import type { ArchiveFaultPoint, ArchiveHandle } from './index.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

let root: string;
let archives: ArchivePort[];
const subject = { id: 'stripchat:123', providerId: 123, handle: 'fixture' };
const input = (sequence = '1', start: number | null = 1000): CommitInput => ({
  subjectId: subject.id,
  sourceEpoch: 'epoch-one',
  sourceSequence: sequence,
  init: new Uint8Array([1, 2, 3]),
  bytes: new Uint8Array([4, 5, 6, 7]),
  durationSeconds: 2,
  wallStartMs: start,
  timeBasis: start === null ? 'unknown' : 'source-pdt',
  uncertaintyMs: null,
  discontinuity: false,
});
async function create(
  fault?: (point: ArchiveFaultPoint) => void | Promise<void>,
): Promise<ArchiveHandle> {
  const archive = await openArchive({ root, fault });
  archives.push(archive);
  return archive;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stv-next-archive-'));
  archives = [];
});

it('seeks the latest online interval without scanning offline history', async () => {
  const a = await create();
  await a.upsertSubjects([subject]);
  await a.commit(input());
  const db = await openTestDatabase(libraryIndexPath(root));
  try {
    await db.exec(
      `INSERT INTO status_intervals SELECT '${subject.id}',n*1000,n*1000+500,CASE WHEN n%1000=0 THEN 'PUBLIC' ELSE 'OFFLINE' END FROM generate_series(1,10000)n;ANALYZE status_intervals`,
    );
    const plan = planNodes(
      await db
        .prepare(
          "EXPLAIN (FORMAT JSON) SELECT start FROM status_intervals WHERE subject=? AND status IN ('PUBLIC','PRIVATE') ORDER BY start DESC LIMIT 1",
        )
        .all(subject.id),
    );
    expect(
      plan.some(
        (node) =>
          node['Node Type'] === 'Index Only Scan' &&
          node['Index Name'] === 'status_interval_activity',
      ),
    ).toBe(true);
    expect(plan.some((node) => node['Node Type'] === 'Sort')).toBe(false);
  } finally {
    await db.close();
  }
});

it('includes exact occupied edges for fast local selection in coarse coverage buckets', async () => {
  const a = await create();
  await a.upsertSubjects([subject]);
  await a.commit(input('1', 1200));
  await a.commit(input('2', 8200));
  const coverage = await a.coverage(subject.id, 0, 60000, 1);
  expect(coverage.buckets[0]).toMatchObject({ mediaFromMs: 1200, mediaToMs: 10200 });
});
afterEach(async () => {
  await Promise.allSettled(archives.map((a) => a.close()));
  await rm(root, { recursive: true, force: true });
});

describe('independent archive', () => {
  it('admits queued favorite protection between retention batches while draining close', async () => {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let armed = false;
    const a = await create(async (point) => {
      if (armed && point === 'after-tombstone-sync') {
        armed = false;
        reached();
        await gate;
      }
    });
    await a.upsertSubjects([subject]);
    // Keep the final unit outside the first 128-member retention batch, so the
    // concurrent operation protects a unit not already logically deleted.
    for (let n = 1; n <= 129; n++) await a.commit(input(String(n), n * 60000));
    const page = await a.snapshotPages!(subject.id, 7740000, 1, 30, {
      fromMs: 7740000,
      toMs: 7800000,
    });
    const revision = await a.personalRevision();
    armed = true;
    const pruning = a.pruneBefore(10000000);
    await paused;
    try {
      const liking = a.unitFavorites!(subject.id, [page.items[0].unitId], true, revision);
      const closing = a.close();
      release();
      expect((await pruning).deletedSegments).toBe(128);
      await liking;
      await closing;
      const reopened = await create();
      expect((await reopened.timeline(subject.id, 7740000, 7800000)).segments).toHaveLength(1);
      expect((await reopened.personal(subject.id, 7740000, 7800000)).favorites).toHaveLength(1);
    } finally {
      release();
    }
  }, 15000);
  it('reports failed media subscribers without failing commits or skipping other subscribers', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const received = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    a.subscribeMedia!(() => {
      throw new Error('derived task failed');
    });
    a.subscribeMedia!(received);
    try {
      await expect(a.commit(input())).resolves.toMatchObject({ sourceSequence: '1' });
      expect(received).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });
  it('lets recording commits run between retention batches', async () => {
    const events: string[] = [];
    let recording: Promise<unknown> | undefined;
    let armed = false;
    const a = await create((point) => {
      if (armed && point === 'after-tombstone-sync') {
        events.push('delete');
        recording ??= a.commit(input('1000', 2000000)).then(() => events.push('commit'));
      }
    });
    await a.upsertSubjects([subject]);
    for (let n = 1; n <= 129; n++) await a.commit(input(String(n), n * 3000));
    armed = true;
    await a.pruneBefore(1000000);
    await recording;
    expect(events).toEqual(['delete', 'commit', 'delete']);
    expect((await a.timeline(subject.id, 2000000, 2003000)).segments).toHaveLength(1);
  }, 15000);
  it('persists ID-namespaced avatar cache settings while rejecting filesystem-like keys', async () => {
    const a = await create();
    const key = 'preview.avatar-version.stripchat:123';
    await a.setSetting(key, 'https://static-cdn.strpst.com/avatars/synthetic');
    expect(await a.getSetting(key)).toBe('https://static-cdn.strpst.com/avatars/synthetic');
    await expect(a.setSetting('../private', 'invalid')).rejects.toThrow('INVALID_SETTING');
  });
  it('derives persisted offline activity from available recordings and confirmed online intervals', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    await a.setObservation(subject.id, 'PUBLIC', 1000, 1000);
    await a.setObservation(subject.id, 'PRIVATE', 3000, 1000);
    await a.setObservation(subject.id, 'OFFLINE', 5000, 1000);
    await a.commit(input('1', null));
    expect((await a.listSubjects())[0]).toMatchObject({
      lastRecordedAtMs: null,
      lastOnlineAtMs: 3000,
    });
    await a.commit(input('2', 10000));
    await a.commit(input('3', 20000));
    expect((await a.listSubjects())[0]).toMatchObject({
      lastRecordedAtMs: 22000,
      lastOnlineAtMs: 3000,
    });
    await a.close();
    const b = await create();
    expect((await b.listSubjects())[0]).toMatchObject({
      lastRecordedAtMs: 22000,
      lastOnlineAtMs: 3000,
    });
    await b.pruneBefore(30000);
    expect((await b.listSubjects())[0]).toMatchObject({
      lastRecordedAtMs: null,
      lastOnlineAtMs: 3000,
    });
  });
  it('keeps directory activity exact during logical deletion and after indexed cleanup', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    await a.setObservation(subject.id, 'PUBLIC', 1000, 1000);
    await a.commit(input('1', 1000));
    await a.commit(input('2', 101000));
    expect((await a.listSubjects())[0].lastRecordedAtMs).toBe(103000);
    const plan = await a.planDeletion!(subject.id, [{ fromMs: 101000, toMs: 103000 }]);
    await a.deleteSelection!(subject.id, plan.id, plan.personalRevision);
    expect((await a.listSubjects())[0].lastRecordedAtMs).toBe(3000);
    await a.resumeDeletions!();
    expect((await a.listSubjects())[0].lastRecordedAtMs).toBe(3000);
    expect(await a.setPolicy(subject.id, { autoRecord: true })).toMatchObject({
      lastRecordedAtMs: 3000,
      lastOnlineAtMs: 1000,
      lastKnownStatus: 'PUBLIC',
    });
  });
  it('persists deployment origin across restarts without inferring it from recording history', async () => {
    const a = await create(),
      origin = (await a.identity()).timelineStartMs;
    expect(Number.isSafeInteger(origin)).toBe(true);
    expect(origin).toBeLessThanOrEqual(Date.now());
    const old = 1600000000000,
      run = await a.startRun(old);
    await a.stopRun(run, 'normal', old + 1000);
    await a.close();
    const b = await create();
    expect((await b.identity()).timelineStartMs).toBe(origin);
    await b.close();
    const c = await create();
    expect((await c.identity()).timelineStartMs).toBe(origin);
    await c.close();
  });
  it('persists subjects/settings with safe policy defaults and preserves policy on import', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    expect(await a.listSubjects()).toEqual([
      {
        ...subject,
        formerNames: [],
        archived: false,
        monitorEnabled: true,
        autoRecord: false,
        providerStatus: 'UNKNOWN',
        observedAtMs: null,
        lastRecordedAtMs: null,
        lastOnlineAtMs: null,
      },
    ]);
    await a.setPolicy(subject.id, { autoRecord: true });
    await a.setObservation(subject.id, 'PUBLIC', 1234);
    await a.upsertSubjects([{ ...subject, handle: 'renamed' }]);
    await a.setSetting('password_hash', 'synthetic-hash');
    await a.close();
    const b = await create();
    expect((await b.listSubjects())[0]).toMatchObject({
      autoRecord: true,
      handle: 'renamed',
      providerStatus: 'UNKNOWN',
      observedAtMs: 1234,
    });
    expect(await b.getSetting('password_hash')).toBe('synthetic-hash');
  });

  it('serializes duplicate commits and keeps only source-PDT segments on a half-open timeline', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const [first, duplicate] = await Promise.all([a.commit(input()), a.commit(input())]);
    expect(duplicate).toEqual(first);
    await a.commit(input('2', 3000));
    await a.commit({ ...input('3', 5000), timeBasis: 'estimated' });
    expect(await a.timeline(subject.id, 3000, 5000, 1)).toMatchObject({
      segments: [{ sourceSequence: '2' }],
      unlocatedCount: 1,
      truncated: false,
      revision: 3,
    });
    expect(await a.timeline(subject.id, 0, 5000, 1)).toMatchObject({
      segments: [{ sourceSequence: '1' }],
      truncated: true,
    });
    expect(await a.locate(subject.id, 3000, 'report')).toMatchObject({ sourceSequence: '2' });
    expect(await a.locate(subject.id, 5000, 'report')).toBeNull();
    expect(await a.locate(subject.id, 5000, 'previous')).toMatchObject({ sourceSequence: '2' });
    expect(await a.locate(subject.id, 0, 'next')).toMatchObject({ sourceSequence: '1' });
    await expect(a.timeline(subject.id, 0, 10 * 86400000)).rejects.toThrow('INVALID_TIME_WINDOW');
    await expect(a.timeline(subject.id, 0, 10000, 2001)).rejects.toThrow('INVALID_TIMELINE_LIMIT');
  });

  it('reclaims init only after its last reference and never resurrects a deleted source identity', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const first = await a.commit(input());
    const second = await a.commit(input('2', 61000));
    expect(first.initObjectId).toBe(second.initObjectId);
    expect(await a.deleteRange(subject.id, 1000, 3000)).toEqual({
      deletedSegments: 1,
      reclaimedBytes: 4,
    });
    expect(await a.media(first.mediaObjectId)).toBeNull();
    expect(await a.media(second.initObjectId ?? '')).not.toBeNull();
    expect(await a.deleteRange(subject.id, 61000, 63000)).toEqual({
      deletedSegments: 1,
      reclaimedBytes: 7,
    });
    await expect(a.commit(input())).rejects.toThrow('SOURCE_SEGMENT_DELETED');
    await a.close();
    const b = await create();
    expect((await b.timeline(subject.id, 0, 10000)).segments).toEqual([]);
    await expect(b.commit(input())).rejects.toThrow('SOURCE_SEGMENT_DELETED');
    const third = await b.commit(input('3', 5000));
    expect(third.mediaObjectId).not.toBe(first.mediaObjectId);
    expect(third.initObjectId).not.toBe(first.initObjectId);
  });

  it('recovers a durable journal commit not yet indexed, exactly once', async () => {
    const a = await create((point) => {
      if (point === 'after-journal-sync') throw new Error('INJECTED');
    });
    await a.upsertSubjects([subject]);
    await expect(a.commit(input())).rejects.toThrow('INJECTED');
    await expect(a.timeline(subject.id, 0, 10000)).rejects.toThrow('ARCHIVE_REQUIRES_RECOVERY');
    await a.close();
    const b = await create();
    const rows = (await b.timeline(subject.id, 0, 10000)).segments;
    expect(rows).toHaveLength(1);
    const { recordingUnitId, ...stored } = rows[0];
    expect(recordingUnitId).toBe(stored.id);
    // Unit membership is a query projection, not part of the immutable commit.
    expect(await b.commit(input())).toEqual(stored);
    await b.close();
    const c = await create();
    expect((await c.timeline(subject.id, 0, 10000)).segments).toHaveLength(1);
  });

  it('isolates rename-before-journal orphans instead of guessing a content time', async () => {
    const a = await create((point) => {
      if (point === 'after-object-rename') throw new Error('INJECTED');
    });
    await a.upsertSubjects([subject]);
    await expect(a.commit(input())).rejects.toThrow('INJECTED');
    await a.close();
    const b = await create();
    expect((await b.timeline(subject.id, 0, 10000)).segments).toEqual([]);
    await vi.waitFor(async () =>
      expect(
        await readdir(
          path.join(root, 'media', 'subjects', 'stripchat-123', 'recordings', '.orphaned'),
        ),
      ).toHaveLength(1),
    );
  });

  it.each(['after-tombstone-sync', 'after-tombstone-commit', 'after-unlink'] as const)(
    'finishes deletion after failure at %s',
    async (pointToFail) => {
      let armed = false;
      const a = await create((point) => {
        if (armed && point === pointToFail) throw new Error('INJECTED');
      });
      await a.upsertSubjects([subject]);
      const segment = await a.commit(input());
      armed = true;
      await expect(a.deleteRange(subject.id, 0, 10000)).rejects.toThrow('INJECTED');
      await a.close();
      const b = await create();
      expect(await b.media(segment.mediaObjectId)).toBeNull();
      expect(await b.media(segment.initObjectId ?? '')).toBeNull();
      expect((await b.timeline(subject.id, 0, 10000)).segments).toEqual([]);
      await expect(b.commit(input())).rejects.toThrow('SOURCE_SEGMENT_DELETED');
      expect(
        (await readdir(path.join(root, 'media', 'subjects', 'stripchat-123', 'recordings'))).filter(
          (name) => /\.(mp4|m4s)$/.test(name),
        ),
      ).toEqual([]);
    },
  );

  it('truncates an incomplete trailing record but rejects a corrupt complete journal record', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    await a.commit(input());
    await a.close();
    const journal = path.join(root, 'media', 'postgres-journal', 'active.log');
    const original = await readFile(journal);
    await appendFile(journal, 'STP1partial');
    const b = await create();
    // Startup legitimately appends session-state changes after trimming the torn tail.
    expect((await readFile(journal)).subarray(0, original.length)).toEqual(original);
    expect((await readFile(journal)).includes(Buffer.from('STP1partial'))).toBe(false);
    await b.close();
    const damaged = Buffer.from(original);
    damaged[damaged.length - 1] ^= 1;
    await writeFile(journal, damaged);
    await expect(create()).rejects.toThrow('LIBRARY_JOURNAL_CORRUPT');
  });

  it('rebuilds media metadata including tombstones when the metadata file is lost', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const first = await a.commit(input());
    const second = await a.commit(input('2', 61000));
    await a.deleteRange(subject.id, 1000, 3000);
    await a.close();
    await dropTestDatabase(libraryIndexPath(root));
    const b = await create();
    expect((await b.timeline(subject.id, 0, 120000)).segments).toEqual([
      { ...second, recordingUnitId: second.id },
    ]);
    expect(await b.media(first.mediaObjectId)).toBeNull();
    expect((await b.listSubjects())[0].autoRecord).toBe(false);
  });

  it('holds one cross-process database lock and releases it on close', async () => {
    const a = await create();
    await expect(create()).rejects.toThrow('ARCHIVE_LOCKED_OR_DATABASE_UNAVAILABLE');
    await a.close();
    const b = await create();
    await b.upsertSubjects([subject]);
    expect(await b.listSubjects()).toHaveLength(1);
  });

  it('releases the instance lock after abrupt process exit and replays the fsynced journal', async () => {
    const script = `import { openArchive } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const archive = await openArchive({ root:${JSON.stringify(root)}, fault(point) { if(point === 'after-journal-sync') process.exit(73); } });
      await archive.upsertSubjects([${JSON.stringify(subject)}]);
      await archive.commit({ ...${JSON.stringify(input())}, init: new Uint8Array([1,2,3]), bytes: new Uint8Array([4,5,6,7]) });`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    const timer = setTimeout(() => child.kill(), 5000);
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode: number | null) => resolve(exitCode));
    });
    try {
      expect(await exited).toBe(73);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
    const a = await create();
    expect((await a.timeline(subject.id, 0, 10000)).segments).toHaveLength(1);
    expect((await a.commit(input())).sourceSequence).toBe('1');
    expect(await a.sourceCheckpoint(subject.id)).toEqual({
      epoch: 'epoch-one',
      highestSequence: '1',
      lastWallStartMs: 1000,
    });
  });

  it('drains already accepted commits before close and refuses further work', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const committing = a.commit(input());
    const closing = a.close();
    await committing;
    await closing;
    await expect(a.commit(input('2'))).rejects.toThrow('ARCHIVE_CLOSED');
    const b = await create();
    expect((await b.timeline(subject.id, 0, 10000)).segments).toHaveLength(1);
  });

  it('never provides arbitrary paths and fails closed when committed media is tampered', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const segment = await a.commit(input());
    expect(await a.media('../private/postgres.json')).toBeNull();
    expect(await a.media('journal.ndjson')).toBeNull();
    const media = await a.media(segment.mediaObjectId);
    expect(media).not.toBeNull();
    await a.close();
    await writeFile(media!.path, new Uint8Array([8, 8, 8, 8]));
    const b = await create();
    await expect(b.media(segment.mediaObjectId)).rejects.toThrow('MEDIA_INTEGRITY_FAILED');
    await expect(b.scrub({ delayMs: 0 })).rejects.toThrow('MEDIA_INTEGRITY_FAILED');
  });

  it('rejects a substituted media directory symlink without reading its target', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    await a.close();
    const link = path.join(root, 'media', 'subjects', 'stripchat-123');
    await symlink(
      path.join(root, 'media'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(create()).rejects.toThrow('UNSAFE_ARCHIVE_PATH');
  });

  for (const filename of [
    '.instance.lock',
    'media/.instance.lock',
    'media/library.json',
    'media/postgres-journal/active.log',
    'media/postgres-journal/.instance.lock',
  ]) {
    it(`rejects a symlink at ${filename} before PostgreSQL library access can modify its target`, async (context) => {
      const target = path.join(root, 'unrelated-original.bin');
      const original = Buffer.from('STV-UNCHANGED');
      await writeFile(target, original);
      const link = path.join(root, filename);
      await mkdir(path.dirname(link), { recursive: true });
      if (filename.startsWith('media/postgres-journal/')) {
        // Reach journal validation through a valid library; an unidentified,
        // nonempty media root must fail closed before opening its journal.
        await writeFile(
          path.join(root, 'media', 'library.json'),
          JSON.stringify({
            format: 2,
            id: randomUUID(),
            createdAtMs: Date.now(),
          }),
        );
      }
      try {
        await symlink(target, link, 'file');
      } catch (error) {
        if (
          process.platform === 'win32' &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EPERM'
        ) {
          context.skip();
          return;
        }
        throw error;
      }
      await expect(create()).rejects.toThrow('UNSAFE_DATABASE_PATH');
      expect(await readFile(target)).toEqual(original);
    });
  }
  it('rejects a nonempty media directory without inventing a library identity', async () => {
    const media = path.join(root, 'media');
    await mkdir(media);
    const target = path.join(media, 'preserved-media.bin');
    await writeFile(target, 'STV-UNCHANGED');
    await expect(create()).rejects.toThrow('LIBRARY_MANIFEST_REQUIRED');
    expect(await readFile(target, 'utf8')).toBe('STV-UNCHANGED');
    expect(await readdir(media)).not.toContain('library.json');
  });
  it('rejects a nonregular library lock before opening the database', async () => {
    await mkdir(path.join(root, '.instance.lock'));
    await expect(create()).rejects.toThrow('UNSAFE_DATABASE_PATH');
  });
  it('rejects a lock-path directory junction without touching its target', async () => {
    const target = path.join(root, 'unrelated-original-directory');
    await mkdir(target);
    await writeFile(path.join(target, 'sentinel'), 'unchanged');
    await symlink(
      target,
      path.join(root, '.instance.lock'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(create()).rejects.toThrow('UNSAFE_DATABASE_PATH');
    expect(await readdir(target)).toEqual(['sentinel']);
    expect(await readFile(path.join(target, 'sentinel'), 'utf8')).toBe('unchanged');
  });

  it('persists the successful source high-water mark across deletion and restart', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    expect(await a.sourceCheckpoint(subject.id)).toBeNull();
    await a.commit(input('9007199254740993'));
    await a.commit(input('2', 3000));
    expect(await a.sourceCheckpoint(subject.id)).toEqual({
      epoch: 'epoch-one',
      highestSequence: '9007199254740993',
      lastWallStartMs: 1000,
    });
    await a.deleteRange(subject.id, 0, 10000);
    await a.close();
    const b = await create();
    expect(await b.sourceCheckpoint(subject.id)).toMatchObject({
      highestSequence: '9007199254740993',
    });
    await b.commit({ ...input('1', null), sourceEpoch: 'epoch-two' });
    expect(await b.sourceCheckpoint(subject.id)).toEqual({
      epoch: 'epoch-two',
      highestSequence: '1',
      lastWallStartMs: null,
    });
  });

  it('keeps cursor pages stable across new commits and restart, invalidating deletion and wrong parameters', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    for (let i = 1; i <= 4; i++) await a.commit(input(String(i), i * 3000));
    const first = await a.timeline(subject.id, 0, 20000, 2);
    expect(first.nextCursor).toBeTypeOf('string');
    await a.commit(input('5', 7000));
    await a.close();
    const b = await create();
    const second = await b.timeline(subject.id, 0, 20000, 2, first.nextCursor!);
    expect(second.segments.map((s) => s.sourceSequence)).toEqual(['3', '4']);
    expect(second.revision).toBe(first.revision);
    expect(second.nextCursor).toBeNull();
    await expect(b.timeline(subject.id, 0, 21000, 2, first.nextCursor!)).rejects.toThrow(
      'INVALID_CURSOR',
    );
    await expect(b.timeline(subject.id, 0, 20000, 2, first.nextCursor! + 'x')).rejects.toThrow(
      'INVALID_CURSOR',
    );
    await b.deleteRange(subject.id, 9000, 11000);
    await expect(b.timeline(subject.id, 0, 20000, 2, first.nextCursor!)).rejects.toThrow(
      'CURSOR_STALE',
    );
  });

  it('computes exact union and unique segment counts across arbitrary bucket boundaries', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const intervals = [
      [1000, 121000],
      [59000, 63000],
      [70000, 80000],
      [119000, 124000],
      [300000, 302000],
    ];
    for (const [i, [start, end]] of intervals.entries())
      await a.commit({ ...input(String(i), start), durationSeconds: (end - start) / 1000 });
    for (const [from, to, buckets] of [
      [0, 360000, 7],
      [61000, 123000, 13],
      [60000, 120000, 1],
      [62000, 70000, 3],
    ]) {
      const result = await a.coverage(subject.id, from, to, buckets);
      for (const bucket of result.buckets) {
        const clipped = intervals
          .map(([s, e]) => [Math.max(s, bucket.fromMs), Math.min(e, bucket.toMs)])
          .filter(([s, e]) => e > s)
          .sort((x, y) => x[0] - y[0]);
        let covered = 0,
          end = -1;
        for (const [s, e] of clipped) {
          covered += Math.max(0, e - Math.max(s, end));
          end = Math.max(end, e);
        }
        expect(bucket.coveredMs).toBe(covered);
        expect(bucket.segmentCount).toBe(clipped.length);
        expect(bucket.mediaFromMs).toBe(clipped[0]?.[0]);
        expect(bucket.mediaToMs).toBe(clipped.length ? end : undefined);
      }
    }
    const month = await a.coverage(subject.id, 0, 31 * 86400000, 720);
    expect(month.buckets.reduce((n, b) => n + b.coveredMs, 0)).toBe(125000);
    expect(month.buckets.some((b) => b.coveredMs > 0 && b.coveredMs < b.toMs - b.fromMs)).toBe(
      true,
    );
    await a.deleteRange(subject.id, 300000, 302000);
    expect(
      (await a.coverage(subject.id, 0, 31 * 86400000, 720)).buckets.reduce(
        (n, b) => n + b.coveredMs,
        0,
      ),
    ).toBe(123000);
  });

  it('deletes unlocated objects explicitly while retention preserves the whole crossing unit', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    const old = await a.commit(input('1', 1000));
    const crossing = await a.commit(input('2', 2500));
    const unknown = await a.commit(input('3', null));
    expect(await a.pruneBefore(3000)).toEqual({ deletedSegments: 0, reclaimedBytes: 0 });
    expect(await a.hasMedia([old.id])).toBe(true);
    expect(await a.hasMedia([crossing.id, unknown.id])).toBe(true);
    expect(await a.hasMedia([])).toBe(true);
    expect(await a.deleteUnlocated(subject.id)).toEqual({ deletedSegments: 1, reclaimedBytes: 4 });
    expect((await a.timeline(subject.id, 0, 10000)).unlocatedCount).toBe(0);
    expect((await a.timeline(subject.id, 0, 10000)).segments.map((s) => s.id)).toEqual([
      old.id,
      crossing.id,
    ]);
    await a.close();
    const b = await create();
    await expect(b.commit(input('3', null))).rejects.toThrow('SOURCE_SEGMENT_DELETED');
  });

  it('changes batch policies atomically only when all IDs exist', async () => {
    const a = await create();
    await a.upsertSubjects([subject, { id: 'stripchat:456', providerId: 456, handle: 'other' }]);
    await expect(
      a.setPolicies([subject.id, 'stripchat:789'], { autoRecord: true }),
    ).rejects.toThrow('SUBJECT_NOT_FOUND');
    expect((await a.listSubjects()).every((s) => !s.autoRecord)).toBe(true);
    expect(await a.setPolicies([subject.id, 'stripchat:456'], { autoRecord: true })).toBe(2);
    expect((await a.listSubjects()).every((s) => s.autoRecord)).toBe(true);
  });

  it.each(['ENOSPC', 'EROFS'])(
    'fails closed on %s then safely resumes after reopening a repaired volume',
    async (errorCode) => {
      const a = await create((point) => {
        if (point === 'before-journal-write')
          throw Object.assign(new Error(errorCode), { code: errorCode });
      });
      await a.upsertSubjects([subject]);
      await expect(a.commit(input())).rejects.toThrow(errorCode);
      await expect(a.sourceCheckpoint(subject.id)).rejects.toThrow('ARCHIVE_REQUIRES_RECOVERY');
      await a.close();
      const b = await create();
      expect(await b.sourceCheckpoint(subject.id)).toBeNull();
      expect((await b.timeline(subject.id, 0, 10000)).segments).toHaveLength(0);
      await vi.waitFor(async () =>
        expect(
          await readdir(
            path.join(root, 'media', 'subjects', 'stripchat-123', 'recordings', '.orphaned'),
          ),
        ).toHaveLength(2),
      );
      await b.commit(input());
      expect(await b.sourceCheckpoint(subject.id)).toMatchObject({ highestSequence: '1' });
    },
  );

  it('detects a rewritten middle journal record even with a valid last checkpoint', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    await a.commit(input());
    await a.commit(input('2', 4000));
    await a.close();
    const filename = path.join(root, 'media', 'postgres-journal', 'active.log');
    const bytes = await readFile(filename);
    bytes[20] ^= 1;
    await writeFile(filename, bytes);
    await expect(create()).rejects.toThrow('LIBRARY_JOURNAL_CORRUPT');
  });

  it('reuses the hot index after clean restart and restores a lost index without scanning historical media', async () => {
    let armed = false;
    const a = await create((point) => {
      if (armed && point === 'after-journal-sync') throw new Error('INJECTED');
    });
    await a.upsertSubjects([subject]);
    for (let i = 0; i < 10; i++) await a.commit(input(String(i), i * 3000));
    await a.close();
    const b = await create();
    expect(b.recoveryStats()).toMatchObject({
      cleanStartup: true,
      objectsVerified: 0,
    });
    await b.close();
    const c = await create((point) => {
      if (armed && point === 'after-journal-sync') throw new Error('INJECTED');
    });
    armed = true;
    await expect(c.commit(input('10', 30000))).rejects.toThrow('INJECTED');
    await c.close();
    // The injected archive hook follows the atomic metadata transaction. Lose
    // the disposable index to exercise actual journal recovery, rather than
    // expecting an already committed transaction to be applied twice.
    await dropTestDatabase(libraryIndexPath(root));
    const d = await create();
    expect(d.recoveryStats().cleanStartup).toBe(false);
    expect(d.recoveryStats().journalRecordsApplied).toBeGreaterThan(0);
    expect(d.recoveryStats().objectsVerified).toBe(0);
    expect(await d.sourceCheckpoint(subject.id)).toMatchObject({ highestSequence: '10' });
    expect((await d.timeline(subject.id, 0, 40000)).segments).toHaveLength(11);
  });

  it('recovers transient garbage collection without poisoning reads or new recording commits', async () => {
    let blocked = false;
    const a = await create((point) => {
      if (blocked && point === 'before-unlink')
        throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    });
    await a.upsertSubjects([subject]);
    const removed = await a.commit(input('1', null));
    blocked = true;
    await expect(a.deleteUnlocated(subject.id)).rejects.toThrow('EROFS');
    blocked = false;
    await expect(a.getSetting('health.probe')).resolves.toBeNull();
    const recorded = await a.commit(input('2', 5000));
    await a.deleteUnlocated(subject.id);
    expect(await a.hasMedia([removed.id])).toBe(false);
    expect(await a.hasMedia([recorded.id])).toBe(true);
    expect((await a.timeline(subject.id, 0, 10000)).segments.map((s) => s.id)).toEqual([
      recorded.id,
    ]);
  });

  it('retries a read-only unlink failure from durable tombstones and reclaims unlocated init', async () => {
    let armed = false;
    const a = await create((point) => {
      if (armed && point === 'before-unlink')
        throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    });
    await a.upsertSubjects([subject]);
    const s = await a.commit(input('1', null));
    armed = true;
    await expect(a.deleteUnlocated(subject.id)).rejects.toThrow('EROFS');
    await a.close();
    const b = await create();
    expect(await b.hasMedia([s.id])).toBe(false);
    expect((await b.timeline(subject.id, 0, 10000)).unlocatedCount).toBe(0);
    expect(
      (await readdir(path.join(root, 'media', 'subjects', 'stripchat-123', 'recordings'))).filter(
        (s) => /\.(mp4|m4s)$/.test(s),
      ),
    ).toEqual([]);
    expect(await b.sourceCheckpoint(subject.id)).toMatchObject({ highestSequence: '1' });
  });

  it('drains an already accepted multi-subject retention sweep before close', async () => {
    const a = await create();
    await a.upsertSubjects([subject, { id: 'stripchat:456', providerId: 456, handle: 'other' }]);
    await a.commit(input());
    await a.commit({ ...input(), subjectId: 'stripchat:456' });
    const pruning = a.pruneBefore(3000);
    const closing = a.close();
    expect(await pruning).toEqual({ deletedSegments: 2, reclaimedBytes: 14 });
    await closing;
    const b = await create();
    expect((await b.timeline(subject.id, 0, 10000)).segments).toHaveLength(0);
  });

  it('refuses a rewritten checkpoint prefix followed by a torn append without truncating the evidence', async () => {
    const a = await create();
    await a.upsertSubjects([subject]);
    await a.commit(input());
    await a.commit(input('2', 4000));
    await a.close();
    const filename = path.join(root, 'media', 'postgres-journal', 'active.log');
    const bytes = await readFile(filename);
    bytes[20] ^= 1;
    const damaged = Buffer.concat([bytes, Buffer.from('STP1partial')]);
    await writeFile(filename, damaged);
    await expect(create()).rejects.toThrow('LIBRARY_JOURNAL_CORRUPT');
    expect(await readFile(filename)).toEqual(damaged);
  });
});
