import { expect, it, vi } from 'vitest';
import { broadcastCover, coverSource } from './cover-source.js';
import { createProvider } from './index.js';

it('normalizes numeric and string snapshot versions without using offline placeholder timestamps', () => {
  expect(broadcastCover(42, { isLive: true, snapshotTimestamp: '123' })).toBe(
    'https://img.doppiocdn.org/snapshot/42/123',
  );
  for (const value of [0, -1, '0', '1.5', 'bad', Number.MAX_SAFE_INTEGER + 1])
    expect(broadcastCover(42, { snapshotTimestamp: value })).toBeNull();
  expect(broadcastCover(42, { isLive: false, snapshotTimestamp: 123 })).toBeNull();
  expect(coverSource('https://user:password@static-cdn.strpst.com/a')).toBeNull();
  expect(coverSource('http://static-cdn.strpst.com/a')).toBeNull();
});

it('shares the existing anonymous status observation with cover updates without making a second request', async () => {
  const onCoverObserved = vi.fn();
  const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    return Promise.resolve(
      Response.json({ item: { isLive: true, status: 'public', snapshotTimestamp: '123' } }),
    );
  });
  const provider = createProvider({ fetch, onCoverObserved });
  expect(await provider.status(42)).toBe('PUBLIC');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onCoverObserved).toHaveBeenCalledWith(
    'stripchat:42',
    'https://img.doppiocdn.org/snapshot/42/123',
  );
});

it('imports the provided small cover variant for compact preview cells instead of an oversized big image', async () => {
  const provider = createProvider({
    fetch: (input) =>
      Promise.resolve(
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes('initial-dynamic')
          ? Response.json({
              initialDynamic: { user: { username: 'synthetic' }, jwtToken: 'synthetic-jwt' },
            })
          : Response.json({
              totalCount: 1,
              models: [
                {
                  id: 42,
                  username: 'synthetic',
                  avatarUrl: 'https://static-cdn.strpst.com/avatars/fixture',
                  previewUrlThumbSmall:
                    'https://static-cdn.strpst.com/previews/fixture-thumb-small',
                  previewUrlThumbBig: 'https://static-cdn.strpst.com/previews/fixture-thumb-big',
                },
              ],
            }),
      ),
  });
  const result = await provider.importList('session=synthetic');
  expect(result[0].previewSourceUrl).toBe(
    'https://static-cdn.strpst.com/previews/fixture-thumb-small',
  );
  expect(result[0].avatarSourceUrl).toBe('https://static-cdn.strpst.com/avatars/fixture');
});
