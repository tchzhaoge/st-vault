import { ImageAdmission, imagePriority, type ImagePriority } from './image-admission';
export type { ImagePriority } from './image-admission';
export class ImagePendingError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('image-pending');
  }
}
interface CachedImage {
  blob: Blob;
  at: number;
  etag?: string;
}
interface Consumer {
  resolve: (blob: Blob) => void;
  reject: (error: unknown) => void;
  remove: () => void;
}
interface Job {
  url: string;
  priority: ImagePriority;
  controller: AbortController;
  consumers: Set<Consumer>;
}
interface Options {
  fetch?: typeof fetch;
  now?: () => number;
  concurrency?: number;
  admission?: ImageAdmission;
  maxEntries?: number;
  maxBytes?: number;
}
/** Only nearby rows request images; visible consumers can promote a queued preload. */
export class ImageLoader {
  private readonly cache = new Map<string, CachedImage>();
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private active = 0;
  private bytes = 0;
  constructor(private readonly options: Options = {}) {}
  peek(url: string): Blob | null {
    const entry = this.cache.get(url);
    if (!entry) return null;
    this.cache.delete(url);
    this.cache.set(url, entry);
    return entry.blob;
  }
  invalidate(url: string): void {
    const entry = this.cache.get(url);
    if (entry) {
      this.cache.delete(url);
      this.bytes -= entry.blob.size;
    }
  }
  load(
    url: string,
    signal?: AbortSignal,
    priority: ImagePriority = 'visible',
    maxAgeMs = 30000,
  ): Promise<Blob> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const entry = this.cache.get(url);
    if (entry && (this.options.now ?? Date.now)() - entry.at < maxAgeMs)
      return Promise.resolve(this.peek(url)!);
    let job = this.jobs.get(url);
    if (!job || job.controller.signal.aborted) {
      job = {
        url,
        priority,
        controller: new AbortController(),
        consumers: new Set(),
      };
      this.jobs.set(url, job);
      this.queue.push(job);
    }
    if (imagePriority(priority) > imagePriority(job.priority)) job.priority = priority;
    const current = job;
    const result = new Promise<Blob>((resolve, reject) => {
      const cancel = (): void => {
        current.consumers.delete(consumer);
        consumer.remove();
        reject(new DOMException('Aborted', 'AbortError'));
        // React may detach and reattach a row when promoting a preload.
        queueMicrotask(() => {
          if (!current.consumers.size) {
            current.controller.abort();
            const index = this.queue.indexOf(current);
            if (index >= 0) this.queue.splice(index, 1);
            if (this.jobs.get(url) === current) this.jobs.delete(url);
          }
        });
      };
      const consumer: Consumer = {
        resolve,
        reject,
        remove: () => signal?.removeEventListener('abort', cancel),
      };
      current.consumers.add(consumer);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    this.drain();
    return result;
  }
  clear(): void {
    this.cache.clear();
    this.bytes = 0;
    for (const job of this.jobs.values()) {
      job.controller.abort();
      for (const consumer of job.consumers) {
        consumer.remove();
        consumer.reject(new DOMException('Aborted', 'AbortError'));
      }
      job.consumers.clear();
    }
    this.jobs.clear();
    this.queue.length = 0;
  }
  private drain(): void {
    while (
      (this.options.admission || this.active < (this.options.concurrency ?? 3)) &&
      this.queue.length
    ) {
      const highest = Math.max(...this.queue.map((job) => imagePriority(job.priority)));
      const index = this.queue.findIndex((job) => imagePriority(job.priority) === highest),
        job = this.queue.splice(index, 1)[0];
      if (job.controller.signal.aborted || !job.consumers.size) continue;
      this.active++;
      void this.download(job);
    }
  }
  private async download(job: Job): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined, release: (() => void) | undefined;
    try {
      release = await this.options.admission?.acquire(job.controller.signal, () => job.priority);
      if (job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      timer = setTimeout(() => job.controller.abort(), 12000);
      const previous = this.cache.get(job.url);
      const request: RequestInit & { priority: 'high' | 'auto' | 'low' } = {
        signal: job.controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(previous?.etag ? { headers: { 'If-None-Match': previous.etag } } : {}),
        priority:
          job.priority === 'interactive' ? 'high' : job.priority === 'prefetch' ? 'low' : 'auto',
      };
      const response = await (this.options.fetch ?? fetch)(job.url, request);
      if (response.status === 202 || response.status === 429) {
        await response.body?.cancel();
        throw new ImagePendingError(
          Math.max(1, Math.min(30, Number(response.headers.get('retry-after')) || 2)) * 1000,
        );
      }
      if (!response.ok && !(response.status === 304 && previous))
        throw new Error(`image-unavailable:${response.status}`);
      const blob = response.status === 304 && previous ? previous.blob : await response.blob();
      if (
        !/^image\/(jpeg|png|webp)(?:;|$)/i.test(blob.type) ||
        !blob.size ||
        blob.size > 512 * 1024
      )
        throw new Error('image-format');
      if (job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      this.invalidate(job.url);
      this.cache.set(job.url, {
        blob,
        at: (this.options.now ?? Date.now)(),
        etag:
          response.headers.get('etag') ?? (response.status === 304 ? previous?.etag : undefined),
      });
      this.bytes += blob.size;
      while (
        this.cache.size > (this.options.maxEntries ?? 96) ||
        this.bytes > (this.options.maxBytes ?? 8 * 1024 ** 2)
      )
        this.invalidate(this.cache.keys().next().value!);
      for (const consumer of job.consumers) {
        consumer.remove();
        consumer.resolve(blob);
      }
    } catch (error) {
      for (const consumer of job.consumers) {
        consumer.remove();
        consumer.reject(error);
      }
    } finally {
      clearTimeout(timer);
      release?.();
      job.consumers.clear();
      if (this.jobs.get(job.url) === job) this.jobs.delete(job.url);
      this.active--;
      this.drain();
    }
  }
}
const imageTransfers = new ImageAdmission(6);
export const coverImages = new ImageLoader({ admission: imageTransfers });
// Immutable minute samples share bounded compressed blobs across page remounts;
// pending generation releases the download slot instead of holding up the grid.
export const snapshotImages = new ImageLoader({
  admission: imageTransfers,
  maxEntries: 240,
  maxBytes: 4 * 1024 ** 2,
});
