import { useSyncExternalStore } from 'react';

/** Media progress is a local observable, not a workspace navigation action. */
export class PlaybackClock {
  private value: number | null = null;
  private currentPosition: { atMs: number | null; unitId?: string } = { atMs: null };
  readonly position = () => this.currentPosition;
  private readonly listeners = new Set<() => void>();
  readonly snapshot = (): number | null => this.value;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value: number | null, unitId?: string): void {
    if (Object.is(this.value, value) && this.currentPosition.unitId === unitId) return;
    this.value = value;
    this.currentPosition = { atMs: value, unitId };
    for (const listener of this.listeners) listener();
  }
}
const emptyPosition = { atMs: null };
export function usePlaybackPosition(clock: PlaybackClock | undefined) {
  return useSyncExternalStore(
    clock?.subscribe ?? idleSubscription,
    clock?.position ?? (() => emptyPosition),
    clock?.position ?? (() => emptyPosition),
  );
}

const idleSubscription = (): (() => void) => () => undefined;
export function usePlaybackClock(clock: PlaybackClock | undefined, fallback: number | null) {
  return useSyncExternalStore(
    clock?.subscribe ?? idleSubscription,
    clock?.snapshot ?? (() => fallback),
    clock?.snapshot ?? (() => fallback),
  );
}
