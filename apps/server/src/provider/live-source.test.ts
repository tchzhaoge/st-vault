/* eslint-disable @typescript-eslint/require-await -- Synthetic asynchronous ports. */
import { describe, expect, it, vi } from 'vitest';
import { createLiveSource } from './live-source.js';
import { createHttp } from './http.js';

const edges = ['slow.invalid', 'healthy.invalid', 'third.invalid', 'fourth.invalid'];
const master =
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160\nhigh.m3u8\n';
const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment.mp4\n';
const urlOf = (input: Parameters<typeof fetch>[0]): URL =>
  new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const tick = async (): Promise<void> => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};

describe('bounded competing CDN source resolution', () => {
  it('applies the media deadline supplied by the live producer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const source = createLiveSource({
      allowedMediaHosts: ['edge.invalid'],
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    const pending = source.bytes('https://edge.invalid/segment.mp4', 1024, controller.signal, 1500);
    const outcome = pending.catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(1501);
      expect(requestSignal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ code: 'request-deadline' });
    } finally {
      controller.abort();
      await outcome;
      vi.useRealTimers();
    }
  });
  it('pins a manual CDN and reads updated preference on the next resolution', async () => {
    let manual: string | null = edges[1];
    const hosts: string[] = [];
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      preferredCdn: () => manual,
      fetch: (input) => {
        const url = urlOf(input);
        hosts.push(url.hostname);
        return Promise.resolve(
          new Response(url.pathname.includes('_auto.m3u8') ? master : playlist),
        );
      },
    });
    await source.resolve(42, new AbortController().signal);
    expect(new Set(hosts)).toEqual(new Set([edges[1]]));
    hosts.length = 0;
    manual = edges[2];
    await source.resolve(42, new AbortController().signal);
    expect(new Set(hosts)).toEqual(new Set([edges[2]]));
    manual = 'attacker.invalid';
    await expect(source.resolve(42, new AbortController().signal)).rejects.toMatchObject({
      code: 'upstream-url-denied',
    });
  });
  it('prepares a captured route choice without announcing it as active', async () => {
    const selected = vi.fn(),
      hosts: string[] = [];
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      preferredCdn: () => edges[0],
      onCdnSelected: selected,
      fetch: async (input) => {
        const url = urlOf(input);
        hosts.push(url.hostname);
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    const prepared = await source.resolve(42, new AbortController().signal, undefined, {
      preferredCdn: edges[1],
      announce: false,
    });
    expect(prepared.edge).toBe(edges[1]);
    expect(new Set(hosts)).toEqual(new Set([edges[1]]));
    expect(selected).not.toHaveBeenCalled();
  });

  it('invalidates a failed preferred CDN and remembers the replacement', async () => {
    const requests: string[] = [];
    let failed = false;
    const source = createLiveSource({
      hlsEdges: edges.slice(0, 2),
      allowedMediaHosts: edges,
      fetch: async (input) => {
        const url = urlOf(input);
        requests.push(url.hostname);
        if (url.hostname === edges[0] && failed) return new Response('', { status: 503 });
        if (url.hostname === edges[1] && !failed) return new Response('', { status: 503 });
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    const first = await source.resolve(42, new AbortController().signal);
    failed = true;
    await source.resolve(42, new AbortController().signal, first.url);
    requests.length = 0;
    await source.resolve(42, new AbortController().signal);
    expect(new Set(requests)).toEqual(new Set([edges[1]]));
  });
  it('reuses the successful CDN preference without repeating a full race on the next session', async () => {
    const requests: string[] = [];
    const source = createLiveSource({
      hlsEdges: edges.slice(0, 2),
      allowedMediaHosts: edges,
      fetch: async (input) => {
        const url = urlOf(input);
        requests.push(url.hostname);
        if (url.hostname === edges[0]) return new Response('', { status: 503 });
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    await source.resolve(42, new AbortController().signal);
    requests.length = 0;
    await source.resolve(42, new AbortController().signal);
    expect(new Set(requests)).toEqual(new Set([edges[1]]));
  });
  it('propagates bounded upstream Retry-After rather than retrying through a requested cooldown', async () => {
    const client = createHttp({
      allow: () => true,
      fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    });
    await expect(client.bytes('https://edge.invalid/segment.mp4')).rejects.toMatchObject({
      code: 'upstream-http',
      status: 429,
      retryAfterMs: 30000,
    });
  });
  it('tries other CDN families first after media from the previous host expires', async () => {
    const requests: string[] = [];
    const source = createLiveSource({
      hlsEdges: ['edge-hls.doppiocdn.net', 'edge-hls.doppiocdn.org'],
      fetch: async (input) => {
        const url = urlOf(input);
        requests.push(url.hostname);
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    await source.resolve(
      42,
      new AbortController().signal,
      'https://media-hls.doppiocdn.net/main.m3u8',
    );
    expect(requests[0]).toBe('edge-hls.doppiocdn.org');
  });
  it('keeps an aborted fragment request owned until the actual transport settles', async () => {
    let release!: (response: Response) => void,
      settled = false;
    const controller = new AbortController();
    const source = createLiveSource({
      allowedMediaHosts: ['edge.invalid'],
      fetch: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const work = source.bytes('https://edge.invalid/segment.mp4', 1024, controller.signal);
    void work
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    try {
      await tick();
      controller.abort();
      await tick();
      expect(settled).toBe(false);
      release(new Response(new Uint8Array(8), { headers: { 'content-type': 'video/mp4' } }));
      await expect(work).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      controller.abort();
      release?.(new Response(''));
      await Promise.allSettled([work]);
    }
  });
  it('uses the healthy second CDN without waiting for a slow first CDN and keeps highest quality', async () => {
    const requests: string[] = [],
      controller = new AbortController();
    let slowAborted = false;
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      fetch: async (input, init) => {
        const url = urlOf(input);
        requests.push(url.href);
        if (url.hostname === edges[0])
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                slowAborted = true;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    const opening = source.resolve(42, controller.signal);
    void opening.catch(() => undefined);
    try {
      await vi.waitFor(() =>
        expect(requests.some((url) => url.includes('healthy.invalid'))).toBe(true),
      );
      expect((await opening).quality.height).toBe(2160);
      expect(slowAborted).toBe(true);
      expect(requests.some((url) => url.includes('low.m3u8'))).toBe(false);
      expect(requests.some((url) => url.includes('third.invalid'))).toBe(false);
    } finally {
      controller.abort();
      await Promise.allSettled([opening]);
    }
  });
  it('aborts a losing CDN and waits for its actual fetch to settle before returning the winner', async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void,
      losingSignal: AbortSignal | null | undefined,
      settled = false;
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      fetch: async (input, init) => {
        const url = urlOf(input);
        if (url.hostname === edges[0]) {
          losingSignal = init?.signal;
          return await new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    const opening = source.resolve(42, controller.signal);
    void opening.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(losingSignal?.aborted).toBe(true));
      await tick();
      expect(settled).toBe(false);
      release(new Response(master));
      expect((await opening).url).toContain('healthy.invalid');
    } finally {
      controller.abort();
      release?.(new Response(master));
      await Promise.allSettled([opening]);
    }
  });
  it('bounds all-failed CDN attempts to two active requests and reports source unavailability', async () => {
    let active = 0,
      peak = 0;
    const requests: string[] = [];
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      fetch: async (input) => {
        requests.push(urlOf(input).hostname);
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        return new Response('', { status: 503 });
      },
    });
    await expect(source.resolve(42, new AbortController().signal)).rejects.toMatchObject({
      code: 'live-source-unavailable',
    });
    expect(requests).toEqual(edges);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
  it('cancels both active candidates, drains ignored cancellation and starts no queued CDN', async () => {
    const controller = new AbortController(),
      releases: ((response: Response) => void)[] = [],
      signals: (AbortSignal | null | undefined)[] = [];
    let settled = false;
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      fetch: async (_input, init) => {
        signals.push(init?.signal);
        return await new Promise<Response>((resolve) => {
          releases.push(resolve);
        });
      },
    });
    const opening = source.resolve(42, controller.signal);
    void opening.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      controller.abort();
      await tick();
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
      expect(settled).toBe(false);
      for (const release of releases) release(new Response(master));
      await expect(opening).rejects.toMatchObject({ code: 'cancelled' });
      expect(releases).toHaveLength(2);
    } finally {
      controller.abort();
      for (const release of releases) release(new Response(master));
      await Promise.allSettled([opening]);
    }
  });
  it('always selects the highest available quality within each competing CDN', async () => {
    const requests: string[] = [];
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      fetch: async (input) => {
        const url = urlOf(input);
        requests.push(url.href);
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    expect((await source.resolve(42, new AbortController().signal)).quality.height).toBe(2160);
    expect(requests.some((url) => url.includes('high.m3u8'))).toBe(true);
  });
  it('cancels pending injected key lookups without starting more CDN candidates', async () => {
    const controller = new AbortController();
    const keyLookup = vi.fn(() => new Promise<string>(() => undefined)),
      requests: string[] = [];
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      keyLookup,
      fetch: async (input) => {
        requests.push(urlOf(input).hostname);
        return new Response('#EXTM3U\n#EXT-X-MOUFLON:PSCH:info:1:wanted\n' + master.slice(8));
      },
    });
    const opening = source.resolve(42, controller.signal);
    void opening.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(keyLookup).toHaveBeenCalledTimes(2));
      controller.abort();
      await expect(opening).rejects.toMatchObject({ code: 'cancelled' });
      expect(requests).toEqual(edges.slice(0, 2));
    } finally {
      controller.abort();
      await Promise.allSettled([opening]);
    }
  });
  it('reports parent cancellation even if a winner already exists while a loser drains', async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void, losingSignal: AbortSignal | null | undefined;
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      fetch: async (input, init) => {
        const url = urlOf(input);
        if (url.hostname === edges[0]) {
          losingSignal = init?.signal;
          return await new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
      },
    });
    const opening = source.resolve(42, controller.signal);
    void opening.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(losingSignal?.aborted).toBe(true));
      controller.abort();
      release(new Response(master));
      await expect(opening).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      controller.abort();
      release?.(new Response(master));
      await Promise.allSettled([opening]);
    }
  });
  it('keeps timed out variant fetches in their slot before trying a lower rendition', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(),
      releases: ((response: Response) => void)[] = [],
      requests: string[] = [];
    let active = 0,
      peak = 0;
    const source = createLiveSource({
      hlsEdges: edges,
      allowedMediaHosts: edges,
      fetch: async (input) => {
        const url = urlOf(input);
        requests.push(url.href);
        if (url.hostname === edges[0] && url.pathname.includes('_auto.m3u8'))
          return new Response(master);
        active++;
        peak = Math.max(peak, active);
        return await new Promise<Response>((resolve) => {
          releases.push((response) => {
            active--;
            resolve(response);
          });
        });
      },
    });
    const opening = source.resolve(42, controller.signal);
    void opening.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(10001);
      expect(requests.some((url) => url.includes('low.m3u8'))).toBe(false);
      expect(requests.some((url) => url.includes('third.invalid'))).toBe(false);
      expect(peak).toBe(2);
    } finally {
      controller.abort();
      for (const release of releases) release(new Response(playlist));
      await Promise.allSettled([opening]);
      vi.useRealTimers();
    }
  });
});

it('uses only the chosen CDN even if another can respond faster', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const source = createLiveSource({
    hlsEdges: edges,
    allowedMediaHosts: edges,
    preferredCdn: () => edges[0],
    fetch: async (input) => {
      const url = urlOf(input);
      calls.push(url.hostname);
      if (url.hostname === edges[0]) await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(url.pathname.includes('_auto.m3u8') ? master : playlist);
    },
  });
  try {
    const opening = source.resolve(42, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(150);
    expect((await opening).url).toContain(edges[0]);
    expect(calls.every((host) => host === edges[0])).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
