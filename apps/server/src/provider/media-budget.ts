import { aborted, ProviderError } from './http.js';

interface Waiter {
  signal: AbortSignal;
  grant: () => void;
  cancel: () => void;
}
/** Cancellable FIFO concurrency budget; its owner determines the isolation boundary. */
export class MediaBudget {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
      throw new ProviderError('invalid-media-concurrency');
  }
  stats(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit };
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    aborted(signal);
    if (this.active < this.limit) {
      this.active++;
      return this.releaseToken();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        grant: () => {
          signal.removeEventListener('abort', waiter.cancel);
          this.active++;
          resolve(this.releaseToken());
        },
        cancel: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          signal.removeEventListener('abort', waiter.cancel);
          reject(new ProviderError('cancelled'));
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }
  private releaseToken(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiting.shift();
      if (next) next.grant();
    };
  }
}
