import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const libraryIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function regularFile(filename: string): void {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('UNSAFE_LIBRARY_FILE');
}
export function directory(filename: string): string {
  mkdirSync(filename, { recursive: true, mode: 0o700 });
  const info = lstatSync(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('UNSAFE_LIBRARY_DIRECTORY');
  return realpathSync(filename);
}
export function syncDirectory(filename: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(filename, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function atomicJson(filename: string, value: unknown): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, filename);
  syncDirectory(path.dirname(filename));
}
export function fileHash(filename: string): string {
  regularFile(filename);
  const fd = openSync(filename, 'r'),
    hash = createHash('sha256'),
    buffer = Buffer.alloc(256 * 1024);
  try {
    for (;;) {
      const size = readSync(fd, buffer);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
export async function fileHashAsync(filename: string, signal?: AbortSignal): Promise<string> {
  regularFile(filename);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename, { highWaterMark: 256 * 1024, signal }))
    hash.update(bytes as Buffer);
  return hash.digest('hex');
}
