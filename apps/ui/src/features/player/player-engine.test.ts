import { expect, it, vi } from 'vitest';
vi.mock('hls.js', () => ({ default: class Engine {} }));
import { loadPlayerEngine } from './player-engine';
it('shares the preparation promise between selection and the mounted media slot', async () => {
  const selecting = loadPlayerEngine(),
    mounting = loadPlayerEngine();
  expect(mounting).toBe(selecting);
  expect((await selecting).default).toBeDefined();
});

it('allows a later selection to retry a failed module preparation', async () => {
  vi.resetModules();
  let attempts = 0;
  vi.doMock('hls.js', () => {
    if (++attempts === 1) throw new Error('module-unavailable');
    return { default: class Engine {} };
  });
  const { loadPlayerEngine: load } = await import('./player-engine');
  await expect(load()).rejects.toMatchObject({
    cause: { message: 'module-unavailable' },
  });
  vi.doMock('hls.js', () => {
    attempts++;
    return { default: class Engine {} };
  });
  expect((await load()).default).toBeDefined();
  expect(attempts).toBe(2);
});
