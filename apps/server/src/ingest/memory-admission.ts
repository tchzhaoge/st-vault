import { aborted, ProviderError } from '../provider/http.js';

export interface MemoryReservation {
  resize(bytes: number): void;
  release(): void;
}
interface Waiter {
  bytes: number;
  grant: () => void;
  cancel: () => void;
}
/** FIFO byte admission; transient pressure waits without restarting the producer. */
export class MemoryAdmission {
  reserved = 0;
  private readonly waiting: Waiter[] = [];
  private scheduled = false;
  constructor(private readonly room: (bytes: number) => boolean) {}
  acquire(bytes: number, signal: AbortSignal): Promise<MemoryReservation> {
    aborted(signal);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        bytes,
        grant: () => {
          signal.removeEventListener('abort', waiter.cancel);
          this.reserved += bytes;
          let held = bytes;
          const resize = (next: number): void => {
            if (!Number.isSafeInteger(next) || next < 0 || next > held)
              throw new Error('invalid-memory-reservation');
            this.reserved -= held - next;
            held = next;
            this.changed();
          };
          resolve({ resize, release: () => resize(0) });
        },
        cancel: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          signal.removeEventListener('abort', waiter.cancel);
          reject(new ProviderError('cancelled'));
          this.changed();
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
      this.drain();
    });
  }
  changed(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // A download can hand ownership to a frame in the same synchronous turn.
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }
  private drain(): void {
    while (this.waiting.length && this.room(this.waiting[0].bytes)) this.waiting.shift()!.grant();
  }
}
