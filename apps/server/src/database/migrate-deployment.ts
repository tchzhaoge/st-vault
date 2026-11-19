import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, lstat, open, rename, unlink } from 'node:fs/promises';
import {
  atomicJson,
  regularFile,
  libraryIdPattern,
  syncDirectory,
  fileHashAsync,
} from '../library/files.js';
import { SqlDatabase } from './sql.js';
import { initializeCatalogSchema } from './catalog-schema.js';
import { initializeScreenshotSchema } from '../previews/job-schema.js';
import { LibraryStorage } from '../library/storage.js';

async function present(filename: string): Promise<boolean> {
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw Error('UNSAFE_MIGRATION_PATH');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
/** A one-time, restartable cutover. No media file is rewritten or removed. */
export async function migrateDeployment(
  dataRoot: string,
  mediaRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const filename = path.join(mediaRoot, 'library.json');
  if (!(await present(filename))) return;
  const manifest = JSON.parse(await readFile(filename, 'utf8')) as {
    format: number;
    id: string;
    createdAtMs: number;
  };
  if (manifest.format === 2) return;
  if (manifest.format !== 1 || !libraryIdPattern.test(manifest.id))
    throw Error('UNSUPPORTED_LIBRARY_MIGRATION');
  signal?.throwIfAborted();
  const { DatabaseSync, backup } = await import('node:sqlite');
  const { LibraryStorage: LegacyLibrary } = await import('../library/legacy-storage.js');
  const { importSqlite } = await import('./import-sqlite.js');
  const backupRoot = path.join(dataRoot, 'backups', `postgresql-${manifest.id}`);
  let backups = backupRoot;
  const sourceLock = new DatabaseSync(path.join(dataRoot, 'instance-lock.sqlite'));
  const mediaLock = new DatabaseSync(path.join(mediaRoot, 'instance-lock.sqlite'));
  const log = (stage: string, extra: Record<string, unknown> = {}) =>
    console.info(JSON.stringify({ event: 'postgres_migration', stage, ...extra }));
  let legacy: InstanceType<typeof LegacyLibrary> | undefined;
  let library: LibraryStorage | undefined;
  const opened: SqlDatabase[] = [];
  let failure: unknown;
  try {
    sourceLock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');
    mediaLock.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');
    const freeze = async (input: InstanceType<typeof DatabaseSync>, destination: string) => {
      const temporary = destination + '.tmp';
      if (await present(temporary)) {
        regularFile(temporary);
        await unlink(temporary);
      }
      await backup(input, temporary);
      const file = await open(temporary, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      syncDirectory(path.dirname(destination));
    };
    const snapshot = async (source: string, destination: string) => {
      if (await present(destination)) return;
      regularFile(source);
      const input = new DatabaseSync(source, { readOnly: true });
      try {
        await freeze(input, destination);
      } finally {
        input.close();
      }
    };
    legacy = new LegacyLibrary(dataRoot, mediaRoot);
    const input = new DatabaseSync(legacy.indexFile);
    let catalogSource: string;
    try {
      await legacy.attach(input);
      const sequence = (
        input.prepare('SELECT sequence FROM library_state WHERE id=1').get() as { sequence: number }
      ).sequence;
      const privateHash = createHash('sha256');
      const queueHash = createHash('sha256');
      const queueFilename = path.join(dataRoot, 'jobs', manifest.id, 'screenshots', 'jobs.sqlite');
      // The old screenshot scheduler writes independently of catalog sequence.
      // Do not resume an older queue snapshot after the old application ran.
      for (const suffix of ['', '-wal', '-journal']) {
        const source = queueFilename + suffix;
        if (await present(source)) queueHash.update(suffix + ':' + (await fileHashAsync(source)));
      }
      const privateFilename = path.join(dataRoot, 'app.sqlite');
      if (await present(privateFilename)) {
        const privateInput = new DatabaseSync(privateFilename, { readOnly: true });
        try {
          for (const row of privateInput
            .prepare('SELECT key,value FROM settings ORDER BY key')
            .iterate())
            privateHash.update(JSON.stringify(row) + '\n');
        } finally {
          privateInput.close();
        }
      }
      // A failed upgrade may have been followed by running the old application.
      // A new authoritative generation must never reuse an older frozen source.
      const generation = createHash('sha256')
        .update(
          JSON.stringify({
            id: manifest.id,
            sequence,
            privateHash: privateHash.digest('hex'),
            queueHash: queueHash.digest('hex'),
          }),
        )
        .digest('hex')
        .slice(0, 20);
      backups = path.join(backupRoot, generation);
      await mkdir(backups, { recursive: true, mode: 0o700 });
      catalogSource = path.join(backups, 'catalog.sqlite');
      if (!(await present(catalogSource))) {
        log('freeze_catalog', { sequence });
        await freeze(input, catalogSource);
      }
      atomicJson(path.join(backups, 'library.json'), manifest);
      atomicJson(path.join(backups, 'source.json'), { id: manifest.id, sequence, generation });
    } finally {
      await legacy.close();
      legacy = undefined;
      input.close();
    }
    const canonical = await SqlDatabase.open(path.join(dataRoot, 'indexes', manifest.id));
    opened.push(canonical);
    await initializeCatalogSchema(canonical, manifest.createdAtMs);
    const transfer = async (source: string, target: SqlDatabase, omit: readonly string[] = []) => {
      signal?.throwIfAborted();
      const staging =
        target.schema + '_m' + createHash('sha256').update(source).digest('hex').slice(0, 12);
      log('import_snapshot', { namespace: target.schema });
      let reported = 0;
      await importSqlite({
        db: target.postgres,
        source,
        schema: staging,
        progress: (progress) => {
          signal?.throwIfAborted();
          if (progress.completed || progress.rows - reported >= 10000) {
            reported = progress.rows;
            log('import_table', { ...progress });
          }
        },
      });
      const tables = await target
        .prepare(
          'SELECT tablename AS name FROM pg_tables WHERE schemaname=? AND tablename NOT LIKE ? ORDER BY tablename',
        )
        .all<{ name: string }>(staging, '\\_import%');
      const names = tables
        .filter((table) => !table.name.startsWith('_import') && !omit.includes(table.name))
        .map((table) => table.name);
      const targets = await target
        .prepare('SELECT tablename AS name FROM pg_tables WHERE schemaname=?')
        .all<{ name: string }>(target.schema);
      const allowed = new Set(targets.map((table) => table.name));
      for (const name of names)
        if (!allowed.has(name)) throw Error('UNSUPPORTED_SOURCE_TABLE_' + name.toUpperCase());
      // One server-side transaction publishes a coherent catalog. Rows are never
      // accumulated in Node; PostgreSQL streams INSERT SELECT into its indexes.
      await target.transaction(async () => {
        await target.exec('SET CONSTRAINTS ALL DEFERRED');
        const triggerRows = await target
          .prepare(
            'SELECT tgname AS name,c.relname AS relation FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=? AND NOT t.tgisinternal',
          )
          .all<{ name: string; relation: string }>(target.schema);
        for (const trigger of triggerRows)
          await target.exec(
            `ALTER TABLE ${quote(trigger.relation)} DISABLE TRIGGER ${quote(trigger.name)}`,
          );
        for (const name of names) await target.exec(`DELETE FROM ${quote(name)}`);
        for (const name of names) {
          signal?.throwIfAborted();
          log('publish_table', { table: name });
          const columns = await target
            .prepare(
              'SELECT column_name AS name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',
            )
            .all<{ name: string }>(staging, name);
          const fields = columns.map((column) => quote(column.name)).join(',');
          await target.exec(
            `INSERT INTO ${quote(name)}(${fields}) SELECT ${fields} FROM ${quote(staging)}.${quote(name)}`,
          );
          const [counts] = await target
            .prepare(
              `SELECT (SELECT count(*) FROM ${quote(name)}) AS actual,(SELECT count(*) FROM ${quote(staging)}.${quote(name)}) AS expected`,
            )
            .all<{ actual: number; expected: number }>();
          if (counts.actual !== counts.expected) throw Error('MIGRATION_ROW_COUNT_MISMATCH');
          log('table_verified', { table: name, rows: counts.actual });
        }
        for (const trigger of triggerRows)
          await target.exec(
            `ALTER TABLE ${quote(trigger.relation)} ENABLE TRIGGER ${quote(trigger.name)}`,
          );
      });
      const identities = await target
        .prepare(
          "SELECT table_name AS relation,column_name AS name FROM information_schema.columns WHERE table_schema=? AND is_identity='YES'",
        )
        .all<{ relation: string; name: string }>(target.schema);
      for (const identity of identities)
        await target
          .prepare(
            `SELECT setval(pg_get_serial_sequence(?,?),coalesce((SELECT max(${quote(identity.name)}) FROM ${quote(identity.relation)}),1),EXISTS(SELECT 1 FROM ${quote(identity.relation)}))`,
          )
          .get(`${target.schema}.${identity.relation}`, identity.name);
      if (targets.length)
        await target.exec(
          'ANALYZE ' +
            targets.map((table) => `${quote(target.schema)}.${quote(table.name)}`).join(','),
        );
    };
    await transfer(catalogSource, canonical, ['library_state']);
    const privateSource = path.join(dataRoot, 'app.sqlite');
    if (await present(privateSource)) {
      const frozen = path.join(backups, 'private.sqlite');
      await snapshot(privateSource, frozen);
      const target = await SqlDatabase.open(path.join(dataRoot, 'private'));
      opened.push(target);
      await target.exec(
        'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      );
      await transfer(frozen, target);
    }
    const queueRoot = path.join(dataRoot, 'jobs', manifest.id, 'screenshots');
    const queueSource = path.join(queueRoot, 'jobs.sqlite');
    if (await present(queueSource)) {
      const frozen = path.join(backups, 'screenshots.sqlite');
      await snapshot(queueSource, frozen);
      const target = await SqlDatabase.open(path.join(queueRoot, 'jobs'));
      opened.push(target);
      await initializeScreenshotSchema(target);
      await transfer(frozen, target);
    }
    signal?.throwIfAborted();
    for (const target of opened) {
      const candidates = await target
        .prepare('SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ?')
        .all<{ name: string }>(target.schema + '%');
      const own = new RegExp('^' + target.schema + '_m[a-f0-9]{12}$');
      for (const candidate of candidates) {
        if (!own.test(candidate.name)) continue;
        const marker = await target
          .prepare('SELECT to_regclass(?) IS NOT NULL AS present')
          .get<{ present: boolean }>(candidate.name + '._import_source');
        if (marker?.present) await target.exec(`DROP SCHEMA ${quote(candidate.name)} CASCADE`);
      }
    }
    // Publish a recoverable PostgreSQL checkpoint before changing the library
    // format marker. Until that final atomic rename the old library stays valid.
    const next = { ...manifest, format: 2 as const, checkpoint: undefined, previous: undefined };
    atomicJson(path.join(backups, 'cutover.json'), { stage: 'checkpoint', library: manifest.id });
    library = new LibraryStorage(dataRoot, mediaRoot, undefined, next);
    await library.attach(canonical);
    await library.checkpoint();
    atomicJson(path.join(backups, 'cutover.json'), {
      stage: 'completed',
      library: manifest.id,
      atMs: Date.now(),
    });
    log('completed', { library: manifest.id });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const cleanup of [
      () => library?.close(),
      () => legacy?.close(),
      ...opened.reverse().map((db) => () => db.close()),
      () => Promise.resolve(mediaLock.close()),
      () => Promise.resolve(sourceLock.close()),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        failure ? [failure, ...errors] : errors,
        'POSTGRES_MIGRATION_CLEANUP_FAILED',
      );
  }
}
