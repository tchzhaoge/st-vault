import type { ArchiveHealthStatus } from '@st-vault/api-schema';
import type { SyncClock } from './sync-clock.js';

interface Options {
  probe: () => Promise<unknown>;
  intervalMs: () => number;
  canRestart: () => boolean;
  restart: (reason: NonNullable<ArchiveHealthStatus['error']>) => void;
  now?: () => number;
  timeoutMs?: number;
}
/** A hung worker keeps exactly one probe, rather than growing its RPC queue. */
export class ArchiveHealthMonitor {
  private state: ArchiveHealthStatus = {
    error: 'archive_checking',
    checkedAtMs: 0,
    failures: 0,
    recovery: 'none',
  };
  private pending = false;
  private startedAt = 0;
  private nextProbe = 0;
  private nextFailure = 0;
  private closed = false;
  private detach?: () => void;
  constructor(private readonly options: Options) {}
  get(): ArchiveHealthStatus {
    return { ...this.state };
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  start(clock: SyncClock): void {
    this.detach ??= clock.subscribe('archive-health', () => this.check(), {
      immediate: true,
      everyPulse: true,
    });
  }
  check(): void {
    if (this.closed || this.state.recovery === 'restart-requested') return;
    const now = this.now();
    if (this.pending) {
      if (now - this.startedAt >= (this.options.timeoutMs ?? 10000) && now >= this.nextFailure) {
        this.nextFailure = now + Math.min(5000, this.options.intervalMs());
        this.fail('archive_timeout');
      }
      return;
    }
    if (now < this.nextProbe) return;
    this.pending = true;
    this.startedAt = now;
    this.nextProbe = now + this.options.intervalMs();
    void Promise.resolve()
      .then(this.options.probe)
      .then(
        () => {
          if (this.closed || this.state.recovery === 'restart-requested') return;
          if (this.state.failures)
            console.info(JSON.stringify({ event: 'archive_health_recovered' }));
          this.state = { error: null, failures: 0, recovery: 'none', checkedAtMs: this.now() };
        },
        (error: unknown) => {
          if (this.closed || this.state.recovery === 'restart-requested') return;
          const code = error instanceof Error ? error.message : '';
          this.fail(
            code === 'ARCHIVE_REQUIRES_RECOVERY'
              ? 'archive_recovery_required'
              : ['METADATA_WORKER_UNAVAILABLE', 'ARCHIVE_CLOSED'].includes(code)
                ? 'archive_worker_unavailable'
                : 'archive_unavailable',
          );
        },
      )
      .finally(() => {
        this.pending = false;
      });
  }
  private fail(error: NonNullable<ArchiveHealthStatus['error']>): void {
    const failures = this.state.error === error ? this.state.failures + 1 : 1;
    if (this.state.error !== error)
      console.warn(JSON.stringify({ event: 'archive_health_failed', reason: error }));
    this.state = { error, failures, recovery: 'retrying', checkedAtMs: this.now() };
    // A read-only/full disk or corrupt media cannot be repaired by restarting.
    // Let storage recover first, then restart only a confirmed broken worker.
    if (failures >= 3 && error !== 'archive_unavailable' && this.options.canRestart()) {
      this.state.recovery = 'restart-requested';
      console.error(JSON.stringify({ event: 'archive_recovery_restart', reason: error, failures }));
      this.options.restart(error);
    }
  }
  close(): void {
    this.closed = true;
    this.detach?.();
  }
}
