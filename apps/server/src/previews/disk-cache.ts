import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AtomicDerivativeWriter } from './atomic-derivative.js';
import { DerivativeDiagnostics, ioCode } from './derivative-diagnostics.js';

interface Entry {
  bytes: number;
  modified: number;
  touched: number;
}
/** Disposable derivatives only. Atomic writes, bounded disk use, index rebuilt on restart. */
export class PreviewDiskCache {
  private readonly root: string;
  private readonly entries = new Map<string, Entry>();
  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private available = true;
  private closed = false;
  private readonly diagnostics = new DerivativeDiagnostics();
  private readonly writer: AtomicDerivativeWriter;
  private readonly reads = new Set<Promise<Uint8Array | null>>();
  constructor(
    root: string,
    private readonly maxBytes: number,
    private readonly maxItems: number,
  ) {
    this.root = path.resolve(root);
    this.writer = new AtomicDerivativeWriter(this.root, 'cache', this.diagnostics);
    this.ready = this.initialize().catch((error) => {
      this.diagnostics.record('preview_cache_unavailable', error);
      this.available = false;
      this.entries.clear();
      this.bytes = 0;
    });
  }
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('UNSAFE_PREVIEW_CACHE');
    const files = await readdir(this.root, { withFileTypes: true });
    this.entries.clear();
    this.bytes = 0;
    for (const file of files) {
      if (!file.isFile()) continue;
      if (!/^[a-f0-9]{64}\.img$/.test(file.name)) continue;
      const value = await lstat(path.join(this.root, file.name));
      this.entries.set(file.name.slice(0, -4), {
        bytes: value.size,
        modified: value.mtimeMs,
        touched: value.mtimeMs,
      });
      this.bytes += value.size;
      if (value.size > 512 * 1024) await this.discard(file.name.slice(0, -4));
    }
    await this.prune();
    await this.writer.recover(files.length + 1);
  }
  private key(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
  get(key: string, maxAgeMs = Infinity): Promise<Uint8Array | null> {
    if (this.closed) return Promise.resolve(null);
    const work = this.read(key, maxAgeMs);
    this.reads.add(work);
    void work.then(
      () => this.reads.delete(work),
      () => this.reads.delete(work),
    );
    return work;
  }
  private async read(key: string, maxAgeMs: number): Promise<Uint8Array | null> {
    try {
      await this.ready;
      if (!this.available || this.closed) return null;
      const id = this.key(key),
        entry = this.entries.get(id);
      if (!entry || Date.now() - entry.modified > maxAgeMs) return null;
      const filename = path.join(this.root, `${id}.img`),
        info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return null;
      const file = await open(filename, 'r');
      try {
        const actual = await file.stat();
        if (actual.ino !== info.ino || actual.dev !== info.dev || actual.size !== info.size)
          return null;
        const bytes = await file.readFile();
        entry.touched = Date.now();
        return bytes;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (ioCode(error) !== 'ENOENT') this.diagnostics.record('preview_cache_read_failed', error);
      return null;
    }
  }
  put(key: string, bytes: Uint8Array): Promise<boolean> {
    if (this.closed || !bytes.length || bytes.length > 512 * 1024) return Promise.resolve(false);
    const work = this.queue
      .catch(() => undefined)
      .then(async () => {
        await this.ready;
        if (!this.available) {
          await this.initialize();
          this.available = true;
        }
        if (!(await this.writer.cleanup())) return false;
        const id = this.key(key),
          filename = path.join(this.root, `${id}.img`);
        const previous = this.entries.get(id);
        if (!(await this.prune(bytes.length - (previous?.bytes ?? 0), previous ? 0 : 1, id)))
          return false;
        await this.writer.write(filename, bytes);
        this.bytes -= this.entries.get(id)?.bytes ?? 0;
        this.entries.set(id, { bytes: bytes.length, modified: Date.now(), touched: Date.now() });
        this.bytes += bytes.length;
        await this.prune();
        return true;
      });
    this.queue = work;
    return work.catch((error) => {
      this.diagnostics.record('preview_cache_write_failed', error);
      return false;
    }); // Cache failures never interrupt recording/playback.
  }
  private async prune(extraBytes = 0, extraItems = 0, protectedId?: string): Promise<boolean> {
    const fits = (): boolean =>
      this.bytes + extraBytes <= this.maxBytes && this.entries.size + extraItems <= this.maxItems;
    if (fits()) return true;
    for (const [id] of [...this.entries].sort((a, b) => a[1].touched - b[1].touched)) {
      if (id === protectedId) continue;
      await this.discard(id);
      if (fits()) return true;
    }
    return false;
  }
  private async discard(id: string): Promise<void> {
    try {
      await unlink(path.join(this.root, `${id}.img`));
    } catch (error) {
      const code = ioCode(error);
      if (code !== 'ENOENT') {
        // Keep failed files in the index and quota so a later pass can retry.
        this.diagnostics.record('preview_cache_unlink_failed', error);
        return;
      }
    }
    this.bytes -= this.entries.get(id)?.bytes ?? 0;
    this.entries.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.ready.catch(() => undefined);
    await this.queue.catch(() => undefined);
    await Promise.allSettled([...this.reads]);
    try {
      await this.writer.close();
    } finally {
      this.diagnostics.close();
    }
  }
}
