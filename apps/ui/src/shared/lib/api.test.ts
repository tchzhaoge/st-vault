import { afterEach, expect, it, vi } from 'vitest';
import { request } from './api';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('distinguishes a read deadline from intentional scope cancellation', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    (_path: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => {
            const reason: unknown = options.signal!.reason;
            reject(reason instanceof Error ? reason : new Error('Unexpected abort reason'));
          },
          {
            once: true,
          },
        );
      }),
  );
  const pending = expect(request('/api/synthetic')).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(15000);
  await pending;
  const controller = new AbortController();
  const cancelled = expect(
    request('/api/synthetic', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await cancelled;
});
it.each(['POST', 'DELETE'])(
  'bounds %s transport waits without replaying uncertain writes',
  async (method) => {
    vi.useFakeTimers();
    const observed: { signal: AbortSignal | null } = { signal: null };
    let outcome: unknown;
    const fetcher = vi.fn(
      (_path: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          observed.signal = options.signal ?? null;
          observed.signal?.addEventListener('abort', () => {
            const reason: unknown = observed.signal!.reason;
            reject(reason instanceof Error ? reason : new Error('Unexpected abort reason'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const pending = request('/api/synthetic', { method }).catch((error: unknown) => {
      outcome = error;
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(observed.signal?.aborted).toBe(true);
    await pending;
    expect(outcome).toMatchObject({ name: 'MutationOutcomeUnknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it('keeps definitive admission errors distinct from transport uncertainty', async () => {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response(JSON.stringify({ error: 'archive_busy' }), { status: 503 })),
  );
  await expect(request('/api/synthetic', { method: 'POST' })).rejects.toMatchObject({
    name: 'ApiError',
    status: 503,
    message: 'archive_busy',
  });
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 })),
  );
  await expect(request('/api/synthetic', { method: 'POST' })).rejects.toMatchObject({
    name: 'MutationOutcomeUnknown',
  });
});
it('does not send a write cancelled before submission', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  controller.abort();
  await expect(
    request('/api/synthetic', { method: 'POST', signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('retries safe reads with Retry-After while leaving durable writes single-shot', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'archive_busy' }), {
        status: 503,
        headers: { 'retry-after': '1' },
      }),
    )
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ready: true })));
  vi.stubGlobal('fetch', fetcher);
  const pending = request('/api/static').then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(601);
  expect(await pending).toEqual({ value: { ready: true } });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('honors a long Retry-After without exceeding the shared deadline or retrying early', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'archive_busy' }), {
        status: 503,
        headers: { 'retry-after': '20' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const pending = expect(request('/api/static')).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(15000);
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels a retry wait immediately and does not send another read', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'archive_busy' }), {
        status: 503,
        headers: { 'retry-after': '10' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const pending = expect(
    request('/api/static', { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
