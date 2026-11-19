type Channel = 'range' | 'playback';
interface Scrub {
  target: number;
  work: (target: number) => Promise<void>;
  valid: () => boolean;
}
/** Owns request generations and the latest pending seek, independently of React rendering. */
export class PlaybackCoordinator<Source> {
  private generation = 0;
  private requests = new Map<Channel, AbortController>();
  private pending: Scrub | null = null;
  private scrubbing = false;
  constructor(private readonly release: (source: Source) => Promise<void>) {}
  stamp(): number {
    return this.generation;
  }
  current(stamp: number): boolean {
    return stamp === this.generation;
  }
  begin(channel: Channel): AbortController {
    this.cancel(channel);
    const request = new AbortController();
    this.requests.set(channel, request);
    return request;
  }
  cancel(channel: Channel): void {
    this.requests.get(channel)?.abort();
    this.requests.delete(channel);
  }
  owns(channel: Channel, request: AbortController): boolean {
    return this.requests.get(channel) === request && !request.signal.aborted;
  }
  settled(channel: Channel, request: AbortController): void {
    if (this.requests.get(channel) === request) this.requests.delete(channel);
  }
  invalidate(): void {
    this.generation++;
    this.cancel('range');
    this.cancel('playback');
    this.pending = null;
  }
  adopt(stamp: number, signal: AbortSignal, source: Source): boolean {
    if (!signal.aborted && this.current(stamp)) return true;
    void this.release(source).catch((error: unknown) =>
      console.warn('Abandoned playback release failed', error),
    );
    return false;
  }
  async scrub(target: number, work: Scrub['work'], valid: Scrub['valid']): Promise<void> {
    this.pending = { target, work, valid };
    if (this.scrubbing) return;
    this.scrubbing = true;
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = null;
        if (next.valid()) await next.work(next.target);
      }
    } finally {
      this.scrubbing = false;
    }
  }
}
