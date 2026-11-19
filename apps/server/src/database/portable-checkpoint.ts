import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { Postgres } from './postgres.js';
import { directory, fileHashAsync, syncDirectory } from '../library/files.js';

export interface PortableTable {
  name: string;
  columns: string[];
  keys: string[];
}
export interface PortableCheckpoint {
  file: string;
  hash: string;
  sequence: number;
}
interface Header {
  format: 1;
  library: string;
  sequence: number;
  tables: PortableTable[];
}
export const portableIdentifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw Error('INVALID_PORTABLE_IDENTIFIER');
  return `"${value}"`;
};
const pattern = /^catalog\/[a-f0-9-]{36}\.ndjson$/;
export function checkpointPath(mediaRoot: string, checkpoint: PortableCheckpoint): string {
  if (
    !pattern.test(checkpoint.file) ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0 ||
    !/^[a-f0-9]{64}$/.test(checkpoint.hash)
  )
    throw Error('INVALID_PORTABLE_CHECKPOINT');
  return path.join(mediaRoot, checkpoint.file);
}
export async function validCheckpoint(
  mediaRoot: string,
  checkpoint: PortableCheckpoint,
): Promise<boolean> {
  try {
    return (await fileHashAsync(checkpointPath(mediaRoot, checkpoint))) === checkpoint.hash;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
/** The caller pins this repeatable-read snapshot before releasing the writer lock. */
export async function writeCheckpoint(options: {
  client: PoolClient;
  mediaRoot: string;
  library: string;
  sequence: number;
  tables: PortableTable[];
  signal?: AbortSignal;
}): Promise<PortableCheckpoint> {
  const catalog = directory(path.join(options.mediaRoot, 'catalog'));
  const id = randomUUID(),
    temporary = path.join(catalog, `${id}.ndjson.tmp`),
    destination = path.join(catalog, `${id}.ndjson`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash('sha256');
  // A filesystem round trip per row is prohibitive on NAS/Windows mounts.
  // Keep one bounded output buffer; an oversized legal row bypasses it.
  const batch = Buffer.allocUnsafe(256 * 1024);
  let buffered = 0;
  let closed = false;
  const flush = async () => {
    options.signal?.throwIfAborted();
    if (!buffered) return;
    await file.writeFile(batch.subarray(0, buffered));
    buffered = 0;
  };
  const line = async (value: unknown) => {
    options.signal?.throwIfAborted();
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > 16 * 1024 ** 2) throw Error('PORTABLE_CHECKPOINT_ROW_TOO_LARGE');
    if (buffered + bytes.length > batch.length) await flush();
    if (bytes.length > batch.length) await file.writeFile(bytes);
    else {
      bytes.copy(batch, buffered);
      buffered += bytes.length;
    }
    hash.update(bytes);
  };
  try {
    await line({
      format: 1,
      library: options.library,
      sequence: options.sequence,
      tables: options.tables,
    } satisfies Header);
    let count = 0;
    for (const table of options.tables) {
      const name = portableIdentifier(table.name);
      // Restore identifies rows by key, not stream position. A full snapshot
      // needs no PK order; random-key index scans turn export into random I/O.
      await options.client.query(
        `DECLARE stv_checkpoint_rows NO SCROLL CURSOR FOR SELECT * FROM ${name}`,
      );
      try {
        for (;;) {
          options.signal?.throwIfAborted();
          const result = await options.client.query<Record<string, unknown>>(
            'FETCH FORWARD 128 FROM stv_checkpoint_rows',
          );
          for (const row of result.rows) {
            await line({ table: table.name, row });
            count++;
          }
          if (result.rows.length < 128) break;
        }
      } finally {
        await options.client.query('CLOSE stv_checkpoint_rows');
      }
    }
    await line({ complete: true, rows: count });
    await flush();
    await file.sync();
    await file.close();
    closed = true;
    await rename(temporary, destination);
    syncDirectory(catalog);
    return { file: `catalog/${id}.ndjson`, sequence: options.sequence, hash: hash.digest('hex') };
  } catch (error) {
    if (!closed) await file.close();
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!(
        cleanupError instanceof Error &&
        'code' in cleanupError &&
        cleanupError.code === 'ENOENT'
      ))
        throw new AggregateError([error, cleanupError], 'PORTABLE_CHECKPOINT_CLEANUP_FAILED');
    }
    throw error;
  }
}

