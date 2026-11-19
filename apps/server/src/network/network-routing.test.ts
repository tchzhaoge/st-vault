import { expect, it } from 'vitest';
import { NetworkRouting } from './network-routing.js';
import { SiteRoutes } from '../provider/site-routes.js';

it('notifies all producers on a saved CDN change and clears stale active nodes', async () => {
  const sites = new SiteRoutes();
  const network = await NetworkRouting.open(
    { getSetting: () => Promise.resolve(null), setSetting: () => Promise.resolve() },
    sites,
  );
  try {
    const old = network.preferredCdn(),
      next = 'edge-hls.doppiocdn.media';
    const changes: string[] = [];
    network.subscribeCdn(() => changes.push(network.preferredCdn()));
    network.selectedCdn(42, old);
    await network.update({ cdnHost: old });
    expect(changes).toEqual([]);
    expect(network.status().activeCdns['stripchat:42']).toBe(old);
    const nextStatus = await network.update({ cdnHost: next });
    expect(changes).toEqual([next]);
    expect(nextStatus.activeCdns).toEqual({});
    network.selectedCdn(42, next);
    expect(network.status().activeCdns['stripchat:42']).toBe(next);
    network.stoppedCdn(42);
    expect(network.status().activeCdns['stripchat:42']).toBeUndefined();
  } finally {
    await network.close();
    sites.close();
  }
});
it('finds a matching protected playlist without a player or account', async () => {
  const sites = new SiteRoutes({
    fetch: () =>
      Promise.resolve(Response.json({ models: [{ id: 42, isLive: true, status: 'public' }] })),
  });
  const network = await NetworkRouting.open(
    { getSetting: () => Promise.resolve(null), setSetting: () => Promise.resolve() },
    sites,
    {
      fetch: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(
          new Response(
            url.includes('_auto.m3u8')
              ? '#EXTM3U\n#EXT-X-MOUFLON:PSCH:info:1:wanted\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8\n'
              : '#EXTM3U\n#EXTINF:2,\n#EXT-X-MOUFLON:URI:media_01abc_42.mp4\n',
          ),
        );
      },
    },
  );
  try {
    const signal = new AbortController().signal;
    const sample = await network.keySample({ name: 'wanted', value: 'test-key' }, signal);
    expect(sample?.name).toBe('wanted');
    expect(sample?.address).toContain('media_01abc_42.mp4');
    expect(await network.keySample({ name: 'other', value: 'test-key' }, signal)).toBeUndefined();
  } finally {
    await network.close();
    sites.close();
  }
});

it('persists CDN choices and rejects the removed independent website setting', async () => {
  let stored: string | null = '{"cdnHost":null}';
  const archive = {
    getSetting: () => Promise.resolve(stored),
    setSetting: (_key: string, value: string) => {
      stored = value;
      return Promise.resolve();
    },
  };
  const sites = new SiteRoutes();
  const network = await NetworkRouting.open(archive, sites);
  try {
    expect(network.preferredCdn()).toBe('edge-hls.doppiocdn.net');
    expect(stored).toBe(JSON.stringify(network.status().preferences));
    await expect(network.update({ cdnHost: null })).rejects.toThrow();
    await network.update({ cdnHost: 'edge-hls.doppiocdn.org' });
    expect(network.status().preferences).toEqual({ cdnHost: 'edge-hls.doppiocdn.org' });
    await expect(network.update({ siteOrigin: 'https://stripchat.org' })).rejects.toThrow();
    await expect(network.update({ cdnHost: 'private.invalid' })).rejects.toThrow();
    const reopened = await NetworkRouting.open(archive, sites);
    expect(reopened.status().preferences).toEqual(network.status().preferences);
    await reopened.close();
  } finally {
    await network.close();
    sites.close();
  }
});
