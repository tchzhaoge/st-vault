import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ScreenshotJobs } from '../previews/jobs.js';

it('adopts verified portable screenshots into a fresh queue without decoding the recording again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-portable-snapshot-'));
  const item = {
    unitId: 'unit-id',
    atMs: 1000,
    slotFromMs: 1000,
    slotToMs: 3000,
    imageToMs: 1500,
    url: '/image',
    open: false,
    timeBasis: 'source-pdt' as const,
    uncertaintyMs: 0,
  };
  const render = vi.fn(() =>
    Promise.resolve({
      bytes: Buffer.from([255, 216, 255, 217]),
      throughMs: 1500,
      mediaIds: ['source-media'],
    }),
  );
  const archive = {
    listSubjects: () => Promise.resolve([]),
    locate: () => Promise.resolve(null),
    snapshotUnit: () => Promise.resolve(item),
    snapshotUnits: () => Promise.resolve({ items: [], cursor: null }),
    snapshotForSegment: () => Promise.resolve(null),
    hasMedia: () => Promise.resolve(true),
  };
  const options = {
    root: path.join(root, 'first-queue'),
    mediaRoot: path.join(root, 'media'),
    archive,
    render,
    validate: () => Promise.resolve(),
    cooldown: false,
    pollMs: 5,
  };
  let queue = await ScreenshotJobs.open(options);
  try {
    await queue.enqueue('stripchat:42', item);
    await vi.waitFor(async () =>
      expect(await queue.hasCompleted('stripchat:42', 1000, 'unit-id')).toBe(true),
    );
    await queue.close();
    render.mockClear();
    queue = await ScreenshotJobs.open({
      ...options,
      root: path.join(root, 'fresh-queue'),
      canGenerate: () => false,
    });
    await queue.enqueue('stripchat:42', item);
    await vi.waitFor(async () =>
      expect(await queue.hasCompleted('stripchat:42', 1000, 'unit-id')).toBe(true),
    );
    expect(render).not.toHaveBeenCalled();
    expect(await queue.read('stripchat:42', 1000, 1500, 'unit-id')).toEqual(
      Buffer.from([255, 216, 255, 217]),
    );
  } finally {
    await queue.close();
    await rm(root, { recursive: true, force: true });
  }
});
