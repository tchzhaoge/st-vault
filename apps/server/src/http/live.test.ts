/* eslint-disable @typescript-eslint/require-await -- Offline upstream fixtures. */
import Fastify from 'fastify';
import { get } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import { createLiveProxy } from '../live/index.js';
import { registerLive } from './live.js';
import type { LivePlaybackResponse, Subject } from '@st-vault/api-schema';

async function fixture(mediaBytes?: Uint8Array) {
  const downloads: string[] = [];
  const live = createLiveProxy({
    archive: {
      getSubject: async (id: string) =>
        (
          await (async (): Promise<Subject[]> => [
            {
              id: 'stripchat:42',
              providerId: 42,
              handle: 'Synthetic',
              monitorEnabled: false,
              autoRecord: false,
              providerStatus: 'PUBLIC',
              observedAtMs: null,
            },
          ])()
        ).find((row) => row.id === id) ?? null,
    },
    provider: { status: async () => 'PUBLIC' },
    hlsEdges: ['edge.invalid'],
    allowedMediaHosts: ['edge.invalid'],
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('_auto.m3u8'))
        return new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nmain.m3u8\n',
        );
      if (url.includes('main.m3u8'))
        return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nmedia.mp4\n');
      downloads.push(url);
      return new Response(
        url.endsWith('/media.mp4') && mediaBytes ? mediaBytes : Buffer.from('synthetic-media'),
        { headers: { 'content-type': 'video/mp4' } },
      );
    },
  });
  const app = Fastify();
  registerLive(app, live, {
    ownerOf: (request) =>
      typeof request.headers['x-fixture-owner'] === 'string'
        ? request.headers['x-fixture-owner']
        : undefined,
  });
  return {
    app,
    live,
    downloads,
    close: async () => {
      await live.close();
      await app.close();
    },
  };
}
describe('authenticated local live proxy routes', () => {
  it('binds every manifest/media/DELETE to its owner and keeps remote URLs out of responses', async () => {
    const f = await fixture(),
      headers = { 'x-fixture-owner': 'owner-A' };
    try {
      expect(
        (await f.app.inject({ method: 'POST', url: '/api/subjects/stripchat:42/live' })).statusCode,
      ).toBe(401);
      const opening = await f.app.inject({
        method: 'POST',
        url: '/api/subjects/stripchat:42/live',
        headers,
      });
      expect(opening.statusCode).toBe(200);
      const opened = opening.json<LivePlaybackResponse>();
      expect(opening.body).not.toContain('edge.invalid');
      expect(
        (await f.app.inject({ url: '/api/subjects/stripchat:42/live-progress' })).statusCode,
      ).toBe(401);
      expect(
        (await f.app.inject({ url: '/api/subjects/stripchat:42/live-progress', headers })).json(),
      ).toEqual({ phase: 'ready' });
      expect(
        (
          await f.app.inject({
            url: '/api/subjects/stripchat:42/live-progress',
            headers: { 'x-fixture-owner': 'owner-B' },
          })
        ).json(),
      ).toBeNull();
      const playlist = await f.app.inject({ url: opened.manifestUrl, headers });
      expect(playlist.statusCode).toBe(200);
      expect(playlist.headers['content-type']).toContain('mpegurl');
      expect(playlist.headers['cache-control']).toBe('private, no-store');
      expect(playlist.body).not.toContain('https:');
      const media = playlist.body
        .split('\n')
        .find((line) => line.startsWith('/api/live/') && line.includes('/media/'))!;
      expect((await f.app.inject({ url: media })).statusCode).toBe(401);
      expect(
        (await f.app.inject({ url: media, headers: { 'x-fixture-owner': 'owner-B' } })).statusCode,
      ).toBe(404);
      const fragment = await f.app.inject({ url: media, headers });
      expect(fragment.statusCode).toBe(200);
      expect(fragment.headers['content-type']).toBe('video/mp4');
      expect(fragment.body).toBe('synthetic-media');
      expect(
        (
          await f.app.inject({
            method: 'DELETE',
            url: `/api/live/${opened.sessionId}`,
            headers: { 'x-fixture-owner': 'owner-B' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await f.app.inject({ method: 'DELETE', url: `/api/live/${opened.sessionId}`, headers }))
          .statusCode,
      ).toBe(204);
      expect((await f.app.inject({ url: opened.manifestUrl, headers })).statusCode).toBe(404);
    } finally {
      await f.close();
    }
  });
  it('cancels a disconnected TCP delivery while a second owner keeps using the shared producer bytes', async () => {
    const payload = new Uint8Array(8 * 1024 * 1024),
      f = await fixture(payload),
      headers = { 'x-fixture-owner': 'owner-A' };
    const signals: AbortSignal[] = [],
      original = f.live.media.bind(f.live);
    let started!: () => void, releaseDelivery: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(f.live, 'media').mockImplementation(async (owner, id, token, deliver, signal) => {
      if (signal) signals.push(signal);
      await original(
        owner,
        id,
        token,
        async (bytes, abort) => {
          if (owner === 'owner-A') {
            started();
            await new Promise<void>((resolve, reject) => {
              const cancel = (): void => {
                abort.removeEventListener('abort', cancel);
                reject(new Error('delivery-cancelled'));
              };
              abort.addEventListener('abort', cancel, { once: true });
              releaseDelivery = () => {
                abort.removeEventListener('abort', cancel);
                resolve();
              };
            });
          }
          await deliver(bytes, abort);
        },
        signal,
      );
    });
    try {
      const origin = await f.app.listen({ host: '127.0.0.1', port: 0 }),
        opened = (
          await f.app.inject({ method: 'POST', url: '/api/subjects/stripchat:42/live', headers })
        ).json<LivePlaybackResponse>();
      const body = (await f.app.inject({ url: opened.manifestUrl, headers })).body,
        media = body
          .split('\n')
          .find((line) => line.startsWith('/api/live/') && line.includes('/media/'))!;
      const otherHeaders = { 'x-fixture-owner': 'owner-B' },
        other = (
          await f.app.inject({
            method: 'POST',
            url: '/api/subjects/stripchat:42/live',
            headers: otherHeaders,
          })
        ).json<LivePlaybackResponse>();
      const request = get(origin + media, { headers }),
        disconnected = new Promise<Error>((resolve) => {
          request.once('error', resolve);
        });
      await deliveryStarted;
      request.destroy();
      expect((await disconnected).message).toContain('socket hang up');
      await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
      expect((await f.app.inject({ url: opened.manifestUrl, headers })).statusCode).toBe(200);
      const otherManifest = (await f.app.inject({ url: other.manifestUrl, headers: otherHeaders }))
          .body,
        otherMedia = otherManifest
          .split('\n')
          .find((line) => line.startsWith('/api/live/') && line.includes('/media/'))!;
      const response = await fetch(origin + otherMedia, { headers: otherHeaders });
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(payload.byteLength);
      expect(f.downloads.filter((url) => url.endsWith('/media.mp4'))).toHaveLength(1);
    } finally {
      releaseDelivery?.();
      await f.close();
    }
  });
});
