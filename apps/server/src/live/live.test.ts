/* eslint-disable @typescript-eslint/require-await -- Offline ports preserve async signatures. */
import { createHash } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createLiveProxy } from './index.js';
import type { LiveProxy } from './index.js';
import type { IngressHub, IngressLease } from '../ingest/index.js';
import type { PublicStatus, Subject } from '@st-vault/api-schema';

const cleanups: LiveProxy[] = [];
afterEach(async () => {
  for (const live of cleanups.splice(0)) await live.close();
});
const tick = async (): Promise<void> => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};
const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function encrypted(component: string, secret: string): string {
  const hash = createHash('sha256').update(secret).digest(),
    bytes = Buffer.from(component);
  for (let index = 0; index < bytes.length; index++) bytes[index] ^= hash[index % hash.length];
  return [...bytes.toString('base64')].reverse().join('');
}
// A pending shared status observation belongs to StatusEvidence, rather than to
// a single live request. Exercise live's actual-work draining at its own ingress boundary.
function pendingIngress(acquire: IngressHub['acquire']): IngressHub {
  return {
    acquire,
    capture: async () => {
      throw Error('unused capture');
    },
    changeCdn: () => undefined,
    stats: () => ({ subjects: 0, retainedBytes: 0, maxBytes: 0 }),
    close: async () => undefined,
  };
}
const unusedLease: IngressLease = {
  snapshot: () => {
    throw Error('cancelled opening must not read media');
  },
  media: () => {
    throw Error('cancelled opening must not read media');
  },
  release: () => undefined,
};
function fixture(protectedMode = false) {
  let clock = 1000000,
    state: PublicStatus = 'PUBLIC';
  const requested: string[] = [],
    secret = 'synthetic-live-secret',
    token = encrypted('clear', secret);
  const archive = {
    async getSubject(id: string) {
      return (await this.listSubjects()).find((row) => row.id === id) ?? null;
    },

    listSubjects: async (): Promise<Subject[]> => [
      {
        id: 'stripchat:42',
        providerId: 42,
        handle: 'Synthetic',
        monitorEnabled: false,
        autoRecord: false,
        providerStatus: 'UNKNOWN',
        observedAtMs: null,
      },
    ],
  };
  const provider = { status: vi.fn(async () => state) };
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    requested.push(url);
    expect(init?.credentials).toBe('omit');
    const headers = new Headers(init?.headers);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    if (url.includes('_auto.m3u8'))
      return new Response(
        '#EXTM3U\n' +
          (protectedMode ? '#EXT-X-MOUFLON:PSCH:info:1:wanted\n' : '') +
          '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160\n4k.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nhigh.m3u8\n',
      );
    if (url.includes('.m3u8'))
      return new Response(
        '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART:DURATION=0.5,URI="ignored-part.mp4"\n#EXT-X-PROGRAM-DATE-TIME:2026-11-03T00:00:00+0000\n#EXTINF:2,\n' +
          (protectedMode ? `#EXT-X-MOUFLON:URI:media_${token}_42.mp4\n` : 'media_clear_42.mp4\n'),
      );
    return new Response(Buffer.from('synthetic-media'), {
      headers: { 'content-type': 'video/mp4' },
    });
  });
  const create = (extra: Partial<Parameters<typeof createLiveProxy>[0]> = {}): LiveProxy => {
    const live = createLiveProxy({
      archive,
      provider,
      fetch,
      hlsEdges: ['edge.invalid'],
      allowedMediaHosts: ['edge.invalid'],
      now: () => clock,
      keyLookup: () => secret,
      ...extra,
    });
    cleanups.push(live);
    return live;
  };
  return {
    create,
    requested,
    fetch,
    provider,
    setStatus: (status: PublicStatus) => {
      state = status;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    secret,
  };
}
it('admits the configured number of sessions for one administrator instead of a fixed pair', async () => {
  const f = fixture();
  const live = f.create({ maxSessions: 8, maxOwnerSessions: 4, openConcurrency: 4 });
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => live.create('owner', 'stripchat:42')),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
  await expect(live.create('owner', 'stripchat:42')).rejects.toMatchObject({ code: 'live_busy' });
});
it('keeps one slow viewer from occupying every configured media response slot', async () => {
  const live = fixture().create({ mediaConcurrency: 4 });
  const first = await live.create('owner-A', 'stripchat:42');
  const other = await live.create('owner-B', 'stripchat:42');
  const token = (manifest: string) => [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)][1][1];
  const firstToken = token(await live.manifest('owner-A', first.sessionId));
  const otherToken = token(await live.manifest('owner-B', other.sessionId));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = vi.fn(() => held);
  const waiting = Array.from({ length: 4 }, () =>
    live.media('owner-A', first.sessionId, firstToken, slow),
  );
  let otherReady = false;
  const independent = live.media('owner-B', other.sessionId, otherToken, () => {
    otherReady = true;
    return Promise.resolve();
  });
  try {
    await vi.waitFor(() => expect(otherReady).toBe(true));
    expect(slow).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await Promise.allSettled([...waiting, independent]);
  }
});
describe('bounded owner-bound anonymous live HLS', () => {
  it('replaces only the explicitly owned previous lease before admission', async () => {
    const live = fixture().create();
    const first = await live.create('owner-A', 'stripchat:42');
    const otherTab = await live.create('owner-A', 'stripchat:42');
    const replacement = await live.create('owner-A', 'stripchat:42', undefined, first.sessionId);
    expect(replacement.sessionId).not.toBe(first.sessionId);
    await expect(live.manifest('owner-A', otherTab.sessionId)).resolves.toContain('#EXTM3U');
    await expect(
      live.create('owner-A', 'stripchat:42', undefined, 'foreign-id'),
    ).rejects.toMatchObject({ code: 'live_busy' });
  });
  it('retains the authoritative terminal cause after a failing manifest releases its session', async () => {
    const f = fixture();
    const live = f.create();
    const opened = await live.create('owner-A', 'stripchat:42');
    expect(live.progress!('owner-A', 'stripchat:42')).toEqual({ phase: 'ready' });
    f.setStatus('PRIVATE');
    f.advance(3000);
    await vi.waitFor(() =>
      expect(live.progress!('owner-A', 'stripchat:42')).toEqual({
        phase: 'stopped',
        reason: 'private',
      }),
    );
    await expect(live.manifest('owner-A', opened.sessionId)).rejects.toMatchObject({
      code: 'live_not_public',
      reason: 'private',
    });
    expect(live.progress!('owner-A', 'stripchat:42')).toEqual({
      phase: 'stopped',
      reason: 'private',
    });
    expect(live.progress!('owner-B', 'stripchat:42')).toBeNull();
    await live.destroyOwner('owner-A');
    expect(live.progress!('owner-A', 'stripchat:42')).toBeNull();
  });
  it('chooses the highest advertised quality and exposes only local opaque media references', async () => {
    const f = fixture(),
      live = f.create(),
      opened = await live.create('owner-A', 'stripchat:42');
    expect(opened.quality).toEqual({ height: 2160, bandwidth: 20000000 });
    expect(f.requested.some((url) => url.includes('4k.m3u8'))).toBe(true);
    expect(f.requested.some((url) => url.includes('low.m3u8'))).toBe(false);
    const manifest = await live.manifest('owner-A', opened.sessionId);
    expect(manifest).toContain('#EXT-X-MEDIA-SEQUENCE:42');
    expect(manifest).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:7');
    expect(manifest).not.toContain('https:');
    expect(manifest).not.toContain('ignored-part');
    expect(manifest).not.toContain(f.secret);
    const tokens = [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)].map((match) => match[1]);
    let bytes: Uint8Array | undefined;
    await live.media('owner-A', opened.sessionId, tokens[1], async (value) => {
      bytes = value;
    });
    expect(Buffer.from(bytes!).toString()).toBe('synthetic-media');
    await expect(live.manifest('owner-B', opened.sessionId)).rejects.toMatchObject({
      code: 'live_not_found',
    });
    await expect(
      live.media('owner-A', opened.sessionId, 'not-issued', async () => undefined),
    ).rejects.toMatchObject({ code: 'live_not_found' });
    await expect(live.destroy('owner-B', opened.sessionId)).rejects.toMatchObject({
      code: 'live_not_found',
    });
  });
  it('uses supplied keys without extraction and never exposes the secret', async () => {
    const f = fixture(true),
      live = f.create(),
      opened = await live.create('owner', 'stripchat:42');
    const manifest = await live.manifest('owner', opened.sessionId);
    expect(manifest).not.toContain('MOUFLON');
    expect(manifest).not.toContain('pkey');
    expect(manifest).not.toContain(f.secret);
    const token = [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)][1][1];
    await live.media('owner', opened.sessionId, token, async () => undefined);
    expect(f.requested.at(-1)).toContain('media_clear_42.mp4');
    const missing = fixture(true);
    await expect(
      missing.create({ keyLookup: () => undefined }).create('owner', 'stripchat:42'),
    ).rejects.toMatchObject({ code: 'live_unavailable', reason: 'keys' });
  });
  it('denies all non-public states before resolving HLS and stops a session after a private transition', async () => {
    for (const state of ['OFFLINE', 'PRIVATE', 'UNKNOWN'] as const) {
      const f = fixture();
      f.setStatus(state);
      await expect(f.create().create('owner', 'stripchat:42')).rejects.toMatchObject({
        code: 'live_not_public',
      });
      expect(f.fetch).not.toHaveBeenCalled();
    }
    const f = fixture(),
      live = f.create(),
      opened = await live.create('owner', 'stripchat:42');
    f.setStatus('PRIVATE');
    f.advance(2001);
    // PRIVATE revokes on its first response; the shared owner also confirms the timeline transition.
    await vi.waitFor(() => expect(f.provider.status).toHaveBeenCalledTimes(3));
    await expect(live.manifest('owner', opened.sessionId)).rejects.toMatchObject({
      code: 'live_not_public',
    });
    await expect(live.manifest('owner', opened.sessionId)).rejects.toMatchObject({
      code: 'live_not_found',
    });
  });
  it('renews active playback past thirty minutes, expires idle sessions and bounds each owner', async () => {
    const f = fixture(),
      live = f.create({ idleMs: 60000 }),
      opened = await live.create('owner', 'stripchat:42');
    await live.create('owner', 'stripchat:42');
    await expect(live.create('owner', 'stripchat:42')).rejects.toMatchObject({ code: 'live_busy' });
    for (let index = 0; index < 40; index++) {
      f.advance(50000);
      await live.manifest('owner', opened.sessionId);
    }
    expect(f.provider.status).toHaveBeenCalledOnce();
    f.advance(60001);
    await expect(live.manifest('owner', opened.sessionId)).rejects.toMatchObject({
      code: 'live_not_found',
    });
  });
  it('holds the two-payload budget until delivery finishes and cancels queued requests without leaking it', async () => {
    const f = fixture(),
      live = f.create(),
      opened = await live.create('owner', 'stripchat:42'),
      manifest = await live.manifest('owner', opened.sessionId),
      token = [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)][1][1];
    let release: (() => void) | undefined,
      active = 0,
      maximum = 0;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      deliver = async (): Promise<void> => {
        active++;
        maximum = Math.max(maximum, active);
        await gate;
        active--;
      };
    const first = live.media('owner', opened.sessionId, token, deliver),
      second = live.media('owner', opened.sessionId, token, deliver),
      controller = new AbortController(),
      third = live.media('owner', opened.sessionId, token, deliver, controller.signal);
    void third.catch(() => undefined);
    try {
      await tick();
      expect(maximum).toBe(2);
      controller.abort();
      await expect(third).rejects.toMatchObject({ code: 'live_cancelled' });
      release?.();
      await Promise.all([first, second]);
      await live.media('owner', opened.sessionId, token, async () => undefined);
      expect(maximum).toBe(2);
    } finally {
      release?.();
      await Promise.allSettled([first, second, third]);
    }
  });
  it('does not follow an arbitrary-host HLS variant and drains cancelled opening work', async () => {
    const f = fixture(),
      live = f.create({
        fetch: async () =>
          new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://127.0.0.1/private.m3u8\n'),
      });
    await expect(live.create('owner', 'stripchat:42')).rejects.toMatchObject({
      code: 'live_unavailable',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(live.create('owner', 'stripchat:42', controller.signal)).rejects.toMatchObject({
      code: 'live_cancelled',
    });
    await live.close();
    await expect(live.create('owner', 'stripchat:42')).rejects.toMatchObject({
      code: 'live_unavailable',
    });
  });
  it('keeps actual opening slots occupied after cancellation and drains removed sessions on close', async () => {
    const f = fixture();
    let active = 0,
      maximum = 0;
    const releases: (() => void)[] = [];
    const live = f.create({
      archive: {
        getSubject: async (id: string) =>
          (
            await (async () =>
              Array.from({ length: 4 }, (_, index) => ({
                id: `stripchat:${42 + index}`,
                providerId: 42 + index,
                handle: 'Synthetic',
                monitorEnabled: false,
                autoRecord: false,
                providerStatus: 'UNKNOWN' as const,
                observedAtMs: null,
              })))()
          ).find((row) => row.id === id) ?? null,
      },
      ingress: pendingIngress(() => {
        active++;
        maximum = Math.max(maximum, active);
        return new Promise<IngressLease>((resolve) => {
          releases.push(() => {
            active--;
            resolve(unusedLease);
          });
        });
      }),
    });
    try {
      for (let index = 0; index < 4; index++) {
        const controller = new AbortController(),
          opening = live.create('owner', `stripchat:${42 + index}`, controller.signal),
          rejected = expect(opening).rejects.toMatchObject({ code: 'live_cancelled' });
        await tick();
        controller.abort();
        await rejected;
        await tick();
      }
      expect(active).toBe(2);
      expect(maximum).toBe(2);
      expect(f.fetch).not.toHaveBeenCalled();
      let drained = false;
      const closing = live.close();
      void closing.then(() => {
        drained = true;
      });
      await tick();
      expect(drained).toBe(false);
      expect(active).toBe(2);
      for (const release of releases.splice(0)) release();
      await closing;
      expect(active).toBe(0);
      expect(drained).toBe(true);
      expect(maximum).toBe(2);
    } finally {
      for (const release of releases.splice(0)) release();
      await live.close();
    }
  });
  it('revokes one owner immediately and drains its removed-session work without affecting another owner', async () => {
    const f = fixture(),
      live = f.create(),
      other = await live.create('owner-B', 'stripchat:42'),
      session = await live.create('owner-A', 'stripchat:42');
    await live.destroyOwner('owner-A');
    await expect(live.manifest('owner-A', session.sessionId)).rejects.toMatchObject({
      code: 'live_not_found',
    });
    expect(await live.manifest('owner-B', other.sessionId)).toContain('#EXTM3U');
    let release: (() => void) | undefined;
    const held = f.create({
        ingress: pendingIngress(
          () =>
            new Promise<IngressLease>((resolve) => {
              release = () => resolve(unusedLease);
            }),
        ),
      }),
      controller = new AbortController(),
      opening = held.create('owner-A', 'stripchat:42', controller.signal),
      cancelled = expect(opening).rejects.toMatchObject({ code: 'live_cancelled' });
    await tick();
    controller.abort();
    await cancelled;
    let drained = false;
    const revoking = held.destroyOwner('owner-A');
    void revoking.then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(false);
    release?.();
    await revoking;
    expect(drained).toBe(true);
  });
});
