import { afterEach, expect, it, vi } from 'vitest';
import { readWorkspace, writeWorkspace, type WorkspaceState } from './workspace-state';
afterEach(() => vi.unstubAllGlobals());
it('retains a connection and list anchor across reloads, isolated by installation/user', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const value: WorkspaceState = {
    list: { id: 'stripchat:210', offset: 17, left: 0 },
    playback: {
      subjectId: 'stripchat:42',
      kind: 'archive',
      atMs: 1500,
      explicitUnitId: '11111111-1111-4111-8111-111111111111',
      range: { fromMs: 1000, toMs: 2000 },
      view: 'selection',
    },
  };
  for (const kind of ['archive', 'live'] as const) {
    value.playback!.kind = kind;
    for (const view of ['following', 'selection'] as const) {
      value.playback!.view = view;
      writeWorkspace('nas:admin', value);
      expect(readWorkspace('nas:admin')).toEqual(value);
    }
  }
  expect(readWorkspace('other:admin')).toEqual({ list: null, playback: null });
  writeWorkspace('nas:admin', { ...value, playback: null });
  expect(readWorkspace('nas:admin').playback).toBeNull();
  writeWorkspace('nas:admin', null);
  expect(storage.size).toBe(0);
});
it('rejects invalid playback ranges and unavailable browser storage', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () =>
      JSON.stringify({
        playback: {
          subjectId: '42',
          kind: 'archive',
          atMs: 200,
          range: { fromMs: 300, toMs: 100 },
          view: 'selection',
        },
      }),
  });
  expect(readWorkspace('key')).toEqual({ list: null, playback: null });
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw Error('disabled');
    },
    setItem: () => {
      throw Error('disabled');
    },
  });
  expect(readWorkspace('key')).toEqual({ list: null, playback: null });
  expect(() => writeWorkspace('key', { list: null, playback: null })).not.toThrow();
});
it('retains media and list coordinates without trusting an unspecified view lock', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () =>
      JSON.stringify({
        list: { id: '42', offset: 12, left: 0 },
        playback: {
          subjectId: '42',
          kind: 'archive',
          atMs: 1500,
          range: { fromMs: 1000, toMs: 2000 },
          hasSelection: true,
        },
      }),
  });
  const saved = readWorkspace('key');
  expect(saved.list?.offset).toBe(12);
  expect(saved.playback).toEqual({
    subjectId: '42',
    kind: 'archive',
    atMs: 1500,
    range: { fromMs: 1000, toMs: 2000 },
    view: 'following',
  });
});
