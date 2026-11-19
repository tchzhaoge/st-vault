import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Segment } from '@st-vault/api-schema';
import { openArchive } from '../archive/index.js';
import { migrateLibrary } from './migrate.js';
import { migrateDeployment } from '../database/migrate-deployment.js';

it('exports a legacy database without credentials in portable pages, preserving the source for rollback', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../../../../tests/fixtures/postgresql-upgrade.json', import.meta.url),
      'utf8',
    ),
  ) as {
    catalog: string;
    files: { name: string; base64: string }[];
    expected: { segments: Segment[] };
  };
  const root = await mkdtemp(path.join(tmpdir(), 'stv-migration-'));
  const source = path.join(root, 'source'),
    data = path.join(root, 'data'),
    media = path.join(root, 'media');
  await mkdir(source, { recursive: true });
  let archive: Awaited<ReturnType<typeof openArchive>> | undefined;
  try {
    // Keep the offline SQLite codec fixture independent of the new PG runtime.
    const legacy = new DatabaseSync(path.join(source, 'metadata.sqlite'));
    legacy.exec('PRAGMA foreign_keys=OFF;' + fixture.catalog);
    legacy.exec(
      "DROP TABLE library_state;INSERT INTO settings VALUES('local-auth.fixture','super-secret-never-portable');UPDATE settings SET value='1' WHERE key='archive.clean'",
    );
    const id = randomUUID(),
      bytes = Buffer.from([4, 5]);
    const unknown: Segment = {
      ...fixture.expected.segments[0],
      id,
      mediaObjectId: id,
      sourceEpoch: 'unknown',
      sourceSequence: '1',
      durationSeconds: 1,
      wallStartMs: null,
      wallEndMs: null,
      timeBasis: 'unknown',
    };
    legacy
      .prepare(
        "INSERT INTO objects(id,subject,filename,bytes,hash,kind) VALUES(?,?,?,?,?,'fragment')",
      )
      .run(
        id,
        'stripchat:42',
        `unlocated/seg-${id}.m4s`,
        bytes.length,
        createHash('sha256').update(bytes).digest('hex'),
      );
    legacy
      .prepare(
        'INSERT INTO segments(id,subject,epoch,sequence,media,start,end,json) VALUES(?,?,?,?,?,NULL,NULL,?)',
      )
      .run(id, 'stripchat:42', 'unknown', '1', id, JSON.stringify(unknown));
    legacy.exec("UPDATE subjects SET unlocated=1 WHERE id='stripchat:42'");
    legacy.close();
    const prefix = 'subjects/stripchat-42/recordings/';
    for (const file of fixture.files.filter((file) => file.name.startsWith(prefix))) {
      const target = path.join(source, 'media', 'stripchat-42', file.name.slice(prefix.length));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.base64, 'base64'));
    }
    await mkdir(path.join(source, 'media', 'stripchat-42', 'unlocated'), { recursive: true });
    await writeFile(
      path.join(source, 'media', 'stripchat-42', 'unlocated', `seg-${id}.m4s`),
      bytes,
    );
    await migrateLibrary({ source, data, media });
    expect(
      (await readFile(path.join(media, 'catalog', '0.sqlite'))).includes(
        Buffer.from('super-secret-never-portable'),
      ),
    ).toBe(false);
    await migrateDeployment(data, media);
    archive = await openArchive({ root: data, mediaRoot: media });
    expect(await archive.getSetting('local-auth.fixture')).toBe('super-secret-never-portable');
    expect(await readFile((await archive.media(fixture.expected.segments[0].id))!.path)).toEqual(
      Buffer.from([0, 2, 3]),
    );
    expect((await archive.timeline('stripchat:42', 0, 300000)).unlocatedCount).toBe(1);
    expect(await readFile((await archive.media(id))!.path)).toEqual(bytes);
    const old = new DatabaseSync(path.join(source, 'metadata.sqlite'), { readOnly: true });
    try {
      expect(old.prepare('SELECT COUNT(*) AS n FROM segments').get()!.n).toBe(7);
    } finally {
      old.close();
    }
  } finally {
    await archive?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
