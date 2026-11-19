export type ImagePriority = 'interactive' | 'visible' | 'prefetch';
export const imagePriority = (priority: ImagePriority): number =>
  priority === 'interactive' ? 2 : priority === 'visible' ? 1 : 0;
interface Waiting {
  signal: AbortSignal;
  priority: () => ImagePriority;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  cancel: () => void;
}
/** Cover and screenshot caches share transfer capacity, not cache eviction. */
export class ImageAdmission {
  private active = 0;
  private readonly waiting: Waiting[] = [];
  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw Error('INVALID_IMAGE_CAPACITY');
  }
  acquire(signal: AbortSignal, priority: () => ImagePriority): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const entry: Waiting = {
        signal,
        priority,
        resolve,
        reject,
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          signal.removeEventListener('abort', entry.cancel);
          reject(new DOMException('Aborted', 'AbortError'));
        },
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.capacity && this.waiting.length) {
      const highest = Math.max(...this.waiting.map((entry) => imagePriority(entry.priority())));
      const index = this.waiting.findIndex((entry) => imagePriority(entry.priority()) === highest);
      const entry = this.waiting.splice(index, 1)[0];
      entry.signal.removeEventListener('abort', entry.cancel);
      if (entry.signal.aborted) {
        entry.reject(new DOMException('Aborted', 'AbortError'));
        continue;
      }
      this.active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
}
