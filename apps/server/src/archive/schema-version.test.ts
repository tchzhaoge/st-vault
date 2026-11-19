import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTestDatabase } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
import { libraryIndexPath } from '../library/paths.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it.each([3, 4])('rejects retired schema %s without rewriting the library', async (version) => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-schema-boundary-'));
  try {
    const archive = await openArchive({ root });
    await archive.close();
    const filename = libraryIndexPath(root),
      db = await openTestDatabase(filename);
    await db.exec(`UPDATE catalog_schema SET version=${version} WHERE id=1`);
    await db.close();
    const manifest = path.join(root, 'media', 'library.json');
    const before = await readFile(manifest);
    await expect(openArchive({ root })).rejects.toThrow('UNSUPPORTED_ARCHIVE_VERSION');
    expect(await readFile(manifest)).toEqual(before);
    const inspected = await openTestDatabase(filename);
    try {
      expect(await inspected.prepare('SELECT version FROM catalog_schema').get()).toEqual({
        version,
      });
    } finally {
      await inspected.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
