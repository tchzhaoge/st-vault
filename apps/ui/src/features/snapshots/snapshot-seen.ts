import { request, ApiError } from '../../shared/lib/api';
import type { UnitSeenEvidence } from '@st-vault/api-schema';

/** Image completion is evidence; prefetching and playback are not. Batch evidence
 * without blocking browsing, and retry safely because server writes are monotonic. */
export class SnapshotSeen {
  private readonly pending = new Map<string, Map<string, number>>();
  private readonly acknowledged = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private failures = 0;
  constructor(
    private readonly send: (
      subjectId: string,
      evidence: UnitSeenEvidence[],
    ) => Promise<{ changed: number }>,
    private readonly changed: () => void,
  ) {}
  loaded(subjectId: string, unitId: string, toMs: number): void {
    if ((this.acknowledged.get(`${subjectId}:${unitId}`) ?? -1) >= toMs) return;
    const ids = this.pending.get(subjectId) ?? new Map<string, number>();
    ids.set(unitId, Math.max(ids.get(unitId) ?? -1, toMs));
    this.pending.set(subjectId, ids);
    this.schedule(120);
  }
  private schedule(delay: number): void {
    if (this.timer || this.running || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }
  async flush(): Promise<void> {
    if (this.running) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const entry = this.pending.entries().next().value;
    if (!entry) return;
    const [subjectId, pending] = entry;
    const evidence = [...pending].slice(0, 100).map(([unitId, toMs]) => ({ unitId, toMs }));
    this.running = true;
    try {
      const result = await this.send(subjectId, evidence);
      for (const { unitId, toMs } of evidence) {
        if (pending.get(unitId) === toMs) pending.delete(unitId);
        this.acknowledged.set(`${subjectId}:${unitId}`, toMs);
      }
      while (this.acknowledged.size > 4096)
        this.acknowledged.delete(this.acknowledged.keys().next().value!);
      if (!pending.size) this.pending.delete(subjectId);
      this.failures = 0;
      if (result.changed) this.changed();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      ) {
        // A fresh authenticated mount can report again. Do not poll an expired session.
        this.pending.delete(subjectId);
        if (error.status !== 401) console.warn('Snapshot seen evidence rejected', error);
        this.failures = 0;
        return;
      }
      if (!this.failures) console.warn('Snapshot seen evidence pending; retrying', error);
      this.failures++;
    } finally {
      this.running = false;
      this.schedule(this.failures ? Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5)) : 120);
    }
  }
}
export const snapshotSeen = new SnapshotSeen(
  (subjectId, evidence) =>
    request(`/api/subjects/${encodeURIComponent(subjectId)}/unit-seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evidence }),
      keepalive: true,
    }),
  () => window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['seen'] })),
);
if (typeof window !== 'undefined')
  window.addEventListener('pagehide', () => {
    void snapshotSeen.flush();
  });
