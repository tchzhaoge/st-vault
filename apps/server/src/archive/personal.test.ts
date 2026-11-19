import { libraryIndexPath } from '../library/paths.js';
import { like, unlike } from '../../../../tests/support/unit-selection.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTestDatabase } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it('rejects stale revisions across subjects and restores retention after confirmed cancellation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-unlike-range-'));
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([
      { id: 'stripchat:1', providerId: 1, handle: 'one' },
      { id: 'stripchat:2', providerId: 2, handle: 'two' },
    ]);
    for (const id of ['stripchat:1', 'stripchat:2'])
      await archive.commit({
        subjectId: id,
        sourceEpoch: 'test',
        sourceSequence: '1',
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 1,
        wallStartMs: 65000,
        timeBasis: 'source-pdt',
        uncertaintyMs: null,
        discontinuity: false,
      });
    const selection = [{ atMs: 65000, fromMs: 60000, toMs: 120000 }];
    const first = await like(archive, 'stripchat:1', selection);
    const second = await like(archive, 'stripchat:2', selection);
    await expect(unlike(archive, 'stripchat:1', selection, first.revision)).rejects.toThrow(
      'PERSONAL_REVISION_STALE',
    );
    expect((await archive.personal('stripchat:1', 0, 180000)).favorites).toHaveLength(1);
    expect(await unlike(archive, 'stripchat:1', selection, second.revision)).toEqual({
      removed: 1,
      revision: second.revision + 1,
    });
    expect((await archive.pruneBefore(180000)).deletedSegments).toBe(1);
    expect((await archive.timeline('stripchat:1', 0, 180000)).segments).toHaveLength(0);
    expect((await archive.timeline('stripchat:2', 0, 180000)).segments).toHaveLength(1);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rolls back deleted favorites and protection when revision persistence fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-unlike-atomic-'));
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'one' }]);
    await archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'test',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 65000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const selection = [{ atMs: 65000, fromMs: 60000, toMs: 120000 }];
    const saved = await like(archive, 'stripchat:1', selection);
    // Fault injection is a second writer alongside normal background work.
    // Wait for its short transaction rather than making setup depend on timing.
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      await db.exec(
        "CREATE FUNCTION synthetic_revision_failure() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'synthetic revision failure';END $body$;\n      CREATE TRIGGER synthetic_revision_failure BEFORE UPDATE ON personal_owner FOR EACH ROW EXECUTE FUNCTION synthetic_revision_failure()",
      );
    } finally {
      await db.close();
    }
    await expect(unlike(archive, 'stripchat:1', selection, saved.revision)).rejects.toThrow(
      'METADATA_OPERATION_FAILED',
    );
    const restored = await archive.personal('stripchat:1', 0, 180000);
    expect(restored.favorites).toHaveLength(1);
    expect(restored.revision).toBe(saved.revision);
    expect((await archive.pruneBefore(180000)).deletedSegments).toBe(0);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('persists identity and favorites independently from recording retention', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-personal-'));
  let archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'fixture' }]);
    await archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'test',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 2000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const identity = await archive.identity(),
      favorite = (await like(archive, 'stripchat:1', [{ atMs: 2000, fromMs: 2000, toMs: 3000 }]))
        .favorites[0];
    await archive.pruneBefore(5000);
    await archive.close();
    archive = await openArchive({ root });
    expect(await archive.identity()).toEqual(identity);
    expect(identity.userId).not.toBe(identity.instanceId);
    expect((await archive.personal('stripchat:1', 0, 10000)).favorites).toEqual([favorite]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