/** Only registered public tables are restored; application credentials never enter this stream. */
export async function restoreCheckpoint(options: {
  db: Postgres;
  mediaRoot: string;
  checkpoint: PortableCheckpoint;
  library: string;
  tables: PortableTable[];
}): Promise<void> {
  if (!(await validCheckpoint(options.mediaRoot, options.checkpoint)))
    throw Error('PORTABLE_CHECKPOINT_CORRUPT');
  const tables = new Map(options.tables.map((table) => [table.name, table]));
  await options.db.transaction(
    async () => {
      await options.db.query('SET CONSTRAINTS ALL DEFERRED');
      await options.db.query("SET LOCAL stv.replay='on'");
      for (const table of [...options.tables].reverse())
        await options.db.query(`DELETE FROM ${portableIdentifier(table.name)}`);
      const input = createReadStream(checkpointPath(options.mediaRoot, options.checkpoint), {
        highWaterMark: 256 * 1024,
      });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let header = false,
        completed = false,
        count = 0,
        tableName = '',
        batchBytes = 2,
        batch: Record<string, unknown>[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const table = tables.get(tableName)!;
        const name = portableIdentifier(table.name),
          columns = table.columns.map(portableIdentifier).join(',');
        await options.db.query(
          `INSERT INTO ${name}(${columns}) SELECT ${columns} FROM json_populate_recordset(NULL::${name},$1::json)`,
          [JSON.stringify(batch)],
        );
        batch = [];
        batchBytes = 2;
      };
      try {
        for await (const line of lines) {
          if (Buffer.byteLength(line) > 16 * 1024 ** 2 || completed)
            throw Error('INVALID_PORTABLE_CHECKPOINT');
          const value: unknown = JSON.parse(line);
          if (!header) {
            const expected = {
              format: 1,
              library: options.library,
              sequence: options.checkpoint.sequence,
              tables: options.tables,
            };
            if (JSON.stringify(value) !== JSON.stringify(expected))
              throw Error('PORTABLE_CHECKPOINT_SCHEMA_MISMATCH');
            header = true;
            continue;
          }
          if (typeof value !== 'object' || !value) throw Error('INVALID_PORTABLE_CHECKPOINT');
          if ('complete' in value && value.complete === true) {
            if (!('rows' in value) || value.rows !== count)
              throw Error('INVALID_PORTABLE_CHECKPOINT');
            completed = true;
            await flush();
            continue;
          }
          if (
            !('table' in value) ||
            typeof value.table !== 'string' ||
            !('row' in value) ||
            typeof value.row !== 'object' ||
            !value.row
          )
            throw Error('INVALID_PORTABLE_CHECKPOINT');
          const table = tables.get(value.table),
            row = value.row as Record<string, unknown>;
          if (!table) throw Error('PORTABLE_CHECKPOINT_SCHEMA_MISMATCH');
          if (
            Object.keys(row).length !== table.columns.length ||
            table.columns.some((column) => !(column in row))
          )
            throw Error('PORTABLE_CHECKPOINT_SCHEMA_MISMATCH');
          if (tableName && tableName !== value.table) await flush();
          tableName = value.table;
          const rowBytes = Buffer.byteLength(JSON.stringify(row));
          if (batchBytes + rowBytes + (batch.length ? 1 : 0) > 16 * 1024 ** 2) await flush();
          batchBytes += rowBytes + (batch.length ? 1 : 0);
          batch.push(row);
          count++;
          if (batch.length === 128) await flush();
        }
        if (!header || !completed) throw Error('INVALID_PORTABLE_CHECKPOINT');
        await options.db.query('UPDATE stv_library_state SET sequence=$1 WHERE id=1', [
          options.checkpoint.sequence,
        ]);
      } finally {
        lines.close();
        input.destroy();
      }
    },
    { lane: 'background' },
  );
}
