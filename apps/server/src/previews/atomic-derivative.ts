import { randomUUID } from 'node:crypto';
import { open, rename, unlink, opendir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ioCode } from './derivative-diagnostics.js';
import type { DerivativeDiagnostics } from './derivative-diagnostics.js';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const cacheTemporary = new RegExp(
  `^(?:[a-f0-9]{64}(?:-|\\.img\\.)${uuid}\\.tmp|s-\\d+-\\d+-${uuid}(?:\\.img|-${uuid}\\.tmp))$`,
);
const snapshotTemporary = new RegExp(
  `^\\d+-\\d+(?:-[a-f0-9]{64})?\\.jpg(?:\\.json)?\\.${uuid}\\.tmp$`,
);
async function* knownFiles(
  root: string,
  kind: 'cache' | 'snapshot' | 'library',
  owner?: 'cover' | 'avatar' | 'snapshot',
): AsyncGenerator<string | null> {
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (kind === 'library') {
      yield null;
      if (!entry.isDirectory() || !/^stripchat-[1-9]\d*$/.test(entry.name)) continue;
      for (const type of ['images', 'thumbnails']) {
        if (
          (type === 'images' && owner === 'snapshot') ||
          (type === 'thumbnails' && owner !== 'snapshot')
        )
          continue;
        const base = path.join(root, entry.name, type);
        async function* walk(current: string, depth: number): AsyncGenerator<string | null> {
          let items;
          try {
            items = await opendir(current);
          } catch (error) {
            if (ioCode(error) === 'ENOENT') return;
            throw error;
          }
          for await (const item of items) {
            yield item.isFile() &&
            (owner === 'snapshot'
              ? snapshotTemporary.test(item.name)
              : new RegExp(`^${owner}\\.img\\.${uuid}\\.tmp$`).test(item.name))
              ? path.join(current, item.name)
              : null;
            if (item.isDirectory() && depth > 0 && /^(?:\d{4}-\d{2}-\d{2}|\d{2})$/.test(item.name))
              yield* walk(path.join(current, item.name), depth - 1);
          }
        }
        yield* walk(base, type === 'thumbnails' ? 2 : 0);
      }
      continue;
    }
    if (entry.isFile() && kind === 'cache') {
      yield cacheTemporary.test(entry.name) ? path.join(root, entry.name) : null;
      continue;
    }
    yield null;
    if (kind !== 'snapshot' || !entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const children = await opendir(path.join(root, entry.name));
    for await (const child of children)
      yield child.isFile() && snapshotTemporary.test(child.name)
        ? path.join(root, entry.name, child.name)
        : null;
  }
}
interface Pending {
  filename: string;
  handle?: FileHandle;
  removed: boolean;
  active: boolean;
}
/** One recovery owner; unrelated destinations publish independently. */
export class AtomicDerivativeWriter {
  private readonly pending = new Map<string, Pending>();
  private scan: AsyncGenerator<string | null> | null;
  private candidate: string | null = null;
  private recovery: Promise<void> | undefined;
  private retryAt = 0;
  private scanFailures = 0;
  private complete = false;
  private closed = false;
  private readonly work = new Map<string, Promise<void>>();
  private cleanupFailed = false;
  private recoveryFailed = false;
  constructor(
    private readonly root: string,
    private readonly kind: 'cache' | 'snapshot' | 'library',
    private readonly diagnostics: DerivativeDiagnostics,
    private readonly owner?: 'cover' | 'avatar' | 'snapshot',
  ) {
    this.scan = knownFiles(root, kind, owner);
  }
  /** Observation never advances directory cursors or retries filesystem work. */
  status(): {
    active: boolean;
    recovering: boolean;
    pending: boolean;
    error: string | null;
    retryAtMs: number | null;
  } {
    return {
      active: this.work.size > 0,
      recovering: !!this.recovery,
      pending: [...this.pending.values()].some((entry) => !entry.active) || !this.complete,
      error: this.cleanupFailed
        ? 'temporary_cleanup_failed'
        : this.recoveryFailed
          ? 'temporary_scan_failed'
          : null,
      retryAtMs: this.recoveryFailed ? this.retryAt : null,
    };
  }
  async cleanup(): Promise<boolean> {
    for (const pending of this.pending.values())
      if (!pending.active) await this.cleanupOne(pending);
    this.cleanupFailed = [...this.pending.values()].some((entry) => !entry.active);
    return !this.cleanupFailed;
  }
  private async cleanupOne(pending: Pending): Promise<void> {
    if (pending.handle)
      try {
        await pending.handle.close();
        delete pending.handle;
      } catch (error) {
        this.diagnostics.record('derivative_close_failed', error);
      }
    if (!pending.removed)
      try {
        await unlink(pending.filename);
        pending.removed = true;
      } catch (error) {
        if (ioCode(error) === 'ENOENT') pending.removed = true;
        else this.diagnostics.record('derivative_cleanup_failed', error);
      }
    if (!pending.handle && pending.removed) this.pending.delete(pending.filename);
  }
  recover(limit = 32): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.recovery) return this.recovery;
    this.recovery = this.recoverBatch(limit).finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  private async recoverBatch(limit: number): Promise<void> {
    if (this.closed) return;
    if (!(await this.cleanup())) return;
    if (this.closed) return;
    if (!this.scan && !this.complete && Date.now() >= this.retryAt)
      this.scan = knownFiles(this.root, this.kind, this.owner);
    for (let visited = 0; visited < limit && this.scan && !this.closed; visited++) {
      if (!this.candidate) {
        let next: IteratorResult<string | null>;
        try {
          next = await this.scan.next();
        } catch (error) {
          this.diagnostics.record('derivative_recovery_failed', error);
          this.recoveryFailed = true;
          this.scan = null;
          this.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(this.scanFailures++, 5));
          return;
        }
        this.recoveryFailed = false;
        if (next.done) {
          this.scan = null;
          this.complete = true;
          return;
        }
        this.candidate = next.value;
      }
      if (!this.candidate) continue;
      // Directory I/O may overlap publication. A registered active temporary
      // always belongs to its writer, never to the recovery cursor.
      if (this.pending.get(this.candidate)?.active) {
        this.candidate = null;
        continue;
      }
      this.pending.set(this.candidate, { filename: this.candidate, removed: false, active: false });
      if (!(await this.cleanup())) return;
      this.candidate = null;
    }
  }
  write(
    destination: string,
    bytes: Uint8Array,
    options: { sync?: boolean; beforePublish?: () => void | Promise<void> } = {},
  ): Promise<void> {
    if (this.closed) return Promise.reject(Error('DERIVATIVE_WRITER_CLOSED'));
    destination = path.resolve(destination);
    if (!bytes.length || bytes.length > 512 * 1024)
      return Promise.reject(Error('INVALID_DERIVATIVE_SIZE'));
    const relative = path.relative(this.root, path.resolve(destination)).split(path.sep).join('/');
    if (
      !(
        this.kind === 'cache'
          ? /^[a-f0-9]{64}\.img$/
          : this.kind === 'library'
            ? /^stripchat-[1-9]\d*\/(?:images\/(?:cover|avatar)\.img|thumbnails\/\d{4}-\d{2}-\d{2}\/\d{2}\/\d+-\d+(?:-[a-f0-9]{64})?\.jpg(?:\.json)?)$/
            : /^[1-9]\d*\/\d+-\d+(?:-[a-f0-9]{64})?\.jpg(?:\.json)?$/
      ).test(relative)
    )
      return Promise.reject(Error('INVALID_DERIVATIVE_DESTINATION'));
    if (this.work.has(destination)) return Promise.reject(Error('DERIVATIVE_WRITE_BUSY'));
    const task = this.writeOne(destination, bytes, options).finally(() => {
      this.work.delete(destination);
    });
    this.work.set(destination, task);
    return task;
  }
  private async writeOne(
    destination: string,
    bytes: Uint8Array,
    options: { sync?: boolean; beforePublish?: () => void | Promise<void> },
  ): Promise<void> {
    await this.recover();
    if (!(await this.cleanup())) throw Error('DERIVATIVE_CLEANUP_PENDING');
    const pending: Pending = {
      filename: `${destination}.${randomUUID()}.tmp`,
      removed: false,
      active: true,
    };
    this.pending.set(pending.filename, pending);
    let operation = 'open';
    try {
      pending.handle = await open(pending.filename, 'wx', 0o600);
      operation = 'write';
      await pending.handle.writeFile(bytes);
      if (options.sync) {
        operation = 'sync';
        await pending.handle.sync();
      }
      operation = 'close';
      await pending.handle.close();
      delete pending.handle;
      operation = 'publish';
      await options.beforePublish?.();
      operation = 'rename';
      await rename(pending.filename, destination);
      if (options.sync && process.platform !== 'win32') {
        const parent = await open(path.dirname(destination), 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
      // Rename already consumed the temporary. Do not turn successful publication into cleanup failure.
      this.pending.delete(pending.filename);
    } catch (error) {
      if (operation !== 'publish') this.diagnostics.record(`derivative_${operation}_failed`, error);
      if (operation === 'open' && ioCode(error) === 'EEXIST') this.pending.delete(pending.filename);
      throw error;
    } finally {
      pending.active = false;
      if (this.pending.has(pending.filename)) await this.cleanup();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.work.values());
    await this.recovery;
    await this.cleanup();
    await this.scan?.return(null);
    this.scan = null;
  }
}
