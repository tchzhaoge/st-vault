import type {
  MediaDeletionJob,
  PersonalTimeline,
  SnapshotItem,
  MediaTimeRange,
  MediaSelection,
  MediaSelectionResult,
  MediaDeletionTarget,
} from '@st-vault/api-schema';
import { request, MutationOutcomeUnknown } from '../../shared/lib/api';

interface Operation {
  readonly revision: number;
  readonly scope: string;
  readonly signal: AbortSignal;
}
/** Owns command admission and protocol. Releasing UI ownership never rolls back durable intent. */
export class SnapshotCommands {
  async admitDeletion(
    subjectId: string,
    commandId: string,
    target: MediaDeletionTarget,
  ): Promise<MediaDeletionJob> {
    const body = JSON.stringify({ commandId, target });
    const submit = () =>
      this.transport<MediaDeletionJob>(
        `/api/subjects/${encodeURIComponent(subjectId)}/deletion-intents`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: body.length < 60000,
        },
      );
    try {
      return await submit();
    } catch (cause) {
      // The receipt is keyed by commandId, so repeating this exact admission
      // cannot create a second task or capture newly recorded media.
      if (cause instanceof MutationOutcomeUnknown) return submit();
      throw cause;
    }
  }
  private revision = 0;
  private held = false;
  private preparation: AbortController | null = null;
  private favoriteTail: Promise<number | undefined> | undefined;
  private favoriteRevision: number | undefined;
  constructor(private readonly transport: typeof request = request) {}
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.transport(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  get busy(): boolean {
    return this.held;
  }
  begin(scope: string): Operation | null {
    if (this.held) return null;
    this.held = true;
    this.preparation = new AbortController();
    return Object.freeze({ revision: ++this.revision, scope, signal: this.preparation.signal });
  }
  current(operation: Operation, scope = operation.scope): boolean {
    return operation.revision === this.revision && operation.scope === scope;
  }
  release(operation: Operation): void {
    if (operation.revision === this.revision) {
      this.held = false;
      this.preparation?.abort();
      this.preparation = null;
    }
  }
  cancelPreparation(): void {
    this.preparation?.abort();
    this.preparation = null;
    this.revision++;
    this.held = false;
  }
  dispose(): void {
    this.cancelPreparation();
    this.revision++;
    this.held = false;
  }
  get hasFavoriteWrites(): boolean {
    return this.favoriteTail !== undefined;
  }
  setFavorite(
    subjectId: string,
    item: SnapshotItem,
    liked: boolean,
    revision: number,
  ): Promise<Pick<PersonalTimeline, 'favorites' | 'revision'>> {
    const earlier = this.favoriteTail;
    const result = (async () => {
      const prior = earlier
        ? ((await earlier) ?? (await this.personal(subjectId, [item])).revision)
        : this.favoriteRevision;
      return this.post<Pick<PersonalTimeline, 'favorites' | 'revision'>>(
        `/api/subjects/${encodeURIComponent(subjectId)}/unit-favorites`,
        { unitIds: [item.unitId], liked, revision: Math.max(revision, prior ?? revision) },
      );
    })();
    const tail = result.then(
      ({ revision: committed }) => {
        this.favoriteRevision = committed;
        return committed;
      },
      () => {
        this.favoriteRevision = undefined;
        return undefined;
      },
    );
    this.favoriteTail = tail;
    void tail.then(() => {
      if (this.favoriteTail === tail) this.favoriteTail = undefined;
    });
    return result;
  }
  async unlikeRange(
    subjectId: string,
    range: MediaTimeRange,
    signal: AbortSignal,
  ): Promise<MediaSelectionResult> {
    const selection = await this.transport<MediaSelection>(
      `/api/subjects/${encodeURIComponent(subjectId)}/media-selection`,
      {
        method: 'POST',
        operation: 'session',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...range, mode: 'all' }),
        signal,
      },
    );
    signal.throwIfAborted();
    return this.post(
      `/api/subjects/${encodeURIComponent(subjectId)}/media-selection/${selection.id}/favorites`,
      { liked: false, revision: selection.personalRevision },
    );
  }
  async personal(
    subjectId: string,
    items: SnapshotItem[],
    signal?: AbortSignal,
  ): Promise<PersonalTimeline> {
    if (!items.length) throw Error('EMPTY_SNAPSHOT_SELECTION');
    const budget = new AbortController();
    const timer = setTimeout(
      () => budget.abort(new DOMException('Preparation timed out', 'TimeoutError')),
      15000,
    );
    const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
    try {
      combined.throwIfAborted();
      const value = await this.transport<PersonalTimeline>(
        `/api/subjects/${encodeURIComponent(subjectId)}/unit-favorites/query`,
        {
          method: 'POST',
          operation: 'session',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unitIds: items.map((item) => item.unitId) }),
          signal: combined,
        },
      );
      combined.throwIfAborted();
      if (value.truncated) throw Error('FAVORITES_TRUNCATED');
      return {
        ...value,
        ...items.reduce(
          (bounds, item) => ({
            fromMs: Math.min(bounds.fromMs, item.slotFromMs),
            toMs: Math.max(bounds.toMs, item.slotToMs),
          }),
          { fromMs: Infinity, toMs: -Infinity },
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  jobs(signal?: AbortSignal): Promise<MediaDeletionJob[]> {
    return this.transport('/api/media-deletions', { signal });
  }
}
