/* eslint-disable @typescript-eslint/require-await -- Deterministic offline port implementations. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Segment, Subject, SnapshotItem, SnapshotPagesResponse } from '@st-vault/api-schema';
import type { PreviewsPort } from '../ports.js';
import { createPreviews } from './index.js';
import type { DecodeInput } from './ffmpeg.js';
import { SnapshotDecodeError } from './ffmpeg.js';

const image = Buffer.from([255, 216, 255, 217]),
  cleanups: PreviewsPort[] = [];
const addressOf = (address: URL | string | Request): string =>
  typeof address === 'string' ? address : address instanceof URL ? address.href : address.url;
afterEach(async () => {
  for (const previews of cleanups.splice(0)) await previews.close();
});
const tick = async (): Promise<void> => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
function segment(id: string, start: number, end: number, patch: Partial<Segment> = {}): Segment {
  return {
    id,
    subjectId: 'stripchat:42',
    sourceEpoch: 'synthetic-epoch',
    sourceSequence: id,
    mediaObjectId: id,
    initObjectId: 'synthetic-init',
    wallStartMs: start,
    wallEndMs: end,
    durationSeconds: (end - start) / 1000,
    timeBasis: 'source-pdt',
    uncertaintyMs: null,
    discontinuity: false,
    ...patch,
  };
}
function fixture(segments: Segment[]) {
  const available = new Set(
    segments.flatMap((row) => [row.mediaObjectId, ...(row.initObjectId ? [row.initObjectId] : [])]),
  );
  const archive = {
    async getSubject(id: string) {
      return (await this.listSubjects()).find((row) => row.id === id) ?? null;
    },

    listSubjects: async (): Promise<Subject[]> => [
      {
        id: 'stripchat:42',
        providerId: 42,
        handle: 'Synthetic',
        monitorEnabled: true,
        autoRecord: false,
        providerStatus: 'PUBLIC',
        observedAtMs: 1,
      },
    ],
    locate: vi.fn(async (id: string, at: number, policy: string) => {
      expect(id).toBe('stripchat:42');
      return (
        segments.find(
          (row) =>
            row.wallStartMs !== null &&
            row.wallEndMs !== null &&
            at >= row.wallStartMs &&
            at < row.wallEndMs,
        ) ??
        (policy === 'next'
          ? segments
              .filter((row) => row.wallStartMs !== null && row.wallStartMs >= at)
              .sort((a, b) => a.wallStartMs! - b.wallStartMs!)[0]
          : null) ??
        null
      );
    }),
    timeline: vi.fn(),
    snapshotPages: vi.fn<(...args: unknown[]) => Promise<SnapshotPagesResponse>>(),
    hasMedia: async (ids: string[]) => ids.every((id) => available.has(id)),
    media: async (id: string) =>
      available.has(id) ? { path: `/synthetic/${id}`, bytes: 8, contentType: 'video/mp4' } : null,
  };
  const decoder = vi.fn<(input: DecodeInput) => Promise<Buffer>>(async () => image);
  return {
    archive,
    decoder,
    available,
    open: (
      options: {
        cacheBytes?: number;
        fetch?: typeof globalThis.fetch;
        now?: () => number;
        timeoutMs?: number;
      } = {},
    ) => {
      const previews = createPreviews({ archive, decoder, ...options });
      cleanups.push(previews);
      return previews;
    },
  };
}
describe('bounded anonymous covers and recorded unit snapshots', () => {
  it('lists broadcast pages using metadata without fragment reads or decoding', async () => {
    const f = fixture([]),
      pages = {
        subjectId: 'stripchat:42',
        session: null,
        deletionRevision: 1,
        total: 0,
        page: 1,
        pages: 0,
        occupiedPages: [],
        limit: 30,
        items: [],
      };
    const snapshotPages = vi.fn(async () => pages);
    const media = vi.spyOn(f.archive, 'media');
    const previews = createPreviews({
      archive: { ...f.archive, snapshotPages },
      decoder: f.decoder,
    });
    cleanups.push(previews);
    expect(
      await previews.snapshotPages!('stripchat:42', 1000, 1, 30, undefined, {
        fromMs: 0,
        toMs: 60000,
      }),
    ).toEqual(pages);
    expect(snapshotPages).toHaveBeenCalledWith(
      'stripchat:42',
      1000,
      1,
      30,
      {
        fromMs: 0,
        toMs: 60000,
      },
      undefined,
      expect.any(AbortSignal),
      undefined,
    );
    const unitId = '00000000-0000-4000-8000-000000000042';
    expect(
      await previews.snapshotPages!(
        'stripchat:42',
        1000,
        1,
        30,
        undefined,
        { fromMs: 0, toMs: 60000 },
        false,
        unitId,
      ),
    ).toEqual(pages);
    expect(snapshotPages).toHaveBeenLastCalledWith(
      'stripchat:42',
      1000,
      1,
      30,
      { fromMs: 0, toMs: 60000 },
      false,
      expect.any(AbortSignal),
      unitId,
    );
    expect(media).not.toHaveBeenCalled();
    expect(f.decoder).not.toHaveBeenCalled();
    expect(f.archive.locate).not.toHaveBeenCalled();
    expect(f.archive.timeline).not.toHaveBeenCalled();
  });
  it('lists a partial unit using authoritative metadata without decoding or rebasing its boundary', async () => {
    const f = fixture([segment('partial', 70100, 71500)]),
      previews = f.open();
    const items = [
      {
        unitId: 'partial',
        open: false,
        atMs: 70100,
        slotFromMs: 70100,
        slotToMs: 71500,
        url: '/partial.jpg',
        timeBasis: 'source-pdt',
        uncertaintyMs: null,
      },
    ] as SnapshotItem[];
    f.archive.snapshotPages.mockResolvedValue({
      subjectId: 'stripchat:42',
      session: null,
      deletionRevision: 0,
      total: 1,
      page: 1,
      pages: 1,
      occupiedPages: [1],
      limit: 100000,
      items,
    });
    const result = await previews.snapshotPages!('stripchat:42', 60000, 1, 30, undefined, {
      fromMs: 60000,
      toMs: 120000,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toBe(items[0]);
    expect(f.archive.locate).not.toHaveBeenCalled();
    expect(f.decoder).not.toHaveBeenCalled();
  });
  it('uses the public photographic preview saved during list sync before falling back to a square avatar', async () => {
    const f = fixture([]),
      url = 'https://static-proxy.strpst.com/photos/synthetic',
      requests: string[] = [];
    const previews = createPreviews({
      archive: { ...f.archive, subjectPreview: () => Promise.resolve(url) },
      decoder: f.decoder,
      fetch: async (input, init) => {
        const address = addressOf(input);
        requests.push(address);
        expect(new Headers(init?.headers).has('cookie')).toBe(false);
        return address.includes('/broadcasts/')
          ? Response.json({ item: { status: 'off', isLive: false } })
          : new Response(image);
      },
    });
    cleanups.push(previews);
    expect([...(await previews.cover('stripchat:42'))]).toEqual([...image]);
    expect(requests).toEqual([url]);
  });
  it('uses only fixed anonymous status/snapshot URLs and a short controlled cover cache', async () => {
    const f = fixture([]),
      requests: string[] = [];
    const fetch = vi.fn(async (address: URL | string | Request, init?: RequestInit) => {
      const url = addressOf(address);
      requests.push(url);
      expect(init?.credentials).toBe('omit');
      const headers = new Headers(init?.headers);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
      return url.includes('/broadcasts/')
        ? Response.json({ item: { status: 'public', isLive: true, snapshotTimestamp: 123 } })
        : new Response(image);
    });
    const previews = f.open({ fetch });
    expect([...(await previews.cover('stripchat:42'))]).toEqual([...image]);
    expect([...(await previews.cover('stripchat:42'))]).toEqual([...image]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      'https://stripchat.com/api/front/v2/broadcasts/42',
      'https://img.doppiocdn.org/snapshot/42/123',
    ]);
    await expect(previews.cover('stripchat:99')).rejects.toMatchObject({
      code: 'preview_not_found',
    });
  });
  it('serves public covers for private/offline states and never follows an arbitrary-host redirect', async () => {
    for (const item of [
      { status: 'private', isLive: true, snapshotTimestamp: 123 },
      { status: 'groupShow', isLive: true, snapshotTimestamp: 123 },
    ]) {
      const f = fixture([]),
        fetch = vi.fn(async (address: URL | string | Request) =>
          addressOf(address).includes('/broadcasts/')
            ? Response.json({ item })
            : new Response(image),
        ),
        previews = f.open({ fetch });
      expect([...(await previews.cover('stripchat:42'))]).toEqual([...image]);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    for (const host of ['arbitrary.invalid', 'stripchat.com']) {
      const f = fixture([]),
        fetch = vi.fn(async (address: URL | string | Request) =>
          addressOf(address).includes('/broadcasts/')
            ? Response.json({ item: { status: 'public', isLive: true, snapshotTimestamp: 123 } })
            : new Response(null, { status: 302, headers: { location: `https://${host}/image` } }),
        );
      await expect(f.open({ fetch }).cover('stripchat:42')).rejects.toMatchObject({
        code: 'preview_not_found',
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it('does not replace an unavailable photographic cover with the unrelated square avatar', async () => {
    for (const avatarUrl of [
      'https://static-proxy.strpst.com/avatars/synthetic',
      'https://127.0.0.1/private',
    ]) {
      const f = fixture([]),
        urls: string[] = [],
        fetch = vi.fn(async (address: URL | string | Request, init?: RequestInit) => {
          const url = addressOf(address);
          urls.push(url);
          expect(new Headers(init?.headers).has('cookie')).toBe(false);
          expect(new Headers(init?.headers).has('authorization')).toBe(false);
          if (url.includes('/broadcasts/'))
            return Response.json({ item: { status: 'off', isLive: false, snapshotTimestamp: 0 } });
          if (url === 'https://stripchat.com/api/front/models/42')
            return Response.json({ avatarUrl });
          return new Response(image);
        });
      const previews = f.open({ fetch });
      await expect(previews.cover('stripchat:42')).rejects.toMatchObject({
        code: 'preview_not_found',
      });
      expect(urls).toEqual(['https://stripchat.com/api/front/v2/broadcasts/42']);
    }
  });
  it('accepts actual WebP and PNG signatures even under an inaccurate upstream MIME, expires cached covers and rejects text', async () => {
    // These synthetic bytes exercise format dispatch; no upstream media fixture.
    const webp = Buffer.from('5249464610000000574542505650384c0400000000000000', 'hex'),
      png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
        'base64',
      );
    for (const imageBytes of [webp, png]) {
      const f = fixture([]);
      let now = 1000;
      const fetch = vi.fn(async (address: URL | string | Request) =>
        addressOf(address).includes('/broadcasts/')
          ? Response.json({ item: { status: 'public', isLive: true, snapshotTimestamp: 123 } })
          : new Response(imageBytes, { headers: { 'content-type': 'application/octet-stream' } }),
      );
      const previews = f.open({ fetch, now: () => now });
      expect([...(await previews.cover('stripchat:42'))]).toEqual([...imageBytes]);
      now += 14999;
      await previews.cover('stripchat:42');
      expect(fetch).toHaveBeenCalledTimes(2);
      now += 2;
      await previews.cover('stripchat:42');
      expect(fetch).toHaveBeenCalledTimes(4);
    }
    const f = fixture([]),
      fetch = vi.fn(async (address: URL | string | Request) =>
        addressOf(address).includes('/broadcasts/')
          ? Response.json({ item: { status: 'public', isLive: true, snapshotTimestamp: 123 } })
          : new Response('<html>not an image</html>', {
              headers: { 'content-type': 'image/webp' },
            }),
      );
    await expect(f.open({ fetch }).cover('stripchat:42')).rejects.toMatchObject({
      code: 'preview_not_found',
    });
  });
  it('keeps two anonymous network workers, bounds the queue, and removes a cancelled cover waiter', async () => {
    const f = fixture([]);
    let release: (() => void) | undefined,
      active = 0,
      maximum = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (address: URL | string | Request) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (addressOf(address).includes('/broadcasts/')) {
          await gate;
          return Response.json({
            item: { status: 'public', isLive: true, snapshotTimestamp: 123 },
          });
        }
        return new Response(image);
      } finally {
        active--;
      }
    });
    const previews = f.open({ fetch }),
      controller = new AbortController();
    const requests = Array.from({ length: 23 }, () => previews.cover('stripchat:42'));
    const cancelled = previews.cover('stripchat:42', controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ code: 'preview_cancelled' });
    try {
      await tick();
      expect(maximum).toBe(2);
      await expect(previews.cover('stripchat:42')).rejects.toMatchObject({ code: 'preview_busy' });
      controller.abort();
      await rejected;
      release?.();
      await Promise.all(requests);
      expect(maximum).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect([...(await previews.cover('stripchat:42'))]).toEqual([...image]);
    } finally {
      release?.();
      await Promise.allSettled(requests);
    }
  });
  it('admits configured cover workers without letting their queue block metadata reads', async () => {
    const f = fixture([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0,
      maximum = 0;
    const fetch = vi.fn(async (address: URL | string | Request) => {
      if (!addressOf(address).includes('/broadcasts/')) return new Response(image);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await gate;
        return Response.json({ item: { status: 'public', isLive: true, snapshotTimestamp: 123 } });
      } finally {
        active--;
      }
    });
    const previews = createPreviews({
      archive: { ...f.archive, snapshotUnit: async () => null },
      decoder: f.decoder,
      fetch,
      networkConcurrency: 32,
      readConcurrency: 16,
    });
    cleanups.push(previews);
    const requests = Array.from({ length: 32 }, () => previews.cover('stripchat:42'));
    const completion = Promise.allSettled(requests);
    try {
      await expect(previews.snapshotPoint('stripchat:42', 0)).resolves.toBeNull();
      await vi.waitFor(() => expect(maximum).toBe(32));
    } finally {
      release();
      await completion;
    }
    expect((await completion).every((result) => result.status === 'fulfilled')).toBe(true);
  });
  it('lists one image for each unit rather than duplicating a fragment across natural minutes', async () => {
    const f = fixture([segment('before', 59000, 61000), segment('after-gap', 120001, 122000)]),
      previews = f.open();
    const items = [
      {
        unitId: 'before',
        open: false,
        atMs: 59000,
        slotFromMs: 59000,
        slotToMs: 61000,
        url: '/before.jpg',
        timeBasis: 'source-pdt',
        uncertaintyMs: null,
      },
      {
        unitId: 'after-gap',
        open: true,
        atMs: 120001,
        slotFromMs: 120001,
        slotToMs: 122000,
        url: '/after.jpg',
        timeBasis: 'source-pdt',
        uncertaintyMs: null,
      },
    ] as SnapshotItem[];
    f.archive.snapshotPages.mockResolvedValue({
      subjectId: 'stripchat:42',
      session: null,
      deletionRevision: 0,
      total: 2,
      page: 1,
      pages: 1,
      occupiedPages: [1],
      limit: 100000,
      items,
    });
    const result = await previews.snapshotPages!('stripchat:42', 0, 1, 30, undefined, {
      fromMs: 0,
      toMs: 180000,
    });
    expect(result.items).toEqual(items);
    await expect(previews.snapshot('stripchat:42', 120000)).rejects.toMatchObject({
      code: 'preview_not_found',
    });
    expect(f.decoder).not.toHaveBeenCalled();
  });
  it('uses past-only continuous preroll and preserves the requested relative instant', async () => {
    const f = fixture([
        segment('a', 55000, 57000),
        segment('b', 57000, 59000),
        segment('c', 59000, 62000),
      ]),
      previews = f.open();
    expect(await previews.snapshot('stripchat:42', 60000)).toEqual(image);
    const { signal, ...request } = f.decoder.mock.calls[0][0];
    expect(request).toEqual({
      paths: ['/synthetic/synthetic-init', '/synthetic/a', '/synthetic/b', '/synthetic/c'],
      offsetSeconds: 5,
      endSeconds: 5.5,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    await previews.snapshot('stripchat:42', 60000);
    expect(f.decoder).toHaveBeenCalledOnce();
    f.available.delete('c');
    await expect(previews.snapshot('stripchat:42', 60000)).rejects.toMatchObject({
      code: 'preview_not_found',
    });
    expect(f.decoder).toHaveBeenCalledOnce();
  });
  it('reads canonical unit metadata once per request while retaining source deletion validation', async () => {
    const row = segment('single', 1000, 2000),
      f = fixture([row]);
    const snapshotUnit = vi.fn(async () => ({
      unitId: 'single',
      open: false,
      atMs: 1000,
      slotFromMs: 1000,
      slotToMs: 2000,
      url: '/single.jpg',
      timeBasis: 'source-pdt' as const,
      uncertaintyMs: null,
    }));
    const previews = createPreviews({
      archive: { ...f.archive, snapshotUnit },
      decoder: f.decoder,
    });
    cleanups.push(previews);
    await previews.snapshot('stripchat:42', 1000, undefined, 2000, 'single');
    expect(snapshotUnit).toHaveBeenCalledOnce();
    await previews.snapshot('stripchat:42', 1000, undefined, 2000, 'single');
    expect(snapshotUnit).toHaveBeenCalledTimes(2);
    expect(f.decoder).toHaveBeenCalledOnce();
    f.available.delete(row.mediaObjectId);
    await expect(
      previews.snapshot('stripchat:42', 1000, undefined, 2000, 'single'),
    ).rejects.toMatchObject({ code: 'preview_not_found' });
    expect(snapshotUnit).toHaveBeenCalledTimes(3);
    expect(f.decoder).toHaveBeenCalledOnce();
  });
  it('does not read the rest of a minute before decoding its first available frame', async () => {
    const f = fixture(
      Array.from({ length: 30 }, (_, i) => segment(`part-${i}`, i * 2000, (i + 1) * 2000)),
    );
    await f.open().snapshot('stripchat:42', 0, undefined, 60000);
    expect(f.decoder.mock.calls[0][0].paths.length).toBeLessThanOrEqual(3);
    expect(f.decoder.mock.calls[0][0].endSeconds).toBeLessThanOrEqual(4);
  });
  it('includes more than six short fragments within the preroll window', async () => {
    const f = fixture(
        Array.from({ length: 12 }, (_, i) => segment(String(i), i * 1000, (i + 1) * 1000)),
      ),
      previews = f.open();
    await previews.snapshot('stripchat:42', 10500);
    expect(f.decoder.mock.calls[0][0].paths).toHaveLength(12);
    expect(f.decoder.mock.calls[0][0].offsetSeconds).toBe(10.5);
  });
  it('tries a later continuous island if the first has no decodable frame', async () => {
    const f = fixture([segment('first', 1000, 2000), segment('second', 3000, 4000)]),
      previews = f.open();
    f.decoder.mockRejectedValueOnce(new SnapshotDecodeError('no_frame'));
    expect(await previews.snapshot('stripchat:42', 1000, undefined, 5000)).toEqual(image);
    expect(f.decoder).toHaveBeenCalledTimes(2);
    expect(f.decoder.mock.calls[1][0].paths).toEqual([
      '/synthetic/synthetic-init',
      '/synthetic/second',
    ]);
  });
  it('briefly caches confirmed empty windows but retries when their media changes', async () => {
    let now = 1000;
    const segments = [segment('first', 1000, 2000)],
      f = fixture(segments),
      previews = f.open({ now: () => now });
    f.decoder.mockRejectedValue(new SnapshotDecodeError('no_frame'));
    await expect(previews.snapshot('stripchat:42', 1000, undefined, 5000)).rejects.toMatchObject({
      code: 'preview_not_found',
    });
    await expect(previews.snapshot('stripchat:42', 1000, undefined, 5000)).rejects.toMatchObject({
      code: 'preview_not_found',
    });
    expect(f.decoder).toHaveBeenCalledTimes(1);
    segments.push(segment('second', 2000, 3000));
    f.available.add('second');
    await expect(previews.snapshot('stripchat:42', 1000, undefined, 5000)).rejects.toMatchObject({
      code: 'preview_not_found',
    });
    expect(f.decoder).toHaveBeenCalledTimes(2);
    now += 30001;
    await expect(previews.snapshot('stripchat:42', 1000, undefined, 5000)).rejects.toMatchObject({
      code: 'preview_not_found',
    });
    expect(f.decoder).toHaveBeenCalledTimes(3);
  });
  it('reports an unavailable decoder executable instead of treating covered media as absent', async () => {
    const f = fixture([segment('first', 1000, 2000)]);
    const previews = createPreviews({
      archive: f.archive,
      ffmpegPath: 'synthetic-missing-ffmpeg-binary',
    });
    cleanups.push(previews);
    await expect(previews.snapshot('stripchat:42', 1000)).rejects.toMatchObject({
      code: 'preview_unavailable',
    });
  });
  it('never crosses a gap, epoch, initialization or discontinuity boundary for preroll', async () => {
    for (const [previous, current] of [
      [segment('a', 57000, 58999), segment('b', 59000, 62000)],
      [segment('a', 57000, 59000, { sourceEpoch: 'older' }), segment('b', 59000, 62000)],
      [segment('a', 57000, 59000, { initObjectId: 'other-init' }), segment('b', 59000, 62000)],
      [segment('a', 57000, 59000), segment('b', 59000, 62000, { discontinuity: true })],
    ]) {
      const f = fixture([previous, current]),
        previews = f.open();
      await previews.snapshot('stripchat:42', 60000);
      expect(f.decoder.mock.calls[0][0].paths).toEqual([
        '/synthetic/synthetic-init',
        '/synthetic/b',
      ]);
      expect(f.decoder.mock.calls[0][0].offsetSeconds).toBe(1);
    }
  });
  it('bounds the cache and revalidates a deleted target even after decode started', async () => {
    const f = fixture([segment('long', 0, 180000)]),
      previews = f.open({ cacheBytes: 8 });
    for (const at of [0, 60000, 120000, 0]) await previews.snapshot('stripchat:42', at);
    expect(f.decoder).toHaveBeenCalledTimes(4);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.decoder.mockImplementationOnce(async () => {
      await gate;
      return image;
    });
    const pending = previews.snapshot('stripchat:42', 60000);
    await tick();
    f.available.delete('long');
    release?.();
    await expect(pending).rejects.toMatchObject({ code: 'preview_not_found' });
  });
  it('limits actual decoders to one, cancels queued work, and drains an ignored active abort', async () => {
    const f = fixture([segment('long', 0, 180000)]),
      previews = f.open();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.decoder.mockImplementationOnce(async () => {
      await gate;
      return image;
    });
    const activeAbort = new AbortController(),
      first = previews.snapshot('stripchat:42', 0, activeAbort.signal);
    void first.catch(() => undefined);
    await tick();
    const queuedAbort = new AbortController(),
      queued = previews.snapshot('stripchat:42', 60000, queuedAbort.signal);
    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ code: 'preview_cancelled' });
    expect(f.decoder).toHaveBeenCalledOnce();
    activeAbort.abort();
    await expect(first).rejects.toMatchObject({ code: 'preview_cancelled' });
    const third = previews.snapshot('stripchat:42', 120000);
    void third.catch(() => undefined);
    await tick();
    expect(f.decoder).toHaveBeenCalledOnce();
    let drained = false;
    const closing = previews.close();
    void closing.then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(false);
    release?.();
    await closing;
    await expect(third).rejects.toMatchObject({ code: 'preview_unavailable' });
    expect(f.decoder).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });
  it('starts the execution timeout only after a queued decoder acquires the slot', async () => {
    const f = fixture([segment('long', 0, 180000)]),
      previews = f.open({ timeoutMs: 30 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.decoder.mockImplementationOnce(async () => {
      await gate;
      return image;
    });
    const first = previews.snapshot('stripchat:42', 0);
    const firstResult = expect(first).rejects.toMatchObject({ code: 'preview_unavailable' });
    await tick();
    const queued = previews.snapshot('stripchat:42', 60000);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await firstResult;
    expect(f.decoder).toHaveBeenCalledOnce();
    release?.();
    expect(await queued).toEqual(image);
    expect(f.decoder).toHaveBeenCalledTimes(2);
  });
});
