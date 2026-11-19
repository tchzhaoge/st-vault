import type { PlaybackResponse } from '@st-vault/api-schema';
import { ApiError } from '../../shared/lib/api';

/** HLS media is contiguous even when the corresponding archive UTC clock jumps. */
export function archiveMediaEnd(playback: PlaybackResponse): number {
  let elapsed = 0;
  for (const segment of playback.segments) {
    if (playback.rangeToMs !== undefined && segment.wallStartMs !== null) {
      if (segment.wallStartMs >= playback.rangeToMs) return elapsed;
      if (segment.wallStartMs + segment.durationSeconds * 1000 > playback.rangeToMs)
        return elapsed + (playback.rangeToMs - segment.wallStartMs) / 1000;
    }
    elapsed += segment.durationSeconds;
  }
  return elapsed;
}

export function shouldPrepareNext(playback: PlaybackResponse, mediaTime: number): boolean {
  return playback.nextAtMs != null && archiveMediaEnd(playback) - mediaTime <= 15;
}

function retryable(error: unknown): boolean {
  return error instanceof ApiError
    ? error.status === 408 || error.status === 429 || error.status >= 500
    : error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
}

function cooldown(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** One preparation per source, with bounded transient retries. Cancellation also
 * releases a late server session even if its request ignored the abort signal. */
export class Preparation<T> {
  private controller: AbortController | null = null;
  private running = false;
  constructor(private readonly release: (value: T) => void) {}
  get pending(): boolean {
    return this.running;
  }
  async run(load: (signal: AbortSignal) => Promise<T | null>): Promise<T | null> {
    if (this.controller) return null;
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) return null;
        let value: T | null;
        try {
          value = await load(controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return null;
          if (!retryable(error) || attempt >= 3) throw error;
          // Keep the same operation pending during backoff, including after the
          // active video ends and no further progress events can trigger a retry.
          await cooldown(1000 * 2 ** attempt, controller.signal);
          continue;
        }
        if (controller.signal.aborted) {
          if (value !== null) this.release(value);
          return null;
        }
        return value;
      }
    } finally {
      if (this.controller === controller) this.running = false;
    }
  }
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.running = false;
  }
}
