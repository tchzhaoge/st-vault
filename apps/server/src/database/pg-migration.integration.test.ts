import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { startTestPostgres } from './postgres.test-support.js';
import { migrateDeployment } from './migrate-deployment.js';
import { openArchive } from '../archive/index.js';
import { SqlDatabase } from './sql.js';
interface Fixture {
  synthetic: boolean;
  manifest: { format: number; id: string; createdAtMs: number };
  catalog: string;
  privateSql: string;
  files: { name: string; base64: string }[];
  expected: { identity: unknown; segments: { id: string }[]; units: string[] };
}
let database: Awaited<ReturnType<typeof startTestPostgres>>;
beforeAll(async () => {
  database = await startTestPostgres();
}, 30000);
afterAll(async () => {
  await database.close();
});
it('upgrades a real SQLite-format fixture without changing media, identity, private settings or favorites', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../../../../tests/fixtures/postgresql-upgrade.json', import.meta.url),
      'utf8',
    ),
  ) as Fixture;
  expect(fixture.synthetic).toBe(true);
  const root = await mkdtemp(path.join(tmpdir(), 'stv-pg-upgrade-'));
  const data = path.join(root, 'data'),
    media = path.join(root, 'media');
  await mkdir(path.join(data, 'indexes', fixture.manifest.id), { recursive: true });
  await mkdir(media, { recursive: true });
  let archive: Awaited<ReturnType<typeof openArchive>> | undefined;
  try {
    const source = new DatabaseSync(
      path.join(data, 'indexes', fixture.manifest.id, 'metadata.sqlite'),
    );
    source.exec('PRAGMA foreign_keys=OFF;' + fixture.catalog + 'PRAGMA foreign_keys=ON;');
    source.close();
    const privateSource = new DatabaseSync(path.join(data, 'app.sqlite'));
    privateSource.exec(fixture.privateSql);
    privateSource.close();
    const queueRoot = path.join(data, 'jobs', fixture.manifest.id, 'screenshots');
    await mkdir(queueRoot, { recursive: true });
    const queueSource = new DatabaseSync(path.join(queueRoot, 'jobs.sqlite'));
    queueSource.exec(
      "CREATE TABLE scan(subject TEXT PRIMARY KEY,unit_cursor TEXT);INSERT INTO scan VALUES('stripchat:42','first')",
    );
    queueSource.close();
    await writeFile(path.join(media, 'library.json'), JSON.stringify(fixture.manifest));
    for (const file of fixture.files) {
      const target = path.resolve(media, file.name);
      if (!target.startsWith(media + path.sep)) throw Error('UNSAFE_FIXTURE_PATH');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.base64, 'base64'));
    }
    // A failed attempt followed by an old-version settings change must freeze a
    // new source generation rather than resume stale private credentials.
    const interrupted = new AbortController();
    const originalInfo = console.info;
    const logging = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      originalInfo(...args);
      if (typeof args[0] === 'string' && args[0].includes('"stage":"import_table"'))
        interrupted.abort(new Error('TEST_UPGRADE_INTERRUPTED'));
    });
    try {
      await expect(migrateDeployment(data, media, interrupted.signal)).rejects.toThrow(
        'TEST_UPGRADE_INTERRUPTED',
      );
    } finally {
      logging.mockRestore();
    }
    expect(
      (JSON.parse(await readFile(path.join(media, 'library.json'), 'utf8')) as { format: number })
        .format,
    ).toBe(1);
    const changedPrivate = new DatabaseSync(path.join(data, 'app.sqlite'));
    changedPrivate.exec(
      "UPDATE settings SET value='preserved-after-interruption' WHERE key='fixture.private'",
    );
    changedPrivate.close();
    const secondAttempt = new AbortController();
    const secondLogging = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      originalInfo(...args);
      if (typeof args[0] === 'string' && args[0].includes('"stage":"import_table"'))
        secondAttempt.abort(new Error('TEST_QUEUE_UPGRADE_INTERRUPTED'));
    });
    try {
      await expect(migrateDeployment(data, media, secondAttempt.signal)).rejects.toThrow(
        'TEST_QUEUE_UPGRADE_INTERRUPTED',
      );
    } finally {
      secondLogging.mockRestore();
    }
    const changedQueue = new DatabaseSync(path.join(queueRoot, 'jobs.sqlite'));
    changedQueue.exec("UPDATE scan SET unit_cursor='latest'");
    changedQueue.close();
    await migrateDeployment(data, media);
    expect(
      await readdir(path.join(data, 'backups', 'postgresql-' + fixture.manifest.id)),
    ).toHaveLength(3);
    const migratedQueue = await SqlDatabase.open(path.join(queueRoot, 'jobs'));
    try {
      expect(await migratedQueue.prepare('SELECT unit_cursor FROM scan').get()).toEqual({
        unit_cursor: 'latest',
      });
    } finally {
      await migratedQueue.close();
    }
    expect(JSON.parse(await readFile(path.join(media, 'library.json'), 'utf8'))).toMatchObject({
      format: 2,
      id: fixture.manifest.id,
      checkpoint: { sequence: 0 },
    });
    archive = await openArchive({ root: data, mediaRoot: media });
    expect(await archive.identity()).toEqual(fixture.expected.identity);
    expect(
      (await archive.timeline('stripchat:42', 60000, 240000)).segments.map((segment) => segment.id),
    ).toEqual(fixture.expected.segments.map((segment) => segment.id));
    expect(await archive.getSetting('fixture.private')).toBe('preserved-after-interruption');
    expect(
      (await archive.personal('stripchat:42', 60000, 240000)).favorites.map(
        (favorite) => favorite.id,
      ),
    ).toEqual([fixture.expected.units[0]]);
    await archive.close();
    archive = undefined;
    await migrateDeployment(data, media); // Completed upgrades are idempotent.
    archive = await openArchive({ root: path.join(root, 'cold-data'), mediaRoot: media });
    expect(await archive.identity()).toEqual(fixture.expected.identity);
    expect((await archive.timeline('stripchat:42', 60000, 240000)).segments).toHaveLength(6);
    expect((await archive.personal('stripchat:42', 60000, 240000)).favorites).toHaveLength(1);
    expect(await archive.getSetting('fixture.private')).toBeNull();
  } finally {
    await archive?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
