import { expect, it, vi } from 'vitest';
import { accountSiteOrigin, SiteRoutes } from './site-routes.js';
import { ProviderError } from './http.js';
const origins = ['https://one.invalid', 'https://two.invalid'];
const decode = (text: string): { value: number } => JSON.parse(text) as { value: number };
it('retains a real non-JSON API failure and clears it after a valid subsequent response', async () => {
  let invalid = true;
  const routes = new SiteRoutes({
    origins,
    fetch: () =>
      Promise.resolve(invalid ? new Response('<html>blocked</html>') : Response.json({ value: 1 })),
  });
  try {
    await expect(routes.read('/api/front/test', decode)).rejects.toMatchObject({
      code: 'invalid-upstream-json',
    });
    expect(routes.status().access?.error).toBe('invalid-upstream-json');
    invalid = false;
    await routes.read('/api/front/test', decode);
    expect(routes.status().access?.error).toBeNull();
  } finally {
    routes.close();
  }
});
it('recovers from an earlier concurrent failure using a newer successful request', async () => {
  let fail!: (error: Error) => void, succeed!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          succeed = resolve;
        }),
    );
  const routes = new SiteRoutes({ origins, fetch });
  try {
    const first = routes.read('/api/front/old', decode);
    const rejected = expect(first).rejects.toMatchObject({ code: 'upstream-request' });
    const second = routes.read('/api/front/new', decode);
    fail(new TypeError('offline'));
    await rejected;
    succeed(Response.json({ value: 1 }));
    await second;
    expect(routes.status().access?.error).toBeNull();
  } finally {
    routes.close();
  }
});
it('does not poison site connectivity with a valid JSON business response', async () => {
  const routes = new SiteRoutes({
    origins,
    fetch: () => Promise.resolve(Response.json({ item: { modelId: 999 } })),
  });
  try {
    await expect(
      routes.read('/api/front/model', () => {
        throw new ProviderError('upstream-identity-mismatch');
      }),
    ).rejects.toMatchObject({ code: 'upstream-identity-mismatch' });
    expect(routes.status().access).toMatchObject({ error: null });
    expect(routes.status().candidates[0].failures).toBe(0);
  } finally {
    routes.close();
  }
});
it('uses authenticated reachability evidence without transferring cookies or changing the binding', async () => {
  const routes = new SiteRoutes({ origins, fetch: () => Promise.reject(new TypeError('offline')) });
  try {
    await expect(routes.read('/api/front/test', decode)).rejects.toMatchObject({
      code: 'upstream-request',
    });
    routes.beginAccess(origins[0])();
    expect(routes.status().access?.error).toBeNull();
    routes.beginAccess(origins[1])(new ProviderError('request-deadline'));
    expect(routes.status().access?.error).toBeNull();
    routes.beginAccess(origins[0])(new ProviderError('upstream-http', 403, false, undefined, true));
    expect(routes.status().access?.error).toBe('upstream-challenge:403');
    routes.beginAccess(origins[0])(new ProviderError('cancelled'));
    expect(routes.status().access?.error).toBe('upstream-challenge:403');
    routes.beginAccess(origins[0])(new ProviderError('upstream-http', 401));
    expect(routes.status().access?.error).toBeNull();
    routes.beginAccess(origins[0])(new ProviderError('upstream-http', 403));
    expect(routes.status().access?.error).toBeNull();
  } finally {
    routes.close();
  }
});
it('only measures explicitly, reports incremental progress, and never selects the fastest host', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn((input) =>
    String(input).startsWith(origins[0])
      ? Promise.resolve(Response.json({ initialDynamic: {} }))
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  const routes = new SiteRoutes({ origins, fetch });
  try {
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    routes.configure(origins[0]);
    const measuring = routes.probe();
    await vi.waitFor(() =>
      expect(routes.status().probeProgress).toEqual({ completed: 1, total: 2, failed: 0 }),
    );
    expect(routes.status().probing).toBe(true);
    expect(routes.status()).not.toHaveProperty('probeTrigger');
    finish(Response.json({ initialDynamic: {} }));
    await measuring;
    expect(routes.status().probeProgress).toEqual({ completed: 2, total: 2, failed: 0 });
    expect(routes.status().selectedOrigin).toBe(origins[0]);
    expect(routes.status()).not.toHaveProperty('nextProbeAtMs');
  } finally {
    routes.close();
  }
});
it('pins every anonymous request and retries the same host after transport failures without credentials', async () => {
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    calls.push(
      new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        .origin,
    );
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.credentials).toBe('omit');
    return Promise.reject(new TypeError('offline'));
  });
  const routes = new SiteRoutes({ origins, fetch });
  try {
    routes.configure(origins[1]);
    for (let index = 0; index < 2; index++)
      await expect(routes.read('/api/front/test', decode)).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toEqual([origins[1], origins[1]]);
    expect(routes.status().selectedOrigin).toBe(origins[1]);
    expect(() => routes.configure('https://unreviewed.invalid')).toThrow('INVALID_SITE_ORIGIN');
  } finally {
    routes.close();
  }
});
it('does not erase a newer failure with a late successful response', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValue(new TypeError('offline'));
  const routes = new SiteRoutes({ origins, fetch });
  try {
    const older = routes.read('/api/front/test', decode);
    await expect(routes.read('/api/front/test', decode)).rejects.toMatchObject({
      code: 'upstream-request',
    });
    finish(Response.json({ value: 1 }));
    await older;
    expect(routes.status().candidates[0].failures).toBe(1);
    expect(routes.status().selectedOrigin).toBe(origins[0]);
  } finally {
    routes.close();
  }
});
it('keeps business errors and cancellation distinct from site failure, and releases deadlines', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
  const routes = new SiteRoutes({ origins, fetch });
  try {
    await expect(routes.read('/api/front/test', decode)).rejects.toMatchObject({ status: 404 });
    const controller = new AbortController();
    controller.abort();
    await expect(routes.read('/api/front/test', decode, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(routes.status().candidates.every((site) => site.failures === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    routes.close();
    vi.useRealTimers();
  }
});
it('restricts account origins to reviewed exact HTTPS hosts', () => {
  expect(accountSiteOrigin('https://aznudelive.com')).toBe('https://aznudelive.com');
  expect(accountSiteOrigin('https://zh.stripchat.com')).toBe('https://zh.stripchat.com');
  for (const value of [
    'http://stripchat.com',
    'https://stripchat.com.evil.invalid',
    'https://127.0.0.1',
    'https://stripchat.com/path',
  ])
    expect(() => accountSiteOrigin(value)).toThrow('INVALID_ACCOUNT_ORIGIN');
});

it('separates login probes from real access and cancels requests belonging to a retired binding', async () => {
  let release!: (response: Response) => void;
  const routes = new SiteRoutes({
    origins,
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('initial-dynamic'))
        return Promise.resolve(Response.json({ initialDynamic: {} }));
      if (url.startsWith(origins[0]))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Promise.resolve(Response.json({ value: 2 }));
    },
  });
  try {
    await routes.probe();
    expect(routes.status().access).toMatchObject({
      origin: origins[0],
      checkedAtMs: null,
      error: null,
    });
    const retired = routes.read('/api/front/test', decode);
    const rejected = expect(retired).rejects.toMatchObject({ code: 'cancelled' });
    routes.configure(origins[1]);
    await rejected;
    release(Response.json({ value: 1 }));
    await routes.read('/api/front/test', decode);
    expect(routes.status().access).toMatchObject({ origin: origins[1], error: null });
    expect(routes.status().access!.lastSuccessAtMs).toBeGreaterThan(0);
    const changed = vi.fn();
    routes.subscribe(changed);
    await routes.read('/api/front/test', decode);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    routes.close();
  }
});

it('does not overwrite real access health with manual benchmark failures', async () => {
  const routes = new SiteRoutes({
    origins,
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        url.includes('initial-dynamic')
          ? new Response(null, { status: 503 })
          : Response.json({ value: 1 }),
      );
    },
  });
  try {
    await routes.read('/api/front/test', decode);
    const healthy = routes.status().access;
    await routes.probe();
    expect(routes.status().candidates.every((site) => site.error)).toBe(true);
    expect(routes.status().access).toEqual(healthy);
    expect(routes.status().probeProgress).toMatchObject({ completed: 2, failed: 2 });
  } finally {
    routes.close();
  }
});
