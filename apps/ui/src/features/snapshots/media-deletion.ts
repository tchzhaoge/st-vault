import type { MediaDeletePlan, MediaTimeRange, MediaDeletionJob } from '@st-vault/api-schema';
export interface MediaDeletionEvent {
  commandId?: string;
  optimisticRanges?: MediaTimeRange[];
  knownEmpty?: boolean;
  subjectId: string;
  plan: Pick<MediaDeletePlan, 'fromMs' | 'toMs'>;
}
/** Observe accepted intent, including a task that completed between heartbeats
 * or whose POST response was lost. Initial completed history is only a baseline. */
export class DeletionObserver {
  private jobs = new Map<string, MediaDeletionJob>();
  private initialized = false;
  private readonly submissions = new Set<string>();
  submit(id: string): void {
    if (!this.initialized) this.submissions.add(id);
  }
  private merge(incoming: MediaDeletionJob[]): MediaDeletionJob[] {
    const merged = new Map<string, MediaDeletionJob>();
    for (const job of [...incoming, ...this.jobs.values()]) {
      const previous = merged.get(job.id) ?? this.jobs.get(job.id);
      // Inventory GET and acceptance POST may finish in either order. A completed
      // task is terminal, and a response cannot lower the observed task version.
      merged.set(
        job.id,
        previous &&
          (['completed', 'failed'].includes(previous.state) ||
            previous.updatedAtMs >= job.updatedAtMs)
          ? previous
          : job,
      );
    }
    return [...merged.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.createdAtMs - a.createdAtMs)
      .slice(0, 84);
  }
  remember(job: MediaDeletionJob): { jobs: MediaDeletionJob[]; accepted: MediaDeletionJob[] } {
    this.submissions.delete(job.id);
    const previous = this.jobs.get(job.id);
    const jobs = this.merge([job]);
    this.jobs = new Map(jobs.map((item) => [item.id, item]));
    return { jobs, accepted: previous ? [] : [this.jobs.get(job.id)!] };
  }
  update(jobs: MediaDeletionJob[]): {
    jobs: MediaDeletionJob[];
    accepted: MediaDeletionJob[];
    settled: boolean;
  } {
    const incoming = jobs;
    jobs = this.merge(incoming);
    const accepted = jobs.filter(
      (job) =>
        (!this.jobs.has(job.id) &&
          (this.initialized ||
            !['completed', 'failed'].includes(job.state) ||
            this.submissions.has(job.id))) ||
        (job.state === 'failed' &&
          this.jobs.has(job.id) &&
          this.jobs.get(job.id)!.state !== 'failed'),
    );
    const settled =
      accepted.some((job) => job.state === 'completed') ||
      jobs.some(
        (job) =>
          job.state === 'completed' &&
          this.jobs.has(job.id) &&
          this.jobs.get(job.id)!.state !== 'completed',
      );
    this.jobs = new Map(jobs.map((job) => [job.id, job]));
    this.initialized = true;
    this.submissions.clear();
    return { jobs, accepted, settled };
  }
}
/** Playback owns an interval, including fragments not decoded yet. Mutating any
 * part invalidates that source and its continuation, rather than patching clocks. */
export function deletionAffectsPlayback(
  event: Pick<MediaDeletionEvent, 'subjectId' | 'plan'>,
  playback: { subjectId: string | null; kind: 'live' | 'archive'; range: MediaTimeRange },
): boolean {
  return (
    event.subjectId === playback.subjectId &&
    playback.kind === 'archive' &&
    event.plan.fromMs !== null &&
    event.plan.toMs !== null &&
    event.plan.fromMs < playback.range.toMs &&
    event.plan.toMs > playback.range.fromMs
  );
}
