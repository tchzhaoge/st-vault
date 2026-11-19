import { syncReadFailure } from '../../shared/lib/sync';
import type { TrackData } from './TimelineBands';
export interface TrackPlan {
  ids: string[];
  visible: string[];
  prefetch: string[];
  fromMs: number;
  toMs: number;
  buckets: number;
  revision: number;
}
interface Row {
  subjectId: string;
  data: TrackData;
}
interface Entry {
  data: TrackData;
  scope: string;
  order: number;
}
interface Flight {
  plan: TrackPlan;
  ids: string[];
  controller: AbortController;
}
const scope = (plan: TrackPlan): string =>
  `${plan.fromMs}:${plan.toMs}:${plan.buckets}:${plan.revision}`;
const cacheKey = (id: string, plan: TrackPlan): string =>
  `${id}:${plan.fromMs}:${plan.toMs}:${plan.buckets}`;
/** Scrolling changes priority, not ownership of a useful in-flight metadata batch. */
export class TrackLoader {
  private readonly entries = new Map<string, Entry>();
  private readonly resolved = new Map<string, { from: number; to: number; key?: string }>();
  private readonly failures = new Map<
    string,
    { scope: string; order: number; retryAt: number; attempts: number; transient: boolean }
  >();
  private plan: TrackPlan | null = null;
  private readonly running = new Set<Flight>();
  private requestOrder = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly fetchRows: (
      ids: string[],
      plan: TrackPlan,
      signal: AbortSignal,
    ) => Promise<Row[]>,
    private readonly changed: () => void,
    private readonly limit = 64,
    private readonly options: { concurrency?: number; batchSize?: number } = {},
  ) {}
  get(id: string, from: number, to: number): TrackData | undefined {
    const cached = this.resolved.get(id);
    if (cached?.from === from && cached.to === to)
      return cached.key ? this.entries.get(cached.key)?.data : undefined;
    let key: string | undefined,
      rank = 0;
    for (const [candidate, entry] of this.entries) {
      const coverage = entry.data.coverage;
      if (coverage.subjectId !== id || coverage.fromMs >= to || coverage.toMs <= from) continue;
      const priority =
        coverage.fromMs === from && coverage.toMs === to
          ? 3
          : coverage.fromMs <= from && coverage.toMs >= to
            ? 2
            : 1;
      if (priority >= rank) {
        key = candidate;
        rank = priority;
      }
    }
    this.resolved.set(id, { from, to, key });
    while (this.resolved.size > this.limit)
      this.resolved.delete(this.resolved.keys().next().value!);
    return key ? this.entries.get(key)?.data : undefined;
  }
  failed(id: string): boolean {
    const failure = this.failures.get(id);
    return !!failure && !!this.plan && failure.scope === scope(this.plan);
  }
  update(plan: TrackPlan): void {
    if (this.closed) return;
    this.plan = plan;
    const wanted = new Set([...plan.visible, ...plan.ids, ...plan.prefetch]);
    // View ownership, rather than React render frequency, determines retention.
    for (const id of wanted) {
      this.get(id, plan.fromMs, plan.toMs);
      const key = this.resolved.get(id)?.key;
      const entry = key ? this.entries.get(key) : undefined;
      if (key && entry) {
        this.entries.delete(key);
        this.entries.set(key, entry);
      }
    }
    this.resolved.clear();
    for (const flight of this.running) {
      const previous = flight.plan;
      if (
        previous.fromMs !== plan.fromMs ||
        previous.toMs !== plan.toMs ||
        previous.buckets !== plan.buckets ||
        flight.ids.every((id) => !wanted.has(id))
      ) {
        flight.controller.abort();
        this.running.delete(flight);
      }
    }
    this.start();
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    for (const flight of this.running) flight.controller.abort();
    this.running.clear();
    this.entries.clear();
    this.resolved.clear();
    this.failures.clear();
  }
  private start(): void {
    clearTimeout(this.retry);
    if (this.closed || !this.plan) return;
    const plan = this.plan,
      key = scope(plan),
      retryAt = (id: string): number => {
        const failure = this.failures.get(id);
        // A fresh content revision cannot shorten transport/server backoff.
        return failure && (failure.transient || failure.scope === key) ? failure.retryAt : 0;
      },
      pending = (id: string): boolean =>
        [...this.running].some((flight) => scope(flight.plan) === key && flight.ids.includes(id)),
      needs = (id: string): boolean =>
        this.entries.get(cacheKey(id, plan))?.scope !== key &&
        Date.now() >= retryAt(id) &&
        !pending(id);
    // The response is atomic: never put offscreen work in front of visible paint.
    // Limit the working set as well as the cache, avoiding prefetch eviction loops.
    const wanted = [...new Set([...plan.visible, ...plan.ids, ...plan.prefetch])].slice(
      0,
      this.limit,
    );
    while (this.running.size < (this.options.concurrency ?? 2)) {
      const visible = plan.visible.filter((id) => wanted.includes(id) && needs(id));
      // Keep visible responses small and independent. Overscan does not occupy
      // a free slot while the first visible response is still being prepared.
      const visibleRunning = [...this.running].some((flight) =>
        flight.ids.some((id) => plan.visible.includes(id)),
      );
      const candidates = visible.length ? visible : visibleRunning ? [] : wanted.filter(needs);
      // Match the server's three-row execution wave: an atomic response should
      // not hold completed visible rows behind a second wave in the same packet.
      const ids = candidates.slice(0, this.options.batchSize ?? 3);
      if (!ids.length) break;
      this.load(plan, ids, key);
    }
    const now = Date.now();
    const next = Math.min(
      ...wanted
        .filter((id) => !pending(id) && this.entries.get(cacheKey(id, plan))?.scope !== key)
        .map(retryAt)
        .filter((at) => at > now),
    );
    if (Number.isFinite(next)) this.retry = setTimeout(() => this.start(), next - now);
  }
  private load(plan: TrackPlan, ids: string[], key: string): void {
    const current = { plan, ids, controller: new AbortController(), order: ++this.requestOrder };
    this.running.add(current);
    void this.fetchRows(ids, plan, current.controller.signal)
      .then((rows) => {
        if (this.closed || current.controller.signal.aborted) return;
        for (const row of rows) {
          const rowKey = cacheKey(row.subjectId, plan);
          if (this.superseded(row.subjectId, plan, current.order)) continue;
          this.entries.delete(rowKey);
          this.entries.set(rowKey, { data: row.data, scope: key, order: current.order });
          this.failures.delete(row.subjectId);
        }
        while (this.entries.size > this.limit)
          this.entries.delete(this.entries.keys().next().value!);
        this.resolved.clear();
        this.changed();
      })
      .catch((error) => {
        if (this.closed || current.controller.signal.aborted) return;
        // Retry transport/overload failures, never repeat invalid requests on a timer.
        const outcome = syncReadFailure(error, current.controller.signal);
        const transient = outcome.status === 'retry';
        for (const id of ids) {
          if (this.superseded(id, plan, current.order)) continue;
          const previous = this.failures.get(id);
          const attempts =
            previous && (previous.transient || previous.scope === key) ? previous.attempts + 1 : 1;
          this.failures.set(id, {
            scope: key,
            order: current.order,
            attempts,
            transient,
            retryAt: transient
              ? Math.max(
                  outcome.notBeforeMs,
                  Date.now() + Math.min(30000, 3000 * 2 ** Math.min(4, attempts - 1)),
                )
              : Infinity,
          });
        }
        while (this.failures.size > this.limit)
          this.failures.delete(this.failures.keys().next().value!);
        console.warn('Timeline rows unavailable', error);
        this.changed();
      })
      .finally(() => {
        this.running.delete(current);
        this.start();
      });
  }
  private superseded(id: string, plan: TrackPlan, order: number): boolean {
    // Ordering covers data and failures even after another plan revision arrives.
    return (
      (this.entries.get(cacheKey(id, plan))?.order ?? 0) > order ||
      (this.failures.get(id)?.order ?? 0) > order
    );
  }
}
