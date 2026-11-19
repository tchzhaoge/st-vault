import { afterEach, expect, it, vi } from 'vitest';
import { DAY_MS, RANGE_STOPS } from './range-control';
import {
  clearPreferences,
  preferenceKey,
  readPreferences,
  writePreferences,
} from './view-preferences';
afterEach(() => vi.unstubAllGlobals());
it('resets unsupported filters instead of translating retired values', () => {
  for (const [old, current] of [
    ['ALL', 'ONLINE'],
    ['PUBLIC', 'ONLINE'],
    ['PRIVATE', 'ONLINE'],
    ['UNKNOWN', 'ONLINE'],
    ['ARCHIVED', 'ARCHIVED'],
  ]) {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ filter: old }) });
    expect(readPreferences('key').filter).toBe(current);
  }
});
it('round-trips current controls in an installation and administrator namespace', () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  const key = preferenceKey({
    authenticated: true,
    setupRequired: false,
    instanceId: 'nas-a',
    userId: 'admin',
  })!;
  expect(key).toBe('st-vault:nas-a:admin:view');
  const controls = {
    filter: 'ONLINE',
    durationMs: 2 * DAY_MS,
    viewToMs: Date.UTC(2026, 10, 5, 16),
  };
  writePreferences(key, controls);
  expect(JSON.parse(data.get(key)!)).toEqual(controls);
  expect(readPreferences(key)).toEqual(controls);
  expect(readPreferences(key.replace('nas-a', 'nas-b'))).toEqual({
    filter: 'ONLINE',
    durationMs: DAY_MS,
    viewToMs: null,
  });
  data.set('other-app', 'keep');
  clearPreferences(key);
  expect(data.has(key)).toBe(false);
  expect(data.get('other-app')).toBe('keep');
  expect(preferenceKey({ authenticated: false, setupRequired: true })).toBeNull();
});
it('retains every supported half-day span and location', () => {
  for (const durationMs of RANGE_STOPS) {
    const saved = {
      filter: 'ONLINE',
      durationMs,
      viewToMs: Date.UTC(2026, 10, 5, 16),
    };
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved) });
    expect(readPreferences('key')).toEqual(saved);
  }
});
it('rejects unsupported spans and corrupt locations without migrating them', () => {
  for (const durationMs of [60000, 310000, -1, Infinity, 'bad']) {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ filter: 'invalid', durationMs, viewToMs: -1 }),
    });
    expect(readPreferences('key')).toEqual({
      filter: 'ONLINE',
      durationMs: DAY_MS,
      viewToMs: null,
    });
  }
  for (const value of ['{', 'null', '[]', '3']) {
    vi.stubGlobal('localStorage', { getItem: () => value });
    expect(readPreferences('key')).toEqual({
      filter: 'ONLINE',
      durationMs: DAY_MS,
      viewToMs: null,
    });
  }
});
it('continues when browser storage is unavailable', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw Error('disabled');
    },
    setItem: () => {
      throw Error('quota');
    },
    removeItem: () => {
      throw Error('disabled');
    },
  });
  expect(readPreferences('key').filter).toBe('ONLINE');
  expect(() => {
    writePreferences('key', {
      filter: 'ONLINE',
      durationMs: DAY_MS,
      viewToMs: null,
    });
    clearPreferences('key');
  }).not.toThrow();
});
it('rejects timestamps outside the calendar rendering range', () => {
  for (const viewToMs of [Number.MAX_SAFE_INTEGER, 8640000000000000, -1, 'tomorrow']) {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ filter: 'PUBLIC', durationMs: 7 * DAY_MS, viewToMs }),
    });
    expect(readPreferences('key')).toEqual({
      filter: 'ONLINE',
      durationMs: 7 * DAY_MS,
      viewToMs: null,
    });
  }
});
