import { DatabaseSync } from 'node:sqlite';
import {
  mkdtemp,
  rm,
  cp,
  appendFile,
  readFile,
  writeFile,
  readdir,
  symlink,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LibraryStorage, type LibraryFault } from './legacy-storage.js';

const roots: string[] = [];
const opened: { library: LibraryStorage; db: DatabaseSync }[] = [];
afterEach(async () => {
  for (const { library, db } of opened.splice(0)) {
    await library.close();
    if (db.isOpen) db.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-'));
  roots.push(root);
  return { root, data: path.join(root, 'data'), media: path.join(root, 'media') };
}
async function open(data: string, media: string, fault?: LibraryFault) {
  const library = new LibraryStorage(data, media, fault),
    db = new DatabaseSync(library.indexFile);
  db.exec(
    'PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,value TEXT NOT NULL)',
  );
  const value = { library, db };
  opened.push(value);
  await library.attach(db);
  return value;
}
it('restores complete committed facts using only the moved media directory and fresh local data', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('former-name', 'old handle'),
  );
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('favorite', 'unit-id'),
  );
  await a.library.close();
  a.db.close();
  const moved = path.join(f.root, 'another-volume', 'portable');
  await cp(f.media, moved, { recursive: true });
  const b = await open(path.join(f.root, 'fresh-instance'), moved);
  expect(b.db.prepare('SELECT * FROM facts ORDER BY id').all()).toEqual([
    { id: 'favorite', value: 'unit-id' },
    { id: 'former-name', value: 'old handle' },
  ]);
  expect(b.library.status()).toMatchObject({ sequence: 2, replayed: 2 });
});
it('recovers a durable intent after interruption between journal synchronization and index commit', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media, (point) => {
      if (point === 'after-journal-sync') throw Error('SIMULATED_LOSS');
    });
  expect(() =>
    a.library.transaction(a.db, () => a.db.exec("INSERT INTO facts VALUES('deletion','queued')")),
  ).toThrow('SIMULATED_LOSS');
  expect(a.db.prepare('SELECT * FROM facts').all()).toEqual([]);
  await a.library.close();
  a.db.close();
  const b = await open(f.data, f.media);
  expect(b.db.prepare('SELECT value FROM facts').get()!.value).toBe('queued');
  expect(b.library.status().sequence).toBe(1);
});
it('does not poison later writes when domain validation rejects a transaction before publication', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  expect(() =>
    a.library.transaction(a.db, () => {
      a.db.exec("INSERT INTO facts VALUES('x','ignored')");
      throw Error('STALE_REVISION');
    }),
  ).toThrow('STALE_REVISION');
  a.library.transaction(a.db, () => a.db.exec("INSERT INTO facts VALUES('x','valid')"));
  expect(a.db.prepare('SELECT value FROM facts').get()!.value).toBe('valid');
});
it('publishes atomic checkpoints and replays later changes across restart and journal rotation', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  a.library.transaction(a.db, () => a.db.exec("INSERT INTO facts VALUES('x','first')"));
  await a.library.close();
  a.db.close();
  const b = await open(f.data, f.media);
  await b.library.checkpoint();
  b.library.transaction(b.db, () => b.db.exec("UPDATE facts SET value='second'"));
  await b.library.checkpoint();
  b.library.transaction(b.db, () => b.db.exec("UPDATE facts SET value='third'"));
  await b.library.close();
  b.db.close();
  await rm(f.data, { recursive: true, force: true });
  const c = await open(f.data, f.media);
  expect(c.db.prepare('SELECT value FROM facts').get()!.value).toBe('third');
  expect(c.library.status().replayed).toBe(1);
  expect(
    (await readdir(path.join(f.media, 'catalog'))).filter((name) => name.endsWith('.sqlite'))
      .length,
  ).toBeLessThanOrEqual(2);
});
it('truncates only an incomplete unacknowledged tail and refuses a checksummed-record corruption', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  a.library.transaction(a.db, () => a.db.exec("INSERT INTO facts VALUES('x','valid')"));
  await a.library.close();
  a.db.close();
  const log = path.join(f.media, 'journal', 'active.log'),
    before = await readFile(log);
  await appendFile(log, Buffer.from('STJ1partial'));
  const b = await open(f.data, f.media);
  expect((await readFile(log)).equals(before)).toBe(true);
  await b.library.close();
  b.db.close();
  const bad = Buffer.from(before);
  bad[bad.length - 1] ^= 1;
  await writeFile(log, bad);
  await expect(open(f.data, f.media)).rejects.toThrow('LIBRARY_JOURNAL_CORRUPT');
});
it('uses the previous verified checkpoint and retained log if the newest checkpoint is damaged', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  a.library.transaction(a.db, () => a.db.exec("INSERT INTO facts VALUES('x','first')"));
  await a.library.checkpoint();
  a.library.transaction(a.db, () => a.db.exec("UPDATE facts SET value='latest'"));
  await a.library.checkpoint();
  const checkpoint = a.library.manifest.checkpoint!.file;
  await a.library.close();
  a.db.close();
  await writeFile(path.join(f.media, checkpoint), 'damaged');
  await rm(f.data, { recursive: true, force: true });
  const b = await open(f.data, f.media);
  expect(b.db.prepare('SELECT value FROM facts').get()!.value).toBe('latest');
  expect(b.library.status().replayed).toBe(1);
});
it('removes an unpublished checkpoint on failure and keeps the authoritative log recoverable', async () => {
  const f = await fixture();
  let fail = false;
  const a = await open(f.data, f.media, (point) => {
    if (fail && point === 'before-checkpoint-publish') throw Error('SIMULATED_FAILURE');
  });
  a.library.transaction(a.db, () => a.db.exec("INSERT INTO facts VALUES('x','durable')"));
  fail = true;
  await expect(a.library.checkpoint()).rejects.toThrow('SIMULATED_FAILURE');
  expect(
    (await readdir(path.join(f.media, 'catalog'))).some((name) =>
      /\.tmp(?:-journal|-wal|-shm)?$/.test(name),
    ),
  ).toBe(false);
  await a.library.close();
  a.db.close();
  await rm(f.data, { recursive: true, force: true });
  const b = await open(f.data, f.media);
  expect(b.db.prepare('SELECT value FROM facts').get()!.value).toBe('durable');
});
it('keeps commits made while an online checkpoint is in progress after a cold restore', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  a.library.transaction(a.db, () => a.db.exec("INSERT INTO facts VALUES('x','before')"));
  const saving = a.library.checkpoint();
  a.library.transaction(a.db, () => a.db.exec("UPDATE facts SET value='during'"));
  await saving;
  a.library.transaction(a.db, () => a.db.exec("UPDATE facts SET value='after'"));
  await a.library.close();
  a.db.close();
  await rm(f.data, { recursive: true, force: true });
  const b = await open(f.data, f.media);
  expect(b.db.prepare('SELECT value FROM facts').get()!.value).toBe('after');
});
it('pins the checkpoint sequence before concurrent writes instead of restarting the backup', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('x', 'x'.repeat(2 * 1024 * 1024)),
  );
  const frozenSequence = a.library.status().sequence;
  const saving = a.library.checkpoint();
  for (let i = 0; i < 20; i++)
    a.library.transaction(a.db, () =>
      a.db.prepare('INSERT INTO facts VALUES(?,?)').run(`during-${i}`, 'concurrent'),
    );
  await saving;
  expect(a.library.manifest.checkpoint!.sequence).toBe(frozenSequence);
  const snapshot = new DatabaseSync(path.join(f.media, a.library.manifest.checkpoint!.file), {
    readOnly: true,
  });
  try {
    expect(snapshot.prepare('SELECT count(*) n FROM facts').get()!.n).toBe(1);
  } finally {
    snapshot.close();
  }
});
it('cancels an unfinished derived checkpoint on close while retaining the recoverable journal', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  const previous = a.library.manifest.checkpoint!.sequence;
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('durable', 'x'.repeat(2 * 1024 * 1024)),
  );
  const saving = a.library.checkpoint();
  await a.library.close();
  await saving;
  expect(a.library.manifest.checkpoint!.sequence).toBe(previous);
  expect(a.library.status().checkpointFailed).toBe(false);
  expect(
    (await readdir(path.join(f.media, 'catalog'))).some((name) =>
      /\.tmp(?:-journal|-wal|-shm)?$/.test(name),
    ),
  ).toBe(false);
  a.db.close();
  await rm(f.data, { recursive: true, force: true });
  const restored = await open(f.data, f.media);
  expect(
    restored.db.prepare('SELECT length(value) n FROM facts WHERE id=?').get('durable')!.n,
  ).toBe(2 * 1024 * 1024);
});
it('cancels a checkpoint hash during close without marking persistence as failed', async () => {
  const f = await fixture();
  let cancel = false,
    closing: Promise<void> | undefined;
  const a = await open(f.data, f.media, (point) => {
    if (cancel && point === 'before-checkpoint-hash')
      queueMicrotask(() => {
        closing = a.library.close();
      });
  });
  const previous = a.library.manifest.checkpoint!.sequence;
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('durable', 'x'.repeat(2 * 1024 * 1024)),
  );
  cancel = true;
  await a.library.checkpoint();
  expect(closing).toBeDefined();
  await closing;
  expect(a.library.manifest.checkpoint!.sequence).toBe(previous);
  expect(a.library.status().checkpointFailed).toBe(false);
  expect(
    (await readdir(path.join(f.media, 'catalog'))).some((name) =>
      /\.tmp(?:-journal|-wal|-shm)?$/.test(name),
    ),
  ).toBe(false);
  a.db.close();
  await rm(f.data, { recursive: true, force: true });
  const restored = await open(f.data, f.media);
  expect(
    restored.db.prepare('SELECT length(value) n FROM facts WHERE id=?').get('durable')!.n,
  ).toBe(2 * 1024 * 1024);
});
it('resumes a cancelled sealed checkpoint after restart without waiting for new active log growth', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('durable', 'x'.repeat(1024 * 1024)),
  );
  const saving = a.library.checkpoint();
  await a.library.close();
  await saving;
  a.db.close();
  const b = await open(f.data, f.media);
  expect(b.library.status().journalBytes).toBe(0);
  expect(b.library.needsCheckpoint()).toBe(true);
  await b.library.checkpoint();
  expect(b.library.needsCheckpoint()).toBe(false);
  await b.library.close();
  b.db.close();
  // The previous checkpoint still needs a retained sealed log for fallback;
  // its presence alone must not schedule another checkpoint.
  expect(
    (await readdir(path.join(f.media, 'journal'))).some(
      (name) => name.endsWith('.log') && name !== 'active.log',
    ),
  ).toBe(true);
  const c = await open(f.data, f.media);
  expect(c.library.needsCheckpoint()).toBe(false);
});
it('replays changesets spanning several bounded read blocks without dropping the following record', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media),
    value = 'x'.repeat(700000);
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('large', value),
  );
  a.library.transaction(a.db, () =>
    a.db.prepare('INSERT INTO facts VALUES(?,?)').run('next', 'complete'),
  );
  await a.library.close();
  a.db.close();
  await rm(f.data, { recursive: true, force: true });
  const b = await open(f.data, f.media);
  expect(b.db.prepare('SELECT value FROM facts WHERE id=?').get('large')!.value).toBe(value);
  expect(b.db.prepare('SELECT value FROM facts WHERE id=?').get('next')!.value).toBe('complete');
});
it('rejects a dangling journal symlink without creating its external target', async () => {
  const f = await fixture(),
    a = await open(f.data, f.media);
  await a.library.close();
  a.db.close();
  const active = path.join(f.media, 'journal', 'active.log'),
    outside = path.join(f.root, 'never-create');
  await rm(active);
  await symlink(outside, active);
  await expect(open(f.data, f.media)).rejects.toThrow('UNSAFE_LIBRARY_FILE');
  await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
});
