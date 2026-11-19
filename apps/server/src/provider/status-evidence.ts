import type { PublicStatus, Subject } from '@st-vault/api-schema';
import type { ProviderPort } from '../ports.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { ProviderError, waitFor } from './http.js';
import { MediaBudget } from './media-budget.js';

export interface StatusObservation {
  status: PublicStatus;
  at: number;
  transitionAt?: number;
}
export interface PublicEvidence {
  lastPublicAtMs: number | null;
  publicUntilMs: number;
  revocation: 'PRIVATE' | 'OFFLINE' | null;
}
interface State extends PublicEvidence {
  confirmed: PublicStatus;
  observedAt: number;
  candidate?: { from: PublicStatus; status: PublicStatus; at: number };
  offline?: { count: number; since: number };
  last?: StatusObservation;
}
interface Interest {
  subject: Subject;
  listeners: Set<() => void>;
}
export interface StatusEvidenceOptions {
  provider: Pick<ProviderPort, 'status'>;
  now?: () => number;
  clock?: SyncClock;
  intervalMs?: () => number;
  leaseMs?: () => number;
  timeoutMs?: number;
  publicConcurrency?: number;
  monitorConcurrency?: number;
  offlineConfirmations?: number;
  recoveryWindowMs?: number;
  persist?: (
    id: string,
    status: PublicStatus,
    at: number,
    leaseMs: number,
    transitionAt?: number,
  ) => Promise<void>;
}

/** The sole owner of confirmed observations and public-media permission.
 * Monitoring and active viewers share requests; neither can revoke/renew its
 * own independent interpretation of the same source response. */
