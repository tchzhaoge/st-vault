import { expect, it } from 'vitest';
import { SettingsStore, defaultRuntimeSettings, settingsSchema } from './settings.js';

it('persists only supported settings and preserves unrelated values across patches', async () => {
  let stored: string | null = null;
  const archive = {
    getSetting: () => Promise.resolve(stored),
    setSetting: (_key: string, value: string) => {
      stored = value;
      return Promise.resolve();
    },
  };
  const store = await SettingsStore.open(archive, {});
  expect(store.get()).toEqual(defaultRuntimeSettings);
  await store.update({ retentionDays: 7 });
  await store.update({ pollMs: 6000 });
  expect((await SettingsStore.open(archive, {})).get()).toEqual({
    ...defaultRuntimeSettings,
    retentionDays: 7,
    pollMs: 6000,
  });
  expect(Object.keys(JSON.parse(stored!) as Record<string, unknown>).sort()).toEqual([
    'minFreeBytes',
    'pollMs',
    'retentionDays',
  ]);
});

it('rejects retired controls and invalid patches without writing', async () => {
  const writes: string[] = [];
  const store = await SettingsStore.open(
    {
      getSetting: () => Promise.resolve(null),
      setSetting: (_key, value) => {
        writes.push(value);
        return Promise.resolve();
      },
    },
    {},
  );
  for (const patch of [
    {},
    { unknown: true },
    { maxConcurrent: 2 },
    { recordingQuality: '720p' },
    { pollMs: 999 },
    { retentionDays: 3651 },
    { minFreeBytes: 2 ** 50 + 1 },
  ])
    await expect(async () => store.update(patch)).rejects.toThrow();
  expect(writes).toEqual([]);
  expect(() => settingsSchema.parse({ ...defaultRuntimeSettings, maxConcurrent: 2 })).toThrow();
});

it('projects persisted settings to the current fields and ignores retired environment controls', async () => {
  const store = await SettingsStore.open(
    {
      getSetting: () =>
        Promise.resolve(
          JSON.stringify({
            ...defaultRuntimeSettings,
            pollMs: 7000,
            maxConcurrent: 1,
            recordingQuality: '360p',
          }),
        ),
      setSetting: () => Promise.resolve(),
    },
    { STV_MAX_CONCURRENT: '1' },
  );
  expect(store.get()).toEqual({ ...defaultRuntimeSettings, pollMs: 7000 });
});
