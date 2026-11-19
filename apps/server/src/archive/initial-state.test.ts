import { libraryIndexPath } from '../library/paths.js';
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

it('initializes one complete schema with no account, subjects, media or activity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-initial-'));
  try {
    const archive = await openArchive({ root });
    expect(await archive.listSubjects()).toEqual([]);
    expect(await archive.getSetting('local-auth.password')).toBeNull();
    expect(await archive.getSetting('runtime.settings')).toBeNull();
    await archive.close();
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      expect(await db.prepare('SELECT version FROM catalog_schema WHERE id=1').get()).toMatchObject(
        { version: 1 },
      );
      for (const table of [
        'segments',
        'archive_events',
        'program_runs',
        'recording_units',
        'unit_favorites',
      ])
        expect(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({
          count: 0,
        });
      expect(
        await db
          .prepare(
            "SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() AND TRUE AND tablename IN ('favorite_entries','favorite_ranges','favorite_moments','subject_notes','watch_ranges','watch_ops')",
          )
          .all(),
      ).toEqual([]);
      expect(
        await db
          .prepare(
            `SELECT count(*) AS invalid FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT i.indisvalid`,
          )
          .get(),
      ).toEqual({ invalid: 0 });
    } finally {
      await db.close();
    }
    const reopened = await openArchive({ root });
    expect(await reopened.listSubjects()).toEqual([]);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not guess a replacement deployment time for an incomplete current database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-origin-required-'));
  try {
    const archive = await openArchive({ root });
    await archive.close();
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      await db.prepare('DELETE FROM settings WHERE key=?').run('timeline.deployed-at');
    } finally {
      await db.close();
    }
    await expect(openArchive({ root })).rejects.toThrow('INVALID_TIMELINE_ORIGIN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([-1, 0, 2, 999])(
  'rejects incompatible populated database schema %s without migration',
  async (version) => {
    const root = await mkdtemp(path.join(tmpdir(), 'st-vault-schema-'));
    try {
      const archive = await openArchive({ root });
      await archive.close();
      const db = await openTestDatabase(libraryIndexPath(root));
      await db.exec(`UPDATE catalog_schema SET version=${version} WHERE id=1`);
      await db.close();
      await expect(openArchive({ root })).rejects.toThrow('UNSUPPORTED_ARCHIVE_VERSION');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
