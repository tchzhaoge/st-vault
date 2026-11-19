import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';

export interface OrphanCandidate {
  filename: string;
  name: string;
  objectId?: string;
}
/** Only recognized archive paths, with bounded directory buffers and batches. */
export async function* orphanCandidates(directory: string): AsyncGenerator<OrphanCandidate[]> {
  let batch: OrphanCandidate[] = [];
  async function* scan(current: string, depth: number): AsyncGenerator<OrphanCandidate[]> {
    for await (const entry of await opendir(current)) {
      const filename = path.join(current, entry.name);
      if (
        (depth === 0 && /^(?:\d{4}-\d{2}-\d{2}|unlocated)$/.test(entry.name)) ||
        (depth === 1 && /^(?:[01]\d|2[0-3])$/.test(entry.name))
      ) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('UNSAFE_ARCHIVE_PATH');
        yield* scan(filename, depth + 1);
        continue;
      }
      const match =
        /^(?:init|seg)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:mp4|m4s)$/.exec(
          entry.name,
        );
      if (!match) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error('UNSAFE_ARCHIVE_PATH');
      batch.push({ filename, name: entry.name, objectId: match[1] });
      if (batch.length === 128) {
        yield batch;
        batch = [];
      }
    }
  }
  yield* scan(directory, 0);
  const staging = path.join(directory, '.staging');
  try {
    const info = await lstat(staging);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('UNSAFE_ARCHIVE_PATH');
    for await (const entry of await opendir(staging)) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error('UNSAFE_ARCHIVE_PATH');
      batch.push({ filename: path.join(staging, entry.name), name: entry.name });
      if (batch.length === 128) {
        yield batch;
        batch = [];
      }
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (batch.length) yield batch;
}
