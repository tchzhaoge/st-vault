import type { ViewWindow } from './time';

export interface ListPosition {
  id: string;
  offset: number;
  left: number;
}
export interface WorkspaceState {
  list: ListPosition | null;
  playback: {
    subjectId: string;
    kind: 'live' | 'archive';
    atMs: number | null;
    explicitUnitId?: string;
    range: ViewWindow;
    view: 'following' | 'selection';
  } | null;
}
const storageKey = (key: string): string => `${key}:workspace`;
export function readWorkspace(key: string): WorkspaceState {
  const empty = { list: null, playback: null };
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(key)) ?? 'null');
    if (!value || typeof value !== 'object') return empty;
    const { list, playback } = value as Partial<WorkspaceState>;
    const time = (at: unknown): at is number =>
      typeof at === 'number' && Number.isSafeInteger(at) && at >= 0;
    return {
      list:
        list && typeof list.id === 'string' && time(list.offset) && time(list.left) ? list : null,
      playback:
        playback &&
        typeof playback.subjectId === 'string' &&
        (playback.kind === 'live' || playback.kind === 'archive') &&
        (playback.atMs === null || time(playback.atMs)) &&
        time(playback.range?.fromMs) &&
        time(playback.range?.toMs) &&
        playback.range.toMs > playback.range.fromMs &&
        (playback.kind === 'live' || playback.atMs !== null) &&
        (playback.view === undefined ||
          playback.view === 'following' ||
          playback.view === 'selection')
          ? {
              subjectId: playback.subjectId,
              kind: playback.kind,
              atMs: playback.atMs,
              ...(typeof playback.explicitUnitId === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                playback.explicitUnitId,
              )
                ? { explicitUnitId: playback.explicitUnitId }
                : {}),
              range: playback.range,
              // A missing view mode never implies a lock from media kind.
              view: playback.view ?? 'following',
            }
          : null,
    };
  } catch {
    // Browser storage is optional; malformed or unavailable state starts cleanly.
    return empty;
  }
}
export function writeWorkspace(key: string, value: WorkspaceState | null): void {
  try {
    if (value) sessionStorage.setItem(storageKey(key), JSON.stringify(value));
    else sessionStorage.removeItem(storageKey(key));
  } catch {
    // Private browsing or storage quotas must not interrupt playback.
  }
}
