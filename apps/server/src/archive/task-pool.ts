/** Bounded asynchronous I/O; a granted waiter owns its slot before it resumes. */
export class TaskPool {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64)
      throw Error('INVALID_ARCHIVE_CONCURRENCY');
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await action();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** One controller waits; enqueue notifications cannot be lost across its DB awaits. */
export class TaskWakeup {
  epoch = 0;
  private waiting: (() => void) | undefined;
  notify(): void {
    this.epoch++;
    const wake = this.waiting;
    this.waiting = undefined;
    wake?.();
  }
  next(epoch: number): { promise: Promise<void>; dispose: () => void } {
    let wake: (() => void) | undefined;
    const promise =
      epoch !== this.epoch
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            wake = resolve;
            this.waiting = resolve;
          });
    return {
      promise,
      dispose: () => {
        if (this.waiting === wake) this.waiting = undefined;
      },
    };
  }
}
