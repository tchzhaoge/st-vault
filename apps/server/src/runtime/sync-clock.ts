export interface SyncTick {
  nowMs: number;
  intervalMs: number;
}
interface Job {
  name: string;
  work: (tick: SyncTick) => void | Promise<void>;
  running: boolean;
  active: boolean;
  pulse: boolean;
  lastStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  failed: boolean;
}
export interface ScheduledWorkStatus {
  name: string;
  running: boolean;
  lastStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  failed: boolean;
  nextTickAtMs: number;
}
/** One process clock; independent jobs never overlap or delay each other's next admission. */
export class SyncClock {
  private readonly jobs = new Set<Job>();
  private readonly pending = new Set<Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private last: number;
  private stopped = false;
  constructor(private readonly options: { intervalMs: () => number; now?: () => number }) {
    this.last = this.now();
    this.timer = setInterval(() => this.pulse(), 250);
    this.timer.unref();
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  intervalMs(): number {
    const value = this.options.intervalMs();
    if (!Number.isFinite(value) || value < 1 || value > 300000)
      throw new Error('INVALID_SYNC_INTERVAL');
    return value;
  }
  private run(job: Job, tick: SyncTick): void {
    if (this.stopped || !job.active || job.running) return;
    job.running = true;
    job.lastStartedAtMs = tick.nowMs;
    const work = Promise.resolve()
      .then(() => {
        if (job.active && !this.stopped) return job.work(tick);
      })
      .then(() => {
        job.failed = false;
      })
      .catch((error) => {
        job.failed = true;
        console.warn(
          'Synchronization failed',
          job.name,
          error instanceof Error ? error.name : 'unknown',
        );
      })
      .finally(() => {
        job.running = false;
        job.lastFinishedAtMs = this.now();
        this.pending.delete(work);
      });
    this.pending.add(work);
  }
  private pulse(): void {
    if (this.stopped) return;
    const tick = { nowMs: this.now(), intervalMs: this.intervalMs() };
    const due = tick.nowMs - this.last >= tick.intervalMs || tick.nowMs < this.last;
    if (due) this.last = tick.nowMs;
    for (const job of this.jobs) if (due || job.pulse) this.run(job, tick);
  }
  subscribe(
    name: string,
    work: Job['work'],
    options: { everyPulse?: boolean; immediate?: boolean } = {},
  ): () => void {
    if (this.stopped) throw new Error('SYNC_CLOCK_CLOSED');
    const job: Job = {
      name,
      work,
      running: false,
      active: true,
      pulse: options.everyPulse ?? false,
      lastStartedAtMs: null,
      lastFinishedAtMs: null,
      failed: false,
    };
    this.jobs.add(job);
    if (options.immediate) this.run(job, { nowMs: this.now(), intervalMs: this.intervalMs() });
    return () => {
      job.active = false;
      this.jobs.delete(job);
    };
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const job of this.jobs) job.active = false;
    this.jobs.clear();
  }
  /** Scheduling facts only. Domain failures and backoff remain owned by each job. */
  status(): ScheduledWorkStatus[] {
    const next = this.last + this.intervalMs();
    return [...this.jobs].map((job) => ({
      name: job.name,
      running: job.running,
      lastStartedAtMs: job.lastStartedAtMs,
      lastFinishedAtMs: job.lastFinishedAtMs,
      failed: job.failed,
      nextTickAtMs: job.pulse ? this.now() + 250 : next,
    }));
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.pending]);
  }
}
