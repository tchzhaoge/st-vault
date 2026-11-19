import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  readdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicJson, fileHash, regularFile, syncDirectory, libraryIdPattern } from './files.js';
import { portableSetting, PrivateSettings } from './legacy-settings.js';
import { snapshotFilePath, subjectImagePath } from './paths.js';

const code = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : null;
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const portableTables = new Set([
  'subjects',
  'subject_images',
  'subject_name_history',
  'account_subjects',
  'journal_heads',
  'counters',
  'objects',
  'segments',
  'source_checkpoints',
  'coverage_minutes',
  'status_intervals',
  'status_heads',
  'event_meta',
  'archive_events',
  'status_event_states',
  'program_runs',
  'personal_owner',
  'media_deletions',
  'deletion_plans',
  'deletion_intents',
  'deletion_items',
  'deletion_units',
  'deletion_ranges',
  'recording_units',
  'unit_segments',
  'unit_favorites',
  'unit_index',
  'account_preparations',
  'media_selections',
  'selection_units',
  'favorite_commands',
  'selection_edits',
  'selection_pins',
  'selection_deletion_copies',
  'deletion_seeds',
  'deletion_growth',
]);
/** Offline, bounded-memory export. Source is retained; immutable files use hard links on one volume. */
export async function migrateLibrary(options: {
  source: string;
  data: string;
  media: string;
  progress?: (stage: string, done: number) => void;
}): Promise<void> {
  const source = path.resolve(options.source),
    data = path.resolve(options.data),
    media = path.resolve(options.media);
  for (const [a, b] of [
    [source, data],
    [source, media],
    [data, media],
  ])
    if (a === b || !path.relative(a, b).startsWith('..') || !path.relative(b, a).startsWith('..'))
      throw Error('MIGRATION_PATHS_MUST_BE_SEPARATE');
  regularFile(path.join(source, 'metadata.sqlite'));
  const lock = new DatabaseSync(path.join(source, 'instance-lock.sqlite'));
  let input: DatabaseSync | undefined,
    output: DatabaseSync | undefined,
    privateDb: PrivateSettings | undefined;
  let targetLock: DatabaseSync | undefined;
  let workspace: string | undefined;
  try {
    lock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');
    // A clean old runtime checkpoints its WAL on close. Copy the immutable main
    // database sequentially before heavy random-access SQL on container-local disk.
    try {
      if ((await stat(path.join(source, 'metadata.sqlite-wal'))).size > 0)
        throw Error('MIGRATION_REQUIRES_CHECKPOINTED_WAL');
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
    workspace = await mkdtemp(path.join(tmpdir(), 'stv-library-migration-'));
    const metadataSource = path.join(workspace, 'source.sqlite');
    await copyFile(path.join(source, 'metadata.sqlite'), metadataSource);
    input = new DatabaseSync(metadataSource, { readOnly: true });
    input.exec('PRAGMA cache_size=-32768');
    if (input.prepare('PRAGMA user_version').get()!.user_version !== 5)
      throw Error('MIGRATION_REQUIRES_CURRENT_ARCHIVE');
    if (input.prepare("SELECT value FROM settings WHERE key='archive.clean'").get()?.value !== '1')
      throw Error('MIGRATION_REQUIRES_CLEAN_SHUTDOWN');
    if (input.prepare('SELECT ready FROM unit_index WHERE id=1').get()?.ready !== 1)
      throw Error('MIGRATION_REQUIRES_COMPLETED_UNIT_INDEX');
    await mkdir(data, { recursive: true, mode: 0o700 });
    await mkdir(media, { recursive: true, mode: 0o700 });
    const marker = path.join(data, 'library-migration.json');
    let id: string;
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8')) as {
        library: string;
        source: string;
        media: string;
      };
      if (saved.source !== source || saved.media !== media)
        throw Error('MIGRATION_MARKER_CONFLICT');
      if (!libraryIdPattern.test(saved.library)) throw Error('MIGRATION_MARKER_CONFLICT');
      id = saved.library;
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      if ((await readdir(data)).length || (await readdir(media)).length)
        throw Error('MIGRATION_REQUIRES_EMPTY_TARGETS');
      id = randomUUID();
      atomicJson(marker, { source, media, library: id, state: 'copying' });
    }
    targetLock = new DatabaseSync(path.join(media, 'instance-lock.sqlite'));
    targetLock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');
    try {
      await stat(path.join(media, 'library.json'));
      throw Error('MIGRATION_LIBRARY_ALREADY_PUBLISHED');
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
    const directories = new Set<string>();
    const creating = new Map<string, Promise<void>>();
    const ensure = async (filename: string): Promise<void> => {
      const directory = path.dirname(filename);
      if (directories.has(directory)) return;
      if (creating.has(directory)) return creating.get(directory);
      const work = (async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (
          let current = directory;
          current !== path.dirname(media) && current !== path.dirname(data);
          current = path.dirname(current)
        ) {
          const info = await lstat(current);
          if (!info.isDirectory() || info.isSymbolicLink()) throw Error('UNSAFE_MIGRATION_PATH');
        }
        directories.add(directory);
      })();
      creating.set(directory, work);
      try {
        await work;
      } finally {
        creating.delete(directory);
      }
    };
    const clone = async (from: string, to: string): Promise<void> => {
      const original = await lstat(from);
      if (!original.isFile() || original.isSymbolicLink()) throw Error('UNSAFE_MIGRATION_SOURCE');
      await ensure(to);
      try {
        const info = await lstat(to);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          (!(info.ino === original.ino && info.dev === original.dev) &&
            fileHash(from) !== fileHash(to))
        )
          throw Error('MIGRATION_FILE_CONFLICT');
        return;
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
      try {
        await link(from, to);
      } catch (error) {
        if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOSYS'].includes(String(code(error)))) throw error;
        const temporary = to + '.copying';
        await copyFile(from, temporary, constants.COPYFILE_FICLONE);
        if (fileHash(from) !== fileHash(temporary)) throw Error('MIGRATION_COPY_MISMATCH');
        const file = await open(temporary, 'r+');
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, to);
      }
    };
    await mkdir(path.join(media, 'catalog'), { recursive: true });
    await mkdir(path.join(media, 'journal'), { recursive: true });
    const snapshot = path.join(media, 'catalog', '0.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      try {
        regularFile(snapshot + suffix);
        await unlink(snapshot + suffix);
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
    const localSnapshot = path.join(workspace, 'library.sqlite');
    output = new DatabaseSync(localSnapshot);
    output.exec(
      'PRAGMA foreign_keys=OFF;PRAGMA cache_size=-65536;PRAGMA journal_mode=DELETE;BEGIN IMMEDIATE',
    );
    // A fresh database, rather than deleting credentials from a copy, also keeps secrets out of free pages.
    const schema = input
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string }[];
    for (const row of schema)
      if (
        row.type === 'table' &&
        !portableTables.has(row.name) &&
        !['settings', 'journal_checkpoints'].includes(row.name)
      )
        throw Error('MIGRATION_UNKNOWN_TABLE');
    for (const row of schema)
      if (row.type === 'table' && portableTables.has(row.name)) output.exec(row.sql);
    output.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    output.prepare('ATTACH DATABASE ? AS source').run(metadataSource);
    let tablesCopied = 0;
    for (const row of schema)
      if (row.type === 'table' && portableTables.has(row.name)) {
        output.exec(
          `DELETE FROM ${quote(row.name)};INSERT INTO ${quote(row.name)} SELECT * FROM source.${quote(row.name)}`,
        );
        options.progress?.('metadata', ++tablesCopied);
      }
    privateDb = new PrivateSettings(data);
    for (const row of input.prepare('SELECT key,value FROM settings').iterate() as Iterable<{
      key: string;
      value: string;
    }>)
      if (portableSetting(row.key))
        output.prepare('INSERT INTO settings VALUES(?,?)').run(row.key, row.value);
      else privateDb.set(row.key, row.value);
    for (const row of schema)
      if (
        row.type !== 'table' &&
        (portableTables.has(row.tbl_name) || row.name === 'visible_segments')
      )
        output.exec(row.sql);
    output.exec(
      'CREATE TABLE library_state(id INTEGER PRIMARY KEY CHECK(id=1),library TEXT NOT NULL,sequence INTEGER NOT NULL)',
    );
    output.prepare('INSERT INTO library_state VALUES(1,?,0)').run(id);
    output.exec('PRAGMA user_version=5;COMMIT;DETACH DATABASE source');
    if (output.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok')
      throw Error('MIGRATION_DATABASE_INVALID');
    if (output.prepare('PRAGMA foreign_key_check').get())
      throw Error('MIGRATION_FOREIGN_KEY_INVALID');
    output.close();
    output = undefined;
    options.progress?.('metadata-verified', tablesCopied);
    await copyFile(localSnapshot, snapshot);
    privateDb.close();
    privateDb = undefined;
    let copied = 0;
    const batch: Promise<void>[] = [];
    for (const row of input
      .prepare('SELECT subject,filename,deleted FROM objects WHERE deleted=0 OR gc_done=0')
      .iterate() as Iterable<{ subject: string; filename: string; deleted: number }>) {
      if (
        !/^stripchat:[1-9]\d*$/.test(row.subject) ||
        !/^(?:(?:\d{4}-\d{2}-\d{2}\/\d{2}|unlocated)\/)?(?:seg|init)-[a-f0-9-]+\.(?:m4s|mp4)$/.test(
          row.filename,
        )
      )
        throw Error('MIGRATION_INVALID_OBJECT_PATH');
      const name = 'stripchat-' + row.subject.slice(10);
      batch.push(
        (async () => {
          try {
            await clone(
              path.join(source, 'media', name, row.filename),
              path.join(media, 'subjects', name, 'recordings', row.filename),
            );
          } catch (error) {
            if (code(error) !== 'ENOENT') throw error;
            if (row.deleted) return;
            throw Error('MIGRATION_MEDIA_MISSING', { cause: error });
          }
          if (++copied % 256 === 0) options.progress?.('recordings', copied);
        })(),
      );
      if (batch.length === 16) {
        const results = await Promise.allSettled(batch.splice(0));
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
    }
    const results = await Promise.allSettled(batch);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    for (const row of input.prepare('SELECT id,provider_id FROM subjects').iterate() as Iterable<{
      id: string;
      provider_id: number;
    }>)
      for (const kind of ['cover', 'avatar'] as const) {
        const key = kind === 'cover' ? `cover:${row.provider_id}` : `avatar:${row.id}`;
        const hash = createHash('sha256').update(key).digest('hex');
        try {
          await clone(
            path.join(
              source,
              'cache',
              'previews',
              kind === 'cover' ? 'covers' : 'avatars',
              hash + '.img',
            ),
            subjectImagePath(media, row.id, kind),
          );
        } catch (error) {
          if (code(error) !== 'ENOENT') throw error;
        }
      }
    try {
      await clone(
        path.join(source, 'private', 'address-key.key'),
        path.join(data, 'private', 'address-key.key'),
      );
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
    const jobsFile = path.join(source, 'cache', 'previews', 'screenshots', 'jobs.sqlite');
    try {
      regularFile(jobsFile);
      const jobs = new DatabaseSync(jobsFile, { readOnly: true });
      try {
        for (const job of jobs
          .prepare(
            "SELECT subject,unit,at,end,hash,rendered_to,media_ids FROM jobs WHERE state='done' AND unit<>''",
          )
          .iterate() as Iterable<{
          subject: string;
          unit: string;
          at: number;
          end: number;
          hash: string;
          rendered_to: number;
          media_ids: string;
        }>) {
          const hash = createHash('sha256').update(job.unit).digest('hex');
          const from = path.join(
              source,
              'cache',
              'previews',
              'screenshots',
              job.subject.slice(10),
              `${job.at}-${job.end}-${hash}.jpg`,
            ),
            to = snapshotFilePath(media, job);
          try {
            await clone(from, to);
            atomicJson(to + '.json', {
              hash: job.hash,
              throughMs: job.rendered_to,
              mediaIds: JSON.parse(job.media_ids) as unknown,
            });
          } catch (error) {
            if (code(error) !== 'ENOENT') throw error;
          }
        }
      } finally {
        jobs.close();
      }
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    }
    for (const directory of directories) syncDirectory(directory);
    const file = await open(snapshot, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    atomicJson(path.join(media, 'library.json'), {
      format: 1,
      id,
      createdAtMs: Number(
        input.prepare("SELECT value FROM settings WHERE key='timeline.deployed-at'").get()!.value,
      ),
      checkpoint: { file: 'catalog/0.sqlite', sequence: 0, hash: fileHash(snapshot) },
    });
    atomicJson(marker, { source, media, library: id, state: 'complete', objects: copied });
    options.progress?.('complete', copied);
  } finally {
    output?.close();
    privateDb?.close();
    input?.close();
    targetLock?.close();
    lock.close();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
