import type { SessionInfo } from '@st-vault/api-schema';
import { DEFAULT_RANGE_MS, isValidViewPosition, RANGE_STOPS } from './range-control';
import { normalizeSubjectFilter } from '../directory/subjects';

export interface ViewPreferences {
  filter: string;
  durationMs: number;
  viewToMs?: number | null;
}
const defaults: ViewPreferences = {
  filter: 'ONLINE',
  durationMs: DEFAULT_RANGE_MS,
  viewToMs: null,
};
export function preferenceKey(session: SessionInfo | null): string | null {
  return session?.authenticated && session.instanceId && session.userId
    ? `st-vault:${session.instanceId}:${session.userId}:view`
    : null;
}
export function readPreferences(key: string): ViewPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
    const saved = value as Partial<ViewPreferences>;
    return {
      filter: normalizeSubjectFilter(String(saved.filter)),
      durationMs:
        typeof saved.durationMs === 'number' && RANGE_STOPS.includes(saved.durationMs)
          ? saved.durationMs
          : defaults.durationMs,
      viewToMs: isValidViewPosition(saved.viewToMs) ? saved.viewToMs : null,
    };
  } catch {
    return { ...defaults };
  }
}
export function writePreferences(key: string, value: ViewPreferences): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        filter: value.filter,
        durationMs: value.durationMs,
        viewToMs: value.viewToMs ?? null,
      }),
    );
  } catch {
    /* Storage is optional, e.g. private browsing/quota. */
  }
}
export function clearPreferences(key: string | null): void {
  if (key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* No persistence available. */
    }
  }
}