export class StatusEvidence {
  private readonly listeners = new Set<(id: string, evidence: PublicEvidence) => void>();
  private readonly states = new Map<string, State>();
  private readonly budget: MediaBudget;
  readonly concurrency: number;
  private readonly monitorConcurrency: number;
  private readonly activeConcurrency: number;
  private readonly monitoring = new Set<string>();
  private readonly work = new Map<string, Promise<StatusObservation>>();
  private readonly requests = new Set<{
    id: string;
    kind: 'monitor' | 'active';
    controller: AbortController;
    done: Promise<PublicStatus>;
  }>();
  private readonly interests = new Map<string, Interest>();
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private estimate: () => number;
  private detach?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private activeWork?: Promise<void>;
  private nextRefresh = 0;
  private cursor = 0;
  private closed = false;
  constructor(private readonly options: StatusEvidenceOptions) {
    this.concurrency = options.publicConcurrency ?? 8;
    this.monitorConcurrency =
      options.monitorConcurrency ?? Math.max(1, Math.floor(this.concurrency / 2));
    if (
      !Number.isSafeInteger(this.monitorConcurrency) ||
      this.monitorConcurrency < 1 ||
      this.monitorConcurrency > this.concurrency
    )
      throw Error('invalid-status-evidence-options');
    this.budget = new MediaBudget(this.concurrency);
    this.activeConcurrency = Math.max(1, this.concurrency - this.monitorConcurrency);
    this.now = options.now ?? Date.now;
    this.estimate = options.leaseMs ?? (() => Math.max(15000, this.interval() * 3));
    if (
      !Number.isFinite(options.timeoutMs ?? 5000) ||
      (options.timeoutMs ?? 5000) < 1 ||
      !Number.isSafeInteger(options.offlineConfirmations ?? 2) ||
      (options.offlineConfirmations ?? 2) < 1 ||
      !Number.isFinite(options.recoveryWindowMs ?? 15000) ||
      (options.recoveryWindowMs ?? 15000) < 0
    )
      throw Error('invalid-status-evidence-options');
    this.detach = options.clock?.subscribe('public-status-evidence', () => this.pulse(), {
      everyPulse: true,
    });
  }
  private interval(): number {
    return this.options.intervalMs?.() ?? 5000;
  }
  private lease(): number {
    // The active-consumer rotation is bounded too. Account for its complete
    // sweep so watching several unmonitored subjects cannot expire permits.
    return Math.min(
      600000,
      Math.max(
        this.estimate(),
        Math.ceil(this.interests.size / this.activeConcurrency) * this.interval() * 3,
      ),
    );
  }
  configureLease(estimate: () => number): void {
    this.estimate = estimate;
  }
  get pending(): number {
    return this.requests.size;
  }
  get monitorCapacity(): number {
    return this.interests.size ? this.monitorConcurrency : this.concurrency;
  }
  get monitorPending(): number {
    return Math.max(
      this.monitoring.size,
      [...this.requests].filter((request) => request.kind === 'monitor').length,
    );
  }
  pendingFor(id: string): boolean {
    return this.work.has(id) || [...this.requests].some((request) => request.id === id);
  }
  snapshot(id: string): PublicEvidence {
    const state = this.states.get(id);
    return {
      lastPublicAtMs: state?.lastPublicAtMs ?? null,
      publicUntilMs: state?.publicUntilMs ?? 0,
      revocation: state?.revocation ?? null,
    };
  }
  public(id: string): boolean {
    return this.now() < this.snapshot(id).publicUntilMs;
  }
  private state(subject: Subject): State {
    let state = this.states.get(subject.id);
    if (!state) {
      state = {
        confirmed:
          subject.providerStatus === 'UNKNOWN'
            ? (subject.lastKnownStatus ?? 'UNKNOWN')
            : subject.providerStatus,
        observedAt: subject.observedAtMs ?? 0,
        lastPublicAtMs: null,
        publicUntilMs: 0,
        revocation: null,
      };
      this.states.set(subject.id, state);
    }
    return state;
  }
  seedPublic(subject: Subject, observedAt: number): void {
    const state = this.state(subject);
    if (state.revocation || state.observedAt > observedAt) return;
    state.lastPublicAtMs = observedAt;
    state.publicUntilMs = Math.max(state.publicUntilMs, observedAt + this.lease());
    this.changed(subject.id);
  }
  private changed(id: string): void {
    for (const listener of this.listeners) listener(id, this.snapshot(id));
    for (const listener of this.interests.get(id)?.listeners ?? []) listener();
  }
  subscribe(listener: (id: string, evidence: PublicEvidence) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  retain(subject: Subject, listener: () => void): () => void {
    let interest = this.interests.get(subject.id);
    if (!interest) {
      interest = { subject, listeners: new Set() };
      this.interests.set(subject.id, interest);
    }
    interest.listeners.add(listener);
    if (!this.options.clock && !this.timer) this.schedule();
    return () => {
      interest.listeners.delete(listener);
      if (!interest.listeners.size) this.interests.delete(subject.id);
      if (!this.interests.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
  }
  private schedule(): void {
    if (this.closed || !this.interests.size) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.pulse()
          .catch((error: unknown) => {
            if (!this.closed)
              console.warn(
                'Status evidence refresh failed',
                error instanceof Error ? error.name : 'unknown',
              );
          })
          .finally(() => this.schedule());
      },
      Math.min(250, this.interval()),
    );
    this.timer.unref();
  }
  private async pulse(): Promise<void> {
    if (this.closed) return;
    for (const id of this.interests.keys()) this.changed(id);
    if (this.activeWork || this.now() < this.nextRefresh) return;
    this.nextRefresh = this.now() + this.interval();
    const active = [...this.interests.values()];
    const batch = active.length
      ? [...active.slice(this.cursor), ...active.slice(0, this.cursor)].slice(
          0,
          this.activeConcurrency,
        )
      : [];
    this.cursor = active.length ? (this.cursor + batch.length) % active.length : 0;
    // Active refresh and monitor rotation share one capacity plan. Its reserved
    // monitor capacity must also drive the permit rotation estimate.
    this.activeWork = Promise.all(
      batch.map(async ({ subject }) => {
        if (this.pending >= this.concurrency || this.closed) return;
        await this.observe(subject, undefined, this.interval() / 2, 'active');
      }),
    )
      .then(() => undefined)
      .finally(() => {
        this.activeWork = undefined;
      });
    await this.activeWork;
  }
  observe(
    subject: Subject,
    signal?: AbortSignal,
    maxAgeMs = 0,
    kind: 'monitor' | 'active' = 'monitor',
  ): Promise<StatusObservation> {
    if (this.closed) return Promise.reject(Error('STATUS_EVIDENCE_CLOSED'));
    if (signal?.aborted) return Promise.reject(new ProviderError('cancelled'));
    const state = this.state(subject);
    if (
      state.last &&
      maxAgeMs > 0 &&
      this.now() >= state.last.at &&
      this.now() - state.last.at < maxAgeMs
    )
      return Promise.resolve(state.last);
    let work = this.work.get(subject.id);
    if (!work) {
      // Logical deadlines do not free a provider request that ignores abort.
      // Do not fan out replacement requests for that same source.
      if (this.pendingFor(subject.id))
        return Promise.resolve({ status: 'UNKNOWN', at: this.now() });
      if (kind === 'monitor') this.monitoring.add(subject.id);
      work = this.read(subject, state, kind).finally(() => {
        this.work.delete(subject.id);
        this.monitoring.delete(subject.id);
      });
      this.work.set(subject.id, work);
    }
    return waitFor(work, signal);
  }
  private async request(
    subject: Subject,
    state: State,
    kind: 'monitor' | 'active',
  ): Promise<StatusObservation> {
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    this.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, this.options.timeoutMs ?? 5000);
    let release: (() => void) | undefined;
    let status: PublicStatus;
    try {
      release = await this.budget.acquire(controller.signal);
      const done = Promise.resolve()
        .then(() => this.options.provider.status(subject.providerId, controller.signal))
        .catch((error: unknown) => {
          // A fresh permit allows one transport retry in the original request
          // deadline. UNKNOWN responses never retry or extend that permit.
          const transient =
            error instanceof ProviderError &&
            (['upstream-request', 'request-deadline', 'site-deadline'].includes(error.code) ||
              (error.code === 'upstream-http' &&
                [408, 425, 429, 500, 502, 503, 504].includes(error.status ?? 0)));
          if (transient && !controller.signal.aborted && this.public(subject.id))
            return this.options.provider.status(subject.providerId, controller.signal);
          throw error;
        });
      const request = { id: subject.id, kind, controller, done };
      this.requests.add(request);
      const releaseActual = release;
      release = undefined;
      void done
        .finally(() => {
          this.requests.delete(request);
          releaseActual();
        })
        .catch(() => undefined);
      status = await waitFor(done, controller.signal);
    } catch {
      status = 'UNKNOWN';
    } finally {
      release?.();
      clearTimeout(timer);
      this.controller.signal.removeEventListener('abort', cancel);
    }
    if (controller.signal.aborted) status = 'UNKNOWN';
    if (status === 'PRIVATE') {
      state.publicUntilMs = 0;
      state.revocation = 'PRIVATE';
      this.changed(subject.id);
    }
    return { status, at: this.now() };
  }
  private async read(
    subject: Subject,
    state: State,
    kind: 'monitor' | 'active',
  ): Promise<StatusObservation> {
    const first = await this.request(subject, state, kind);
    if (this.closed) throw Error('STATUS_EVIDENCE_CLOSED');
    if (first.at < state.observedAt) return { status: 'UNKNOWN', at: first.at };
    let { status } = first;
    let at = first.at,
      transitionAt: number | undefined;
    const baseline = state.confirmed;
    const prior = state.candidate;
    if (status !== 'UNKNOWN' && (baseline !== 'UNKNOWN' || prior) && status !== baseline) {
      const matching =
        prior !== undefined &&
        (prior.from === baseline || baseline === 'UNKNOWN') &&
        prior.status === status &&
        first.at >= prior.at &&
        prior.at >= state.observedAt &&
        first.at - prior.at < this.lease();
      if (matching) {
        transitionAt = prior.at;
        delete state.candidate;
      } else {
        state.candidate = { from: baseline, status, at: first.at };
        const second = await this.request(subject, state, kind);
        if (this.closed) throw Error('STATUS_EVIDENCE_CLOSED');
        if (second.at < first.at) {
          delete state.candidate;
          return { status: 'UNKNOWN', at: second.at };
        }
        at = second.at;
        if (second.status === status) {
          transitionAt = first.at;
          delete state.candidate;
        } else {
          console.info(
            JSON.stringify({
              event: 'status_transition_unconfirmed',
              subjectId: subject.id,
              from: baseline,
              proposed: status,
              observed: second.status,
              firstObservedAtMs: first.at,
              checkedAtMs: second.at,
            }),
          );
          if (second.status === baseline) delete state.candidate;
          else if (second.status !== 'UNKNOWN')
            state.candidate = { from: baseline, status: second.status, at: second.at };
          status = second.status === baseline ? baseline : 'UNKNOWN';
        }
      }
    } else if (status !== 'UNKNOWN') delete state.candidate;
    if (status === 'PUBLIC') {
      state.lastPublicAtMs = at;
      state.publicUntilMs = Math.max(state.publicUntilMs, at + this.lease());
      state.revocation = null;
      delete state.offline;
    } else if (status === 'PRIVATE') {
      state.publicUntilMs = 0;
      state.revocation = 'PRIVATE';
      delete state.offline;
    } else if (status === 'UNKNOWN') delete state.offline;
    else {
      const offline = state.offline ?? { count: 0, since: at };
      offline.count++;
      state.offline = offline;
      if (
        offline.count >= (this.options.offlineConfirmations ?? 2) &&
        at - offline.since >= (this.options.recoveryWindowMs ?? 15000)
      ) {
        state.publicUntilMs = 0;
        state.revocation = 'OFFLINE';
      }
    }
    const result = { status, at, ...(transitionAt === undefined ? {} : { transitionAt }) };
    if (status !== 'UNKNOWN') {
      try {
        await this.options.persist?.(subject.id, status, at, this.lease(), transitionAt);
      } catch (error) {
        // Preserve the original transition boundary if publication failed.
        if (status !== baseline)
          state.candidate = { from: baseline, status, at: transitionAt ?? at };
        throw error;
      }
      state.confirmed = status;
      state.observedAt = at;
    }
    state.last = result;
    this.changed(subject.id);
    return result;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach?.();
    clearTimeout(this.timer);
    this.controller.abort();
    for (const request of this.requests) request.controller.abort();
    await Promise.allSettled([
      ...this.work.values(),
      ...[...this.requests].map((request) => request.done),
      this.activeWork,
    ]);
    this.interests.clear();
    this.listeners.clear();
    this.states.clear();
  }
}
