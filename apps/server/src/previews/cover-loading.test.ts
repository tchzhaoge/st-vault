import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createPreviews } from './index.js';
import type { Subject } from '@st-vault/api-schema';
const bytes = Buffer.from([255, 216, 255, 217]);
const archive = {
  async getSubject(id: string) {
    return (await this.listSubjects()).find((row) => row.id === id) ?? null;
  },

  listSubjects: (): Promise<Subject[]> =>
    Promise.resolve(
      [42, 43, 44].map((providerId) => ({
        id: `stripchat:${providerId}`,
        providerId,
        handle: 'fixture',
        providerStatus: 'PUBLIC',
        observedAtMs: 1,
        monitorEnabled: true,
        autoRecord: false,
      })),
    ),
  locate: vi.fn(),
  timeline: vi.fn(),
  media: vi.fn(),
  hasMedia: vi.fn(),
};
afterEach(() => vi.restoreAllMocks());
it('serves a cached cover while both anonymous network workers are stalled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-fast-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stall = false;
  const fetch = vi.fn(async (input) => {
    const url = String(input);
    if (stall && url.includes('/broadcasts/')) await gate;
    return url.includes('/broadcasts/')
      ? Response.json({ item: { snapshotTimestamp: 123 } })
      : new Response(bytes);
  });
  const previews = createPreviews({ archive, cacheRoot: root, fetch, decoder: vi.fn() });
  const requests: Promise<Uint8Array>[] = [];
  try {
    await previews.cover('stripchat:42');
    stall = true;
    requests.push(previews.cover('stripchat:43'), previews.cover('stripchat:44'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    const cached = previews.cover('stripchat:42', undefined, true);
    requests.push(cached);
    const result = await Promise.race([
      cached,
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(result).not.toBe('blocked');
    expect(Array.from(result as Uint8Array)).toEqual([...bytes]);
  } finally {
    release();
    await Promise.allSettled(requests);
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('returns a stale local image immediately and schedules its refresh instead of waiting on the source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-stale-'));
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetch = vi.fn((input) =>
    Promise.resolve(
      String(input).includes('/broadcasts/')
        ? Response.json({ item: { snapshotTimestamp: 123 } })
        : new Response(bytes),
    ),
  );
  const previews = createPreviews({ archive, cacheRoot: root, fetch, decoder: vi.fn() });
  try {
    await previews.cover('stripchat:42');
    now += 16000;
    expect([...(await previews.cover('stripchat:42'))]).toEqual([...bytes]);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});
