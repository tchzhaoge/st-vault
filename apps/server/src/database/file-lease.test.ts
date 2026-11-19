import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { FileLease } from './file-lease.js';

it.skipIf(process.platform !== 'linux')(
  'excludes a second open and releases without removing stale lock files',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-file-lease-'));
    let lease: FileLease | undefined;
    try {
      const filename = path.join(root, '.lock');
      lease = await FileLease.acquire(filename);
      await expect(FileLease.acquire(filename)).rejects.toThrow('DATABASE_DIRECTORY_LOCKED');
      await lease.close();
      lease = await FileLease.acquire(filename);
    } finally {
      await lease?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
