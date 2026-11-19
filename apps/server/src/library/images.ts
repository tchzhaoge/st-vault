import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { subjectImagePath } from './paths.js';
import { AtomicDerivativeWriter } from '../previews/atomic-derivative.js';
import { DerivativeDiagnostics, ioCode } from '../previews/derivative-diagnostics.js';
import { MediaBudget } from '../provider/media-budget.js';

/** Canonical library images are addressed directly, never LRU-evicted or recursively indexed. */
export class LibraryImages {
  private readonly diagnostics = new DerivativeDiagnostics();
  private readonly writer: AtomicDerivativeWriter;
  private readonly queues = new Map<string, Promise<boolean>>();
  private readonly budget: MediaBudget;
  private closed = false;
  constructor(
    private readonly mediaRoot: string,
    private readonly kind: 'cover' | 'avatar',
    concurrency = 4,
  ) {
    this.budget = new MediaBudget(concurrency);
    this.writer = new AtomicDerivativeWriter(
      path.join(mediaRoot, 'subjects'),
      'library',
      this.diagnostics,
      kind,
    );
  }
  private filename(key: string): string {
    const match =
      this.kind === 'cover'
        ? /^cover:([1-9]\d*)$/.exec(key)
        : /^avatar:stripchat:([1-9]\d*)$/.exec(key);
    if (!match) throw Error('INVALID_IMAGE_KEY');
    return subjectImagePath(this.mediaRoot, `stripchat:${match[1]}`, this.kind);
  }
  async get(key: string, maxAgeMs = Infinity): Promise<Uint8Array | null> {
    if (this.closed) return null;
    try {
      const filename = this.filename(key),
        info = await lstat(filename);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await realpath(filename)) !== path.resolve(filename) ||
        info.size > 512 * 1024 ||
        Date.now() - info.mtimeMs > maxAgeMs
      )
        return null;
      const file = await open(filename, 'r');
      try {
        const actual = await file.stat();
        if (actual.ino !== info.ino || actual.dev !== info.dev || actual.size !== info.size)
          return null;
        return await file.readFile();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (ioCode(error) !== 'ENOENT') this.diagnostics.record('library_image_read_failed', error);
      return null;
    }
  }
  put(key: string, bytes: Uint8Array): Promise<boolean> {
    if (this.closed || !bytes.length || bytes.length > 512 * 1024) return Promise.resolve(false);
    const task = (this.queues.get(key) ?? Promise.resolve(true))
      .then(async () => {
        const release = await this.budget.acquire(new AbortController().signal);
        try {
          const filename = this.filename(key);
          await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
          for (
            let parent = path.dirname(filename);
            parent !== path.dirname(this.mediaRoot);
            parent = path.dirname(parent)
          ) {
            const info = await lstat(parent);
            if (!info.isDirectory() || info.isSymbolicLink())
              throw Error('UNSAFE_LIBRARY_IMAGE_PATH');
          }
          await this.writer.write(filename, bytes, { sync: true });
          return true;
        } finally {
          release();
        }
      })
      .catch((error: unknown) => {
        this.diagnostics.record('library_image_write_failed', error);
        return false;
      })
      .finally(() => {
        if (this.queues.get(key) === task) this.queues.delete(key);
      });
    this.queues.set(key, task);
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.queues.values());
    await this.writer.close();
    this.diagnostics.close();
  }
}
