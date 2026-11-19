import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** Linux flock belongs to the open file description and releases on process death. */
export class FileLease {
  private readonly file: FileHandle;
  private closed = false;
  private constructor(file: FileHandle) {
    this.file = file;
  }
  static async acquire(filename: string): Promise<FileLease> {
    const file = await open(
      filename,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    ).catch((error: unknown) => {
      if (
        error instanceof Error &&
        'code' in error &&
        ['ELOOP', 'EISDIR'].includes(String(error.code))
      )
        throw Error('UNSAFE_DATABASE_PATH', { cause: error });
      throw error;
    });
    try {
      if (!(await file.stat()).isFile()) throw Error('UNSAFE_DATABASE_PATH');
      // fd 3 is a duplicate of our existing description. After flock exits, this
      // handle still owns the lock; no PID files or stale-lock deletion is needed.
      await new Promise<void>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', file.fd],
        });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(Error('DATABASE_DIRECTORY_LOCKED')),
        );
      });
      return new FileLease(file);
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.file.close();
  }
}
