/* eslint-disable @typescript-eslint/require-await -- Synthetic asynchronous ports. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveProgress, Segment, Subject } from '@st-vault/api-schema';
import { createIngressHub } from './index.js';
import type { IngressHub } from './index.js';
import { createLiveProxy } from '../live/index.js';
import type { CommitInput } from '../ports.js';
import { ProviderError } from '../provider/http.js';
import { StatusEvidence } from '../provider/status-evidence.js';
import { createSupervisor } from '../capture/supervisor.js';
import type { ArchivePort } from '../ports.js';

const subject: Subject = {
  id: 'stripchat:42',
  providerId: 42,
  handle: 'Synthetic',
  monitorEnabled: true,
  autoRecord: true,
  providerStatus: 'PUBLIC',
  observedAtMs: 0,
};
const hubs: IngressHub[] = [];
const evidenceServices: StatusEvidence[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  await Promise.all(evidenceServices.splice(0).map((evidence) => evidence.close()));
});
function fixture(extra: Partial<Parameters<typeof createIngressHub>[0]> = {}) {
  let sequence = 1,
    state = 'PUBLIC';
  const requests: string[] = [];
  const provider = { status: vi.fn(async () => state as Subject['providerStatus']) };
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url.includes('_auto.m3u8'))
      return new Response(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nmain.m3u8\n',
      );
    if (url.includes('.m3u8'))
      return new Response(
        `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PROGRAM-DATE-TIME:${new Date(1700000000000 + sequence * 2000).toISOString()}\n#EXTINF:2,\nsegment-${sequence}.mp4\n`,
      );
    return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
  });
  const hub = createIngressHub({
    provider,
    fetch,
    hlsEdges: ['edge.invalid'],
    allowedMediaHosts: ['edge.invalid'],
    reloadMs: 5,
    ...extra,
  });
  hubs.push(hub);
  return {
    hub,
    provider,
    requests,
    advance: () => {
      sequence++;
    },
    private: () => {
      state = 'PRIVATE';
    },
    public: () => {
      state = 'PUBLIC';
    },
  };
}
describe('shared live ingress', () => {
  it.each([false, true])(
    'reclaims the oldest published ring head fairly while preserving recording ownership (%s)',
    async (protectedRecording) => {
      const versions = new Map<number, number>();
      const hub = createIngressHub({
        provider: { status: () => Promise.resolve('PUBLIC') },
        hlsEdges: ['edge.invalid'],
        allowedMediaHosts: ['edge.invalid'],
        maxBytes: 24 * 1024 ** 2,
        ringBytes: 24 * 1024 ** 2,
        ringSegments: 1,
        reloadMs: 5,
        fetch: (input) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          const id = Number(/\/(\d+)(?:_auto|\/)/.exec(url.pathname)?.[1]);
          const sequence = versions.get(id) ?? 1;
          if (url.pathname.includes('_auto.m3u8'))
            return Promise.resolve(
              new Response(
                `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n/hls/${id}/main.m3u8\n`,
              ),
            );
          if (url.pathname.endsWith('.m3u8'))
            return Promise.resolve(
              new Response(
                `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-PROGRAM-DATE-TIME:${new Date(1700000000000 + sequence * 2000).toISOString()}\n#EXTINF:2,\nsegment-${sequence}.mp4\n`,
              ),
            );
          return Promise.resolve(
            new Response(new Uint8Array((id === 42 && sequence === 2 ? 8 : 4) * 1024 ** 2), {
              headers: { 'content-type': 'video/mp4' },
            }),
          );
        },
      });
      hubs.push(hub);
      const a = await hub.acquire(subject);
      const bSubject = { ...subject, id: 'stripchat:43', providerId: 43 };
      const controller = new AbortController();
      let releaseCommit!: () => void;
      let recording: Promise<unknown> | undefined;
      let b: Awaited<ReturnType<IngressHub['acquire']>> | undefined;
      let c: Awaited<ReturnType<IngressHub['acquire']>> | undefined;
      try {
        if (protectedRecording) {
          recording = hub
            .capture(
              bSubject,
              {
                commit: async (input) => {
                  await new Promise<void>((resolve) => {
                    releaseCommit = resolve;
                  });
                  return {
                    ...input,
                    id: 'synthetic',
                    mediaObjectId: 'synthetic',
                    initObjectId: null,
                    wallEndMs: input.wallStartMs! + 2000,
                  };
                },
              },
              controller.signal,
            )
            .catch((error: unknown) => error);
          await vi.waitFor(() => expect(releaseCommit).toBeTypeOf('function'));
        }
        b = await hub.acquire(bSubject);
        versions.set(42, 2);
        await vi.waitFor(() => expect(a.snapshot().playlist.segments[0]?.sequence).toBe('2'));
        c = await hub.acquire({ ...subject, id: 'stripchat:44', providerId: 44 });
        expect(a.snapshot().playlist.segments).toHaveLength(protectedRecording ? 0 : 1);
        expect(b.snapshot().playlist.segments).toHaveLength(protectedRecording ? 1 : 0);
      } finally {
        controller.abort();
        releaseCommit?.();
        await recording;
        a.release();
        b?.release();
        c?.release();
        await hub.close();
        expect(hub.stats().retainedBytes).toBe(0);
      }
    },
  );
  it('releases a borrowed HTTP payload on failure and only after an aborted actual delivery drains', async () => {
    const f = fixture({ ringSegments: 1 });
    const live = createLiveProxy({
      archive: { getSubject: () => Promise.resolve(subject) },
      provider: f.provider,
      ingress: f.hub,
    });
    let release: (() => void) | undefined;
    let cancelled: Promise<unknown> | undefined;
    try {
      const session = await live.create('owner', subject.id);
      const manifest = () => live.manifest('owner', session.sessionId);
      const token = (text: string) => [...text.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)][1][1];
      await expect(
        live.media('owner', session.sessionId, token(await manifest()), async () => {
          f.advance();
          await vi.waitFor(async () =>
            expect(await manifest()).toContain('#EXT-X-MEDIA-SEQUENCE:2'),
          );
          expect(f.hub.stats().retainedBytes).toBe(192);
          throw Error('synthetic socket failure');
        }),
      ).rejects.toMatchObject({ code: 'live_unavailable' });
      expect(f.hub.stats().retainedBytes).toBe(128);
      const controller = new AbortController();
      const request = live.media(
        'owner',
        session.sessionId,
        token(await manifest()),
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        controller.signal,
      );
      cancelled = expect(request).rejects.toMatchObject({ code: 'live_cancelled' });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      f.advance();
      await vi.waitFor(async () => expect(await manifest()).toContain('#EXT-X-MEDIA-SEQUENCE:3'));
      expect(f.hub.stats().retainedBytes).toBe(192);
      controller.abort();
      await cancelled;
      expect(f.hub.stats().retainedBytes).toBe(192);
      release!();
      await vi.waitFor(() => expect(f.hub.stats().retainedBytes).toBe(128));
    } finally {
      release?.();
      await cancelled;
      await live.close();
    }
  });
  it('keeps buffers borrowed by slow HTTP viewers charged after their ring frames are evicted', async () => {
    const f = fixture({ ringSegments: 1 });
    const live = createLiveProxy({
      archive: { getSubject: () => Promise.resolve(subject) },
      provider: f.provider,
      ingress: f.hub,
    });
    let releaseFirst: (() => void) | undefined, releaseSecond: (() => void) | undefined;
    const deliveries: Promise<unknown>[] = [];
    try {
      const first = await live.create('first', subject.id);
      const second = await live.create('second', subject.id);
      const token = (manifest: string) =>
        [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)][1][1];
      deliveries.push(
        live
          .media(
            'first',
            first.sessionId,
            token(await live.manifest('first', first.sessionId)),
            () =>
              new Promise<void>((resolve) => {
                releaseFirst = resolve;
              }),
          )
          .catch((error: unknown) => error),
      );
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
      f.advance();
      await vi.waitFor(async () =>
        expect(await live.manifest('second', second.sessionId)).toContain(
          '#EXT-X-MEDIA-SEQUENCE:2',
        ),
      );
      deliveries.push(
        live
          .media(
            'second',
            second.sessionId,
            token(await live.manifest('second', second.sessionId)),
            () =>
              new Promise<void>((resolve) => {
                releaseSecond = resolve;
              }),
          )
          .catch((error: unknown) => error),
      );
      await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'));
      f.advance();
      await vi.waitFor(async () =>
        expect(await live.manifest('second', second.sessionId)).toContain(
          '#EXT-X-MEDIA-SEQUENCE:3',
        ),
      );
      expect(f.hub.stats().retainedBytes).toBe(256); // Two borrowed payloads + current payload + shared init.
      await f.hub.close();
      expect(f.hub.stats().retainedBytes).toBe(128);
      releaseFirst!();
      releaseSecond!();
      await Promise.all(deliveries);
      expect(f.hub.stats().retainedBytes).toBe(0);
    } finally {
      releaseFirst?.();
      releaseSecond?.();
      await Promise.allSettled(deliveries);
      await live.close();
    }
  });
  it('shares confirmed observations and offline permission between the supervisor and live producer', async () => {
    let now = 1000;
    const row: Subject = { ...subject, providerStatus: 'UNKNOWN', observedAtMs: null };
    const provider = { status: vi.fn(async (): Promise<Subject['providerStatus']> => 'PUBLIC') };
    const archive = {
      listSubjects: async () => [{ ...row }],
      getSubject: async () => ({ ...row }),
      setObservation: vi.fn(async (_id: string, status: Subject['providerStatus'], at: number) => {
        row.providerStatus = status;
        row.observedAtMs = at;
      }),
      commit: vi.fn(async () => ({}) as Segment),
    } as unknown as ArchivePort;
    const evidence = new StatusEvidence({
      provider,
      now: () => now,
      intervalMs: () => 5000,
      persist: (id, status, at, lease, transitionAt) =>
        archive.setObservation(id, status, at, lease, transitionAt),
    });
    evidenceServices.push(evidence);
    const f = fixture({ provider, evidence, publicCheckMs: 5000 });
    const supervisor = createSupervisor({
      archive,
      evidence,
      now: () => now,
      autoStart: false,
      provider: {
        ...provider,
        importList: async () => [],
        capture: (target, sink, signal) => f.hub.capture(target, sink, signal),
      },
    });
    let lease: Awaited<ReturnType<IngressHub['acquire']>> | undefined;
    try {
      await supervisor.reconcile();
      await vi.waitFor(() => expect(archive.commit).toHaveBeenCalled());
      lease = await f.hub.acquire(row);
      expect(provider.status).toHaveBeenCalledOnce();
      provider.status.mockResolvedValue('OFFLINE');
      now = 4000;
      await supervisor.reconcile();
      expect(provider.status).toHaveBeenCalledTimes(3);
      expect(row.providerStatus).toBe('OFFLINE');
      expect(lease.snapshot().playlist.segments.length).toBeGreaterThan(0);
      expect(supervisor.states()[row.id]).toBe('CAPTURING');
      now = 20000;
      await supervisor.reconcile();
      expect(() => lease!.snapshot()).toThrow('live_not_public');
      await vi.waitFor(() => expect(supervisor.states()[row.id]).toBe('IDLE'));
    } finally {
      lease?.release();
      await supervisor.close();
    }
  });
  it('waits for memory admission across many recordings instead of restarting them', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let downloads = 0;
    const f = fixture({
      maxBytes: 18 * 1024 ** 2,
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
        if (url.includes('.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.mp4\n');
        downloads++;
        await gate;
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const committed = new Set<string>(),
      errors: unknown[] = [];
    const controllers = Array.from({ length: 12 }, () => new AbortController());
    const tasks = controllers.map((controller, index) =>
      f.hub
        .capture(
          { ...subject, id: `stripchat:${index + 1}`, providerId: index + 1 },
          {
            commit: async (input) => {
              committed.add(input.subjectId);
              return {} as Segment;
            },
          },
          controller.signal,
        )
        .catch((error: unknown) => {
          if (!controller.signal.aborted) errors.push(error);
        }),
    );
    try {
      await vi.waitFor(() => expect(downloads).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(errors).toEqual([]);
      expect(f.hub.stats().retainedBytes).toBeLessThanOrEqual(f.hub.stats().maxBytes);
      release();
      await vi.waitFor(() => expect(committed.size).toBe(12));
      expect(errors).toEqual([]);
    } finally {
      release();
      controllers.forEach((controller) => controller.abort());
      await Promise.all(tasks);
    }
    expect(f.hub.stats().retainedBytes).toBe(0);
  });
  it('counts shared live and recorder buffers once while a commit is in progress', async () => {
    let release!: () => void,
      committing = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(),
      controller = new AbortController();
    const recording = f.hub.capture(
      subject,
      {
        commit: async () => {
          committing = true;
          await gate;
          return {} as Segment;
        },
      },
      controller.signal,
    );
    const finished = Promise.allSettled([recording]);
    try {
      await vi.waitFor(() => expect(committing).toBe(true));
      expect(f.hub.stats().retainedBytes).toBe(128);
    } finally {
      release();
      controller.abort();
      await finished;
    }
  });
  it('gives each recording subject its own serial media slot while slow subjects remain blocked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Map<number, number>(),
      peak = new Map<number, number>();
    const committed = new Set<number>();
    const f = fixture({
      fetch: async (input) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
        if (url.pathname.endsWith('.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment-1.mp4\n#EXTINF:2,\nsegment-2.mp4\n',
          );
        const id = Number(url.pathname.split('/')[2]);
        const count = (active.get(id) ?? 0) + 1;
        active.set(id, count);
        peak.set(id, Math.max(peak.get(id) ?? 0, count));
        try {
          if (id !== 3) await gate;
          return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
        } finally {
          active.set(id, (active.get(id) ?? 1) - 1);
        }
      },
    });
    const controllers = [1, 2, 3].map(() => new AbortController());
    const recordings = controllers.map((controller, index) =>
      f.hub.capture(
        { ...subject, id: `stripchat:${index + 1}`, providerId: index + 1 },
        {
          commit: async () => {
            committed.add(index + 1);
            return {} as Segment;
          },
        },
        controller.signal,
      ),
    );
    const finished = Promise.allSettled(recordings);
    try {
      await vi.waitFor(() => expect(committed.has(3)).toBe(true));
      expect(committed.has(1)).toBe(false);
      expect(committed.has(2)).toBe(false);
      release();
      await vi.waitFor(() => expect(committed.size).toBe(3));
      expect([...peak.values()]).toEqual([1, 1, 1]);
      expect(f.hub.stats().retainedBytes).toBeLessThanOrEqual(f.hub.stats().maxBytes);
    } finally {
      release();
      for (const controller of controllers) controller.abort();
      await finished;
    }
  });
  it('recovers a playlist deadline through the same route recovery as a fragment deadline', async () => {
    let slowPlaylists = 0;
    const selected: string[] = [];
    const f = fixture({
      hlsEdges: ['slow.invalid', 'fast.invalid'],
      allowedMediaHosts: ['slow.invalid', 'fast.invalid'],
      onCdnSelected: (_id, host) => selected.push(host),
      fetch: async (input) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
        if (url.pathname.endsWith('.m3u8')) {
          if (url.hostname === 'slow.invalid' && slowPlaylists++ > 0)
            throw new ProviderError('request-deadline');
          return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.mp4\n');
        }
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const lease = await f.hub.acquire(subject);
    try {
      await vi.waitFor(() => expect(selected).toContain('fast.invalid'), { timeout: 2000 });
      expect(slowPlaylists).toBe(2);
      expect(lease.snapshot().playlist.segments).toHaveLength(1);
    } finally {
      lease.release();
    }
  });
  it('allows a slow fragment to finish within the retained playlist window', async () => {
    vi.useFakeTimers();
    const f = fixture({
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
        if (url.includes('.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.mp4\n#EXTINF:2,\nsegment-2.mp4\n',
          );
        await new Promise((resolve) => setTimeout(resolve, 3200));
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const controller = new AbortController();
    let ready = false;
    const outcome = f.hub.acquire(subject, controller.signal).then(
      (lease) => {
        ready = true;
        lease.release();
      },
      (error: unknown) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(3500);
      expect(ready).toBe(true);
    } finally {
      controller.abort();
      // The synthetic transport ignores cancellation; drain the queued serial request too.
      await vi.advanceTimersByTimeAsync(4000);
      await outcome;
      await f.hub.close();
      vi.useRealTimers();
    }
  });
  it('hands a fragment deadline to route recovery without repeating the expired request', async () => {
    const failedRequests: string[] = [];
    const f = fixture({
      hlsEdges: ['slow.invalid', 'fast.invalid'],
      allowedMediaHosts: ['slow.invalid', 'fast.invalid'],
      fetch: async (input) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
        if (url.pathname.endsWith('.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.mp4\n');
        if (url.hostname === 'slow.invalid') {
          failedRequests.push(url.pathname);
          throw new ProviderError('request-deadline');
        }
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const lease = await f.hub.acquire(subject);
    try {
      expect(failedRequests).toEqual(['/hls/42/master/segment-1.mp4']);
      expect(lease.snapshot().playlist.segments).toHaveLength(1);
    } finally {
      lease.release();
    }
  });
  it('keeps source identity when reconnecting the same rendition with a changed bitrate estimate', async () => {
    let bandwidth = 4000000;
    const f = fixture({
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response(
            `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=1920x1080\nmain.m3u8\n`,
          );
        if (url.includes('.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.mp4\n#EXTINF:2,\nsegment-2.mp4\n',
          );
        if (url.endsWith('segment-2.mp4') && bandwidth === 4000000) {
          bandwidth = 4100000;
          return new Response('', { status: 403 });
        }
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const controller = new AbortController();
    const commit = vi.fn<(input: CommitInput) => Promise<Segment>>(async () => ({}) as Segment);
    const recording = f.hub.capture(subject, { commit }, controller.signal);
    try {
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
      expect(commit.mock.calls.map(([input]) => input.sourceSequence)).toEqual(['1', '2']);
      expect(commit.mock.calls[1][0].sourceEpoch).toBe(commit.mock.calls[0][0].sourceEpoch);
      expect(commit.mock.calls[1][0].discontinuity).toBe(false);
    } finally {
      controller.abort();
      await Promise.allSettled([recording]);
    }
  });
  it.each([
    { manual: false, ended: false },
    { manual: true, ended: false },
    { manual: false, ended: true },
  ])(
    'handles sustained slow media with manual=$manual, ended=$ended',
    async ({ manual, ended }) => {
      const mediaHosts: string[] = [];
      const f = fixture({
        hlsEdges: ['slow.invalid', 'fast.invalid'],
        allowedMediaHosts: ['slow.invalid', 'fast.invalid'],
        preferredCdn: () => (manual ? 'slow.invalid' : null),
        fetch: async (input) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.pathname.includes('_auto.m3u8')) {
            if (url.hostname === 'fast.invalid')
              await new Promise((resolve) => setTimeout(resolve, 20));
            return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
          }
          if (url.pathname.endsWith('.m3u8'))
            return new Response(
              '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:0.01,\nsegment-1.mp4\n#EXTINF:0.01,\nsegment-2.mp4\n#EXTINF:0.01,\nsegment-3.mp4\n#EXTINF:0.01,\nsegment-4.mp4\n' +
                (ended ? '#EXT-X-ENDLIST\n' : ''),
            );
          mediaHosts.push(url.hostname);
          if (url.hostname === 'slow.invalid')
            await new Promise((resolve) => setTimeout(resolve, 50));
          return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
        },
      });
      const controller = new AbortController();
      const recording = f.hub.capture(
        subject,
        { commit: async () => ({}) as Segment },
        controller.signal,
      );
      const lease = await f.hub.acquire(subject);
      try {
        await vi.waitFor(() => expect(lease.snapshot().playlist.segments).toHaveLength(4));
        expect(new Set(mediaHosts)).toEqual(new Set(['slow.invalid']));
        expect(lease.snapshot().playlist.segments.map((s) => s.sequence)).toEqual([
          '1',
          '2',
          '3',
          '4',
        ]);
      } finally {
        controller.abort();
        lease.release();
        await Promise.allSettled([recording]);
      }
    },
  );
  it('admits more than thirty-two subjects while their media fits the shared budget', async () => {
    const f = fixture({ reloadMs: 60000 });
    const leases = [];
    try {
      for (let id = 1; id <= 33; id++) {
        leases.push(await f.hub.acquire({ ...subject, id: `stripchat:${id}`, providerId: id }));
      }
      expect(f.hub.stats().subjects).toBe(33);
      expect(f.hub.stats().retainedBytes).toBeLessThan(f.hub.stats().maxBytes);
    } finally {
      for (const lease of leases) lease.release();
    }
  });
  it('changes manual CDN between segments without releasing the viewer or its buffered media', async () => {
    let host = 'first.invalid';
    const f = fixture({
      hlsEdges: ['first.invalid', 'second.invalid'],
      allowedMediaHosts: ['first.invalid', 'second.invalid'],
      preferredCdn: () => host,
    });
    const lease = await f.hub.acquire(subject);
    try {
      const first = lease.snapshot().playlist.segments[0];
      host = 'second.invalid';
      f.advance();
      f.hub.changeCdn();
      await vi.waitFor(() =>
        expect(
          f.requests.some(
            (url) => url.startsWith('https://second.invalid/') && url.includes('_auto.m3u8'),
          ),
        ).toBe(true),
      );
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments).toHaveLength(2));
      expect(lease.media(first.address)).toHaveLength(64);
      expect(lease.snapshot().playlist.segments.map((segment) => segment.sequence)).toEqual([
        '1',
        '2',
      ]);
    } finally {
      lease.release();
    }
  });
  it('cancels both producers on the old CDN before the selected CDN is ready', async () => {
    let host = 'first.invalid',
      sequence = 1;
    let releaseNew!: () => void;
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const oldStarted = vi.fn();
    const oldCancelled = vi.fn();
    const f = fixture({
      hlsEdges: ['first.invalid', 'second.invalid'],
      allowedMediaHosts: ['first.invalid', 'second.invalid'],
      preferredCdn: () => host,
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname.includes('_auto.m3u8')) {
          if (url.hostname === 'second.invalid') await newGate;
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
        }
        if (url.pathname.endsWith('.m3u8'))
          return new Response(
            `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,\nsegment-${sequence}.mp4\n`,
          );
        if (url.hostname === 'first.invalid' && url.pathname.endsWith('segment-2.mp4')) {
          oldStarted();
          await new Promise<void>((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => {
                oldCancelled();
                reject(new ProviderError('cancelled'));
              },
              { once: true },
            );
          });
        }
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const controller = new AbortController();
    const commits = Array.from({ length: 2 }, () =>
      vi.fn<(input: CommitInput) => Promise<Segment>>(() => Promise.resolve({} as Segment)),
    );
    const recordings = Promise.allSettled(
      commits.map((commit, index) =>
        f.hub.capture(
          { ...subject, id: `stripchat:${42 + index}`, providerId: 42 + index },
          { commit },
          controller.signal,
        ),
      ),
    );
    try {
      await vi.waitFor(() => commits.forEach((commit) => expect(commit).toHaveBeenCalledTimes(1)));
      sequence = 2;
      await vi.waitFor(() => expect(oldStarted).toHaveBeenCalledTimes(2));
      host = 'second.invalid';
      f.hub.changeCdn();
      await vi.waitFor(() => expect(oldCancelled).toHaveBeenCalledTimes(2));
      for (const commit of commits) expect(commit).toHaveBeenCalledTimes(1);
      releaseNew();
      await vi.waitFor(() => commits.forEach((commit) => expect(commit).toHaveBeenCalledTimes(2)));
      for (const commit of commits) {
        expect(commit.mock.calls.map(([frame]) => frame.sourceSequence)).toEqual(['1', '2']);
        expect(commit.mock.calls[1][0].discontinuity).toBe(true);
        expect(commit.mock.calls[1][0].sourceEpoch).toBe(commit.mock.calls[0][0].sourceEpoch);
      }
    } finally {
      releaseNew();
      controller.abort();
      await recordings;
    }
  });

  it('publishes actual opening stages and the confirmed privacy stop cause', async () => {
    const f = fixture({ publicCheckMs: 5 });
    const stages: LiveProgress[] = [];
    const detach = f.hub.subscribe!(() => {
      const value = f.hub.progress!(subject.id);
      if (value) stages.push(value);
    });
    const lease = await f.hub.acquire(subject);
    try {
      expect(stages.map((item) => item.phase)).toEqual([
        'checking',
        'resolving',
        'buffering',
        'ready',
      ]);
      f.private();
      await vi.waitFor(() =>
        expect(f.hub.progress!(subject.id)).toEqual({ phase: 'stopped', reason: 'private' }),
      );
      expect(() => lease.snapshot()).toThrow('live_not_public');
    } finally {
      detach();
      lease.release();
    }
  });
  it.each(['request-deadline', 'site-deadline'])(
    'keeps the producer through a transient status %s while public evidence remains valid',
    async (code) => {
      const f = fixture({ publicCheckMs: 5, publicLeaseMs: 2000 });
      const lease = await f.hub.acquire(subject);
      try {
        f.provider.status.mockRejectedValueOnce(new ProviderError(code));
        f.advance();
        await vi.waitFor(() =>
          expect(f.provider.status.mock.calls.length).toBeGreaterThanOrEqual(3),
        );
        expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('2');
        expect(f.hub.progress!(subject.id)?.phase).toBe('ready');
      } finally {
        lease.release();
      }
    },
  );
  it('does not interrupt media for one false OFFLINE response followed by PUBLIC', async () => {
    const f = fixture({ publicCheckMs: 5 });
    const lease = await f.hub.acquire(subject);
    try {
      f.provider.status.mockResolvedValueOnce('OFFLINE');
      f.advance();
      await vi.waitFor(() => expect(f.provider.status.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('2');
    } finally {
      lease.release();
    }
  });
  it('expires PUBLIC evidence when subsequent status observations stay UNKNOWN', async () => {
    const f = fixture({ publicCheckMs: 5, publicLeaseMs: 100 });
    const lease = await f.hub.acquire(subject);
    f.provider.status.mockResolvedValue('UNKNOWN');
    try {
      await vi.waitFor(() => expect(() => lease.snapshot()).toThrow('public-evidence-expired'), {
        timeout: 1000,
      });
    } finally {
      lease.release();
    }
  });
  it('keeps publishing while a periodic status check is slow but existing PUBLIC evidence is fresh', async () => {
    const f = fixture({ publicCheckMs: 5 });
    let release!: (value: 'PUBLIC') => void;
    const gate = new Promise<'PUBLIC'>((resolve) => {
      release = resolve;
    });
    f.provider.status.mockImplementationOnce(async () => 'PUBLIC').mockImplementation(() => gate);
    const lease = await f.hub.acquire(subject);
    try {
      await vi.waitFor(() => expect(f.provider.status).toHaveBeenCalledTimes(2));
      f.advance();
      await vi.waitFor(
        () => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('2'),
        { timeout: 200 },
      );
    } finally {
      release('PUBLIC');
      lease.release();
    }
  });
  it('retains bounded PUBLIC evidence across one UNKNOWN observation instead of killing the producer', async () => {
    const f = fixture({ publicCheckMs: 5 });
    const lease = await f.hub.acquire(subject);
    try {
      f.provider.status.mockResolvedValueOnce('UNKNOWN');
      await vi.waitFor(() => expect(f.provider.status.mock.results.length).toBeGreaterThan(1));
      f.advance();
      await vi.waitFor(
        () => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('2'),
        { timeout: 500 },
      );
    } finally {
      lease.release();
    }
  });
  it('retries the original fragment before refreshing a playlist that has already advanced', async () => {
    let sequence = 1,
      attempts = 0;
    const committed: string[] = [];
    const f = fixture({
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8\n');
        if (url.includes('.m3u8'))
          return new Response(
            `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-PROGRAM-DATE-TIME:${new Date(1700000000000 + sequence * 2000).toISOString()}\n#EXTINF:2,\nsegment-${sequence}.mp4\n${sequence === 3 ? '#EXT-X-ENDLIST\n' : ''}`,
          );
        if (url.endsWith('segment-1.mp4')) sequence = 2;
        if (url.endsWith('segment-2.mp4') && ++attempts === 1) {
          sequence = 3;
          return new Response('', { status: 404 });
        }
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    await f.hub.capture(
      subject,
      {
        commit: async (input) => {
          committed.push(input.sourceSequence);
          return {} as Segment;
        },
      },
      new AbortController().signal,
    );
    expect(committed).toEqual(['1', '2', '3']);
  });
  it('keeps the same viewer lease and resumes after an expired segment URL instead of discarding buffered frames', async () => {
    let sequence = 1,
      expired = false;
    const f = fixture({
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8\n');
        if (url.includes('.m3u8'))
          return new Response(
            `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,\nsegment-${sequence}.mp4\n`,
          );
        if (url.endsWith('segment-2.mp4')) {
          expired = true;
          sequence = 3;
          return new Response('', { status: 404 });
        }
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const lease = await f.hub.acquire(subject);
    try {
      const first = lease.snapshot().playlist.segments[0];
      sequence = 2;
      await vi.waitFor(() => expect(expired).toBe(true));
      expect(lease.media(first.address)).toHaveLength(64);
      await vi.waitFor(
        () => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('2'),
        { timeout: 3000 },
      );
      expect(lease.snapshot().playlist.segments.at(-1)?.discontinuity).toBe(true);
    } finally {
      lease.release();
    }
  });
  it('stages the next fragment without exceeding the subject media slot, then publishes in sequence order', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const f = fixture({
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8\n');
        if (url.includes('.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.mp4\n#EXTINF:2,\nsegment-2.mp4\n',
          );
        calls.push(url);
        if (url.endsWith('segment-1.mp4')) await gate;
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const opening = f.hub.acquire(subject);
    void opening.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(calls.some((url) => url.endsWith('segment-1.mp4'))).toBe(true));
      expect(calls.some((url) => url.endsWith('segment-2.mp4'))).toBe(false);
      release();
      const lease = await opening;
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments).toHaveLength(2));
      expect(lease.snapshot().playlist.segments.map((segment) => segment.sequence)).toEqual([
        '1',
        '2',
      ]);
      lease.release();
    } finally {
      release();
      await Promise.allSettled([opening]);
    }
  });
  it('starts the public-state cache at response completion after a slow status request', async () => {
    let now = 0;
    const status = vi.fn(async () => {
      now += 4400;
      return 'PUBLIC' as const;
    });
    const f = fixture({ provider: { status }, now: () => now }),
      lease = await f.hub.acquire(subject);
    try {
      expect(status).toHaveBeenCalledOnce();
    } finally {
      lease.release();
    }
  });
  it('reconnects a rejected fragment without extraction or account authentication', async () => {
    let sequence = 1,
      rejected = false;
    const f = fixture({
      keyLookup: () => 'synthetic-address-key',
      fetch: async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        expect(new Headers(init?.headers).has('cookie')).toBe(false);
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        if (url.includes('_auto.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-MOUFLON:PSCH:info:1:wanted\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8\n',
          );
        if (url.includes('.m3u8'))
          return new Response(
            `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,\nsegment-${sequence}.mp4\n`,
          );
        if (sequence === 2 && !rejected) {
          rejected = true;
          return new Response('', { status: 403 });
        }
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const lease = await f.hub.acquire(subject);
    try {
      sequence = 2;
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments).toHaveLength(2), {
        timeout: 3000,
      });
    } finally {
      lease.release();
    }
  });
  it('keeps serial downloads within a small memory budget', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      maxBytes: 18 * 1024 ** 2,
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8\n');
        if (url.includes('.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment-1.mp4\n#EXTINF:2,\nsegment-2.mp4\n',
          );
        if (url.endsWith('segment-1.mp4')) await gate;
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const opening = f.hub.acquire(subject);
    void opening.catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      const lease = await opening;
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments).toHaveLength(2));
      expect(f.hub.stats().retainedBytes).toBeLessThanOrEqual(18 * 1024 ** 2);
      lease.release();
    } finally {
      release();
      await Promise.allSettled([opening]);
    }
  });
  it('checks public state once for cold startup and serves warm viewers without proxy status requests', async () => {
    const f = fixture({ publicCheckMs: 10000 }),
      proxyStatus = vi.fn(async () => 'PUBLIC' as const);
    const live = createLiveProxy({
      archive: {
        getSubject: async (id: string) =>
          (await (async () => [subject])()).find((row) => row.id === id) ?? null,
      },
      provider: { status: proxyStatus },
      ingress: f.hub,
    });
    try {
      const first = await live.create('a', subject.id),
        second = await live.create('b', subject.id);
      const manifest = await live.manifest('a', first.sessionId);
      const token = [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)].at(-1)![1];
      await live.media('a', first.sessionId, token, async (bytes) => {
        expect(bytes.length).toBe(64);
      });
      expect(await live.manifest('b', second.sessionId)).toContain('#EXTM3U');
      expect(f.provider.status).toHaveBeenCalledOnce();
      expect(proxyStatus).not.toHaveBeenCalled();
    } finally {
      await live.close();
    }
  });
  it.each([503, 404, 410])(
    'recovers HTTP %i without ending the recording or changing its source identity',
    async (status) => {
      let sequence = 1,
        failures = 0;
      const requests: string[] = [];
      const f = fixture({
        fetch: async (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          requests.push(url);
          if (url.includes('_auto.m3u8'))
            return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
          if (url.includes('.m3u8'))
            return new Response(
              `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,\nsegment-${sequence}.mp4\n`,
            );
          if (url.endsWith('segment-2.mp4') && failures++ === 0)
            return new Response('', { status });
          return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
        },
      });
      const controller = new AbortController(),
        commit = vi.fn<(input: CommitInput) => Promise<Segment>>(async () => ({}) as Segment);
      const recording = f.hub.capture(subject, { commit }, controller.signal),
        lease = await f.hub.acquire(subject);
      try {
        await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
        sequence = 2;
        await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
        expect(commit.mock.calls.map(([input]) => input.sourceSequence)).toEqual(['1', '2']);
        expect(commit.mock.calls[1][0].sourceEpoch).toBe(commit.mock.calls[0][0].sourceEpoch);
        expect(commit.mock.calls[1][0].discontinuity).toBe(false);
        expect(lease.snapshot().playlist.segments.map((segment) => segment.sequence)).toEqual([
          '1',
          '2',
        ]);
        expect(requests.filter((url) => url.endsWith('segment-2.mp4'))).toHaveLength(2);
      } finally {
        controller.abort();
        lease.release();
        await Promise.allSettled([recording]);
      }
    },
  );
  it('recovers a timed out public check while preserving the recording epoch', async () => {
    let now = 0,
      calls = 0;
    const status = vi.fn(async () => {
      if (++calls === 2) throw new ProviderError('request-deadline');
      return 'PUBLIC' as const;
    });
    const f = fixture({ provider: { status }, publicCheckMs: 1, now: () => now });
    const controller = new AbortController(),
      commit = vi.fn<(input: CommitInput) => Promise<Segment>>(async () => ({}) as Segment);
    const recording = f.hub.capture(subject, { commit }, controller.signal),
      lease = await f.hub.acquire(subject);
    try {
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      now = 2;
      f.advance();
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
      // Publication no longer waits for the independent status retry to finish.
      await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
      expect(commit.mock.calls[1][0].sourceEpoch).toBe(commit.mock.calls[0][0].sourceEpoch);
    } finally {
      controller.abort();
      lease.release();
      await Promise.allSettled([recording]);
    }
  });
  it.each([
    { status: 503, attempts: 3 },
    { status: 403, attempts: 1 },
  ])('bounds reconnection when HTTP $status never recovers', async ({ status, attempts }) => {
    let requests = 0;
    const f = fixture({
      firstSegmentDeadlineMs: 1200,
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('_auto.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
        if (url.includes('.m3u8'))
          return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment.mp4\n');
        requests++;
        return new Response('', { status });
      },
    });
    await expect(f.hub.acquire(subject)).rejects.toMatchObject({ code: 'capture-stalled' });
    expect(requests).toBeGreaterThanOrEqual(attempts);
    expect(f.hub.stats().retainedBytes).toBe(0);
  });
  it('starts a cold viewer at the live edge without downloading the old playlist window', async () => {
    const requests: string[] = [];
    const f = fixture({
      fetch: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requests.push(url);
        if (url.includes('_auto.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nmain.m3u8\n',
          );
        if (url.includes('.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n' +
              Array.from(
                { length: 100 },
                (_, index) => `#EXTINF:2,\nsegment-${index + 1}.mp4\n`,
              ).join(''),
          );
        return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
      },
    });
    const lease = await f.hub.acquire(subject);
    try {
      await vi.waitFor(() =>
        expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('100'),
      );
      expect(lease.snapshot().playlist.segments.map((segment) => segment.sequence)).toEqual([
        '98',
        '99',
        '100',
      ]);
      expect(
        requests.filter((url) => /segment-\d+\.mp4$/.test(url)).map((url) => url.split('/').at(-1)),
      ).toEqual(['segment-98.mp4', 'segment-99.mp4', 'segment-100.mp4']);
    } finally {
      lease.release();
    }
  });
  it('downloads a segment once for two owners and a slow recorder, without waiting for archive commit', async () => {
    const f = fixture(),
      controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(async () => {
      await gate;
      return {} as Segment;
    });
    const recording = f.hub.capture(subject, { commit }, controller.signal);
    const live = createLiveProxy({
      archive: {
        getSubject: async (id: string) =>
          (await (async () => [subject])()).find((row) => row.id === id) ?? null,
      },
      provider: f.provider,
      ingress: f.hub,
    });
    try {
      const [a, b] = await Promise.all([
        live.create('a', subject.id),
        live.create('b', subject.id),
      ]);
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      f.advance();
      await vi.waitFor(() =>
        expect(f.requests.filter((url) => url.endsWith('segment-2.mp4'))).toHaveLength(1),
      );
      const manifest = await live.manifest('b', b.sessionId);
      expect(manifest).toContain('#EXT-X-MEDIA-SEQUENCE:1');
      const token = [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)].at(-1)![1];
      await live.media('b', b.sessionId, token, async (bytes) => {
        expect(bytes.length).toBe(64);
      });
      expect(f.requests.filter((url) => url.includes('_auto.m3u8'))).toHaveLength(1);
      expect(f.requests.filter((url) => url.endsWith('segment-1.mp4'))).toHaveLength(1);
      expect(commit).toHaveBeenCalledTimes(1);
      await live.destroy('a', a.sessionId);
      expect(await live.manifest('b', b.sessionId)).toContain('#EXTM3U');
    } finally {
      release();
      controller.abort();
      await Promise.allSettled([recording, live.close()]);
    }
  });
  it('fails an overflowing recorder explicitly while the bounded live ring continues', async () => {
    const f = fixture({ recordingQueueSegments: 1, ringSegments: 2 }),
      controller = new AbortController();
    const committed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recording = f.hub.capture(
      subject,
      {
        commit: async (input) => {
          await gate;
          committed.push(input.sourceSequence);
          return {} as Segment;
        },
      },
      controller.signal,
    );
    const failed = expect(recording).rejects.toThrow('recording-backpressure');
    const lease = await f.hub.acquire(subject);
    try {
      f.advance();
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('2'));
      f.advance();
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('3'));
      release();
      await failed;
      expect(committed).toEqual(['1', '2']);
      f.advance();
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('4'));
      expect(lease.snapshot().playlist.segments).toHaveLength(2);
      expect(f.hub.stats().retainedBytes).toBeLessThanOrEqual(f.hub.stats().maxBytes);
    } finally {
      release();
      controller.abort();
      lease.release();
      await Promise.allSettled([recording]);
    }
  });
  it('invalidates retained live bytes on a public-to-private transition', async () => {
    const f = fixture({ publicCheckMs: 1 }),
      lease = await f.hub.acquire(subject);
    const key = lease.snapshot().playlist.segments[0].address;
    f.private();
    await vi.waitFor(() => expect(() => lease.snapshot()).toThrow('live_not_public'));
    expect(() => lease.media(key)).toThrow('live_not_public');
    lease.release();
  });
  it.each(['PRIVATE', 'OFFLINE'] as const)(
    'continues public checks after ENDLIST and revokes viewers on %s',
    async (blocked) => {
      let state: 'PUBLIC' | typeof blocked = 'PUBLIC';
      const status = vi.fn(async () => state);
      // Exercise ENDLIST revocation without waiting the production recovery
      // window. Confirmation remains the shared service's real implementation.
      const evidence = new StatusEvidence({
        provider: { status },
        intervalMs: () => 1,
        offlineConfirmations: 1,
        recoveryWindowMs: 0,
      });
      evidenceServices.push(evidence);
      const f = fixture({
        evidence,
        provider: { status },
        publicCheckMs: 1,
        stallTimeoutMs: 20,
        fetch: async (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.includes('_auto.m3u8'))
            return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nmain.m3u8\n');
          if (url.includes('.m3u8'))
            return new Response(
              '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nsegment.mp4\n#EXT-X-ENDLIST\n',
            );
          return new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } });
        },
      });
      const lease = await f.hub.acquire(subject),
        live = createLiveProxy({
          archive: {
            getSubject: async (id: string) =>
              (await (async () => [subject])()).find((row) => row.id === id) ?? null,
          },
          provider: f.provider,
          ingress: f.hub,
        });
      try {
        const a = await live.create('a', subject.id),
          b = await live.create('b', subject.id);
        const manifest = await live.manifest('b', b.sessionId);
        expect(manifest).toContain('#EXT-X-ENDLIST');
        const token = [...manifest.matchAll(/\/media\/([0-9a-f-]+)\.mp4/g)].at(-1)![1];
        const commit = vi.fn(async () => ({}) as Segment);
        await f.hub.capture(subject, { commit }, new AbortController().signal);
        expect(commit).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(5));
        expect(lease.snapshot().playlist.ended).toBe(true);
        state = blocked;
        await vi.waitFor(() => expect(() => lease.snapshot()).toThrow('live_not_public'));
        await expect(live.manifest('a', a.sessionId)).rejects.toMatchObject({
          code: 'live_not_public',
        });
        const deliver = vi.fn(async () => undefined);
        await expect(live.media('b', b.sessionId, token, deliver)).rejects.toMatchObject({
          code: 'live_not_public',
        });
        expect(deliver).not.toHaveBeenCalled();
        await expect(live.create('c', subject.id)).rejects.toMatchObject({
          code: 'live_not_public',
        });
      } finally {
        lease.release();
        await live.close();
      }
    },
  );
  it('replaces a failed producer after it drains even when an old browser lease still exists', async () => {
    const f = fixture({ publicCheckMs: 1 }),
      stale = await f.hub.acquire(subject);
    f.private();
    await vi.waitFor(() => expect(() => stale.snapshot()).toThrow('live_not_public'));
    f.public();
    const replacement = await f.hub.acquire(subject);
    try {
      expect(replacement.snapshot().playlist.segments).toHaveLength(1);
      expect(() => stale.snapshot()).toThrow('live_not_public');
      expect(f.requests.filter((url) => url.includes('_auto.m3u8'))).toHaveLength(2);
    } finally {
      stale.release();
      replacement.release();
    }
  });
  it('gives reused source sequences a new epoch when PDT proves a restart after a checkpoint', async () => {
    const f = fixture({
      sourceCheckpoint: async () => ({
        epoch: 'old-epoch',
        highestSequence: '100',
        lastWallStartMs: 1600000000000,
      }),
    });
    const controller = new AbortController(),
      commit = vi.fn<(input: CommitInput) => Promise<Segment>>(async () => ({}) as Segment);
    const recording = f.hub.capture(subject, { commit }, controller.signal);
    try {
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      const input = commit.mock.calls[0][0];
      expect(input.sourceEpoch).not.toBe('old-epoch');
    } finally {
      controller.abort();
      await Promise.allSettled([recording]);
    }
  });
  it('keeps checking durable restart evidence when the initial low sequence has the checkpoint PDT', async () => {
    const checkpointPdt = 1700000002000;
    const f = fixture({
      sourceCheckpoint: async () => ({
        epoch: 'old-epoch',
        highestSequence: '900',
        lastWallStartMs: checkpointPdt,
      }),
    });
    const controller = new AbortController(),
      commit = vi.fn<(input: CommitInput) => Promise<Segment>>(async () => ({}) as Segment);
    const recording = f.hub.capture(subject, { commit }, controller.signal),
      lease = await f.hub.acquire(subject);
    try {
      expect(commit).not.toHaveBeenCalled();
      f.advance();
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      expect(commit.mock.calls[0][0]).toMatchObject({
        sourceSequence: '2',
        wallStartMs: checkpointPdt + 2000,
      });
      expect(commit.mock.calls[0][0].sourceEpoch).not.toBe('old-epoch');
      expect(lease.snapshot().playlist.segments.map((segment) => segment.sequence)).toEqual([
        '1',
        '2',
      ]);
    } finally {
      controller.abort();
      lease.release();
      await Promise.allSettled([recording]);
    }
  });

  it('drains the current commit but starts no queued writes after recording cancellation', async () => {
    const f = fixture(),
      controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(async () => {
      await gate;
      return {} as Segment;
    });
    const recording = f.hub.capture(subject, { commit }, controller.signal),
      lease = await f.hub.acquire(subject);
    try {
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      f.advance();
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('2'));
      controller.abort();
      release();
      await expect(recording).rejects.toThrow('cancelled');
      expect(commit).toHaveBeenCalledTimes(1);
      f.advance();
      await vi.waitFor(() => expect(lease.snapshot().playlist.segments.at(-1)?.sequence).toBe('3'));
    } finally {
      release();
      controller.abort();
      lease.release();
      await Promise.allSettled([recording]);
    }
  });
});
