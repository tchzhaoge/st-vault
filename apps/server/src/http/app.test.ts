import { mkdtemp, rm, readFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openArchive } from '../archive/index.js';
import type { ArchivePort, PreviewsPort, ProviderPort, SupervisorPort } from '../ports.js';
import { buildApp } from './app.js';
import * as syncModule from './sync.js';
import { KeyVault } from './key-vault.js';
import { LocalAuth } from './auth.js';
import type { MediaDeletePlan, NetworkRoutesStatus, BackgroundTask } from '@st-vault/api-schema';
import { SettingsStore } from '../runtime/settings.js';
import { SiteRoutes } from '../provider/site-routes.js';
import { NetworkRouting } from '../network/network-routing.js';
import { ResourceMonitor } from '../runtime/resources.js';
import { ProviderError } from '../provider/http.js';
import { PreviewError } from '../previews/index.js';
import type { LiveProxy } from '../live/index.js';
import type { PersonalTimeline, SessionInfo } from '@st-vault/api-schema';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  previews?: PreviewsPort,
  live?: LiveProxy,
  now?: () => number,
  archiveHealth?: Parameters<typeof buildApp>[0]['archiveHealth'],
  _unused?: undefined,
  initialized = true,
): Promise<{
  root: string;
  app: FastifyInstance;
  archive: ArchivePort;
  vault: KeyVault;
  cookie: string;
  provider: ProviderPort;
  supervisor: SupervisorPort;
  resources: ResourceMonitor;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-http-'));
  const archive = await openArchive({ root });
  const vault = await KeyVault.open(root, archive);
  const auth = await LocalAuth.open(archive, now);
  const cookie = initialized
    ? auth.cookie(await auth.completeSetup('012345', await auth.beginSetup())).split(';')[0]
    : '';
  const settings = await SettingsStore.open(archive, {});
  const sites = new SiteRoutes({
    fetch: (input) =>
      Promise.resolve(
        Response.json(
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes('/api/front/models?')
            ? { models: [{ id: 42, isLive: true, status: 'public' }] }
            : { initialDynamic: {} },
        ),
      ),
  });
  const network = await NetworkRouting.open(archive, sites, {
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        !url.includes('.m3u8')
          ? new Response(new Uint8Array(262144), { headers: { 'content-type': 'video/mp2t' } })
          : new Response(
              url.includes('_auto.m3u8')
                ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8\n'
                : '#EXTM3U\n#EXTINF:2,\nsegment.ts\n',
            ),
      );
    },
  });
  const resources = new ResourceMonitor({
    root,
    archive,
    settings: settings.get,
    readDisk: () => Promise.resolve({ freeBytes: 10 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
  });
  await resources.check();
  const provider: ProviderPort = {
    importList: vi.fn(() =>
      Promise.resolve([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]),
    ),
    status: vi.fn(() => Promise.resolve('PUBLIC' as const)),
    capture: vi.fn(() => Promise.resolve()),
  };
  const supervisor: SupervisorPort = {
    reconcile: vi.fn(() => Promise.resolve()),
    states: () => ({}),
    close: vi.fn(() => Promise.resolve()),
  };
  const app = await buildApp({
    archive,
    provider,
    supervisor,
    vault,
    settings,
    network,
    resources,
    previews,
    live,
    now,
    archiveHealth,
  });
  cleanups.push(async () => {
    await app.close();
    await resources.close();
    sites.close();
    await network.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, app, archive, vault, cookie, provider, supervisor, resources };
}

describe('server integration boundaries', () => {
  it('authenticates batch favorite cancellation and reports stale revisions without partial changes', async () => {
    const { app, archive, cookie } = await fixture();
    const subjectId = 'stripchat:42';
    await archive.upsertSubjects([{ id: subjectId, providerId: 42, handle: 'fixture' }]);
    await archive.commit({
      subjectId,
      sourceEpoch: 'test',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 65000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const units = await archive.snapshotPages!(subjectId, 65000, 1, 30, {
      fromMs: 60000,
      toMs: 120000,
    });
    const saved = await archive.unitFavorites!(
      subjectId,
      units.items.map((unit) => unit.unitId),
      true,
      await archive.personalRevision(),
    );
    const payload = {
      unitIds: saved.favorites.map((favorite) => favorite.id),
      liked: false,
      revision: saved.revision,
    };
    const url = `/api/subjects/${subjectId}/unit-favorites`;
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { cookie },
          payload: { ...payload, unitIds: [] },
        })
      ).statusCode,
    ).toBe(400);
    const stale = await app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { ...payload, revision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'media_selection_stale' });
    expect((await archive.personal(subjectId, 0, 180000)).favorites).toHaveLength(1);
    const removed = await app.inject({ method: 'POST', url, headers: { cookie }, payload });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      removed: 1,
      revision: saved.revision + 1,
      favorites: [],
    });
    expect(removed.headers['cache-control']).toBe('private, no-store');
  });
  it('returns retryable service overload when metadata read admission is full', async () => {
    const { app, archive, cookie } = await fixture();
    vi.spyOn(archive, 'events').mockRejectedValue(new Error('METADATA_READ_BUSY'));
    const response = await app.inject({ url: '/api/events', headers: { cookie } });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toEqual({ error: 'archive_busy' });
  });
  it('reports saturated durable selection admission without disguising it as a storage failure', async () => {
    const { app, archive, cookie } = await fixture();
    vi.spyOn(archive, 'prepareMediaSelection').mockRejectedValue(
      new Error('MEDIA_SELECTION_QUEUE_FULL'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/subjects/stripchat:42/media-selection',
      headers: { cookie },
      payload: { fromMs: 0, toMs: 60000, mode: 'all' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toEqual({ error: 'archive_busy' });
  });
  it('does not grant the setup capability access to account credentials or synchronization', async () => {
    const { app, provider } = await fixture(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    const start = await app.inject({ method: 'POST', url: '/api/setup/session', payload: {} });
    const headers = { cookie: String(start.headers['set-cookie']).split(';')[0] };
    for (const route of [
      { method: 'GET' as const, url: '/api/account-sync' },
      { method: 'GET' as const, url: '/api/account-sync/avatar' },
      { method: 'GET' as const, url: '/api/sync' },
      {
        method: 'PUT' as const,
        url: '/api/account-sync',
        payload: { cookiesText: 'fixture=account' },
      },
    ])
      expect((await app.inject({ ...route, headers })).statusCode).toBe(401);
    expect(provider.importList).not.toHaveBeenCalled();
  });
  it('creates a PIN without connecting an account and confines the temporary setup capability', async () => {
    const { app } = await fixture(undefined, undefined, undefined, undefined, undefined, false);
    expect((await app.inject({ url: '/api/session' })).json<SessionInfo>()).toMatchObject({
      authenticated: false,
      setupRequired: true,
      setupAuthorized: false,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/setup', payload: { pin: '012345' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup/session',
          headers: { host: 'nas.local' },
          payload: {},
        })
      ).statusCode,
    ).toBe(412);
    const start = await app.inject({ method: 'POST', url: '/api/setup/session', payload: {} });
    expect(start.statusCode).toBe(200);
    const setupCookie = String(start.headers['set-cookie']).split(';')[0],
      headers = { cookie: setupCookie };
    expect(
      (await app.inject({ method: 'POST', url: '/api/setup/session', payload: {} })).statusCode,
    ).toBe(409);
    expect((await app.inject({ url: '/api/session', headers })).json<SessionInfo>()).toMatchObject({
      authenticated: false,
      setupAuthorized: true,
    });
    for (const [method, url] of [
      ['GET', '/api/subjects'],
      ['GET', '/api/keys'],
      ['GET', '/api/system'],
      ['GET', '/api/events'],
      ['DELETE', '/api/account-sync'],
      ['POST', '/api/subjects/stripchat:42/deletion-intents'],
    ] as const) {
      expect((await app.inject({ method, url, headers })).statusCode, `${method} ${url}`).toBe(401);
    }
    for (const pin of ['12345', '1234567', '１２３４５６', '12345x'])
      expect(
        (await app.inject({ method: 'POST', url: '/api/setup', headers, payload: { pin } }))
          .statusCode,
      ).toBe(400);
    const complete = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers,
      payload: { pin: '012345' },
    });
    expect(complete.statusCode).toBe(200);
    const admin = String(complete.headers['set-cookie']).split(';')[0];
    expect((await app.inject({ url: '/api/account-sync', headers })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/session', headers: { cookie: admin } })).json<SessionInfo>(),
    ).toMatchObject({
      authenticated: true,
      setupRequired: false,
      credential: 'pin',
      setupAuthorized: false,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/login', payload: { pin: '012345' } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/setup/session', payload: {} })).statusCode,
    ).toBe(409);
  });

  it('returns a cooldown after repeated invalid PINs even from different addresses', async () => {
    const { app } = await fixture();
    for (let n = 0; n < 4; n++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            remoteAddress: `10.0.0.${n + 1}`,
            payload: { pin: '111111' },
          })
        ).statusCode,
      ).toBe(401);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { pin: '111111' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      (await app.inject({ method: 'POST', url: '/api/login', payload: { pin: '012345' } }))
        .statusCode,
    ).toBe(429);
  });
  it('authenticates preferences and measures CDN downloads only on manual request', async () => {
    const { app, cookie } = await fixture();
    expect((await app.inject({ url: '/api/network/routes' })).statusCode).toBe(401);
    const probeRequest = {
      method: 'POST' as const,
      url: '/api/network/probe',
      payload: { kind: 'cdn' },
    };
    expect((await app.inject(probeRequest)).statusCode).toBe(401);
    const headers = { cookie };
    const routes = async () =>
      (await app.inject({ url: '/api/network/routes', headers })).json<NetworkRoutesStatus>();
    const initial = await routes();
    expect(initial.preferences.cdnHost).toBe('edge-hls.doppiocdn.net');
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/network/routes',
      headers,
      payload: { cdnHost: 'edge-hls.doppiocdn.org' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<NetworkRoutesStatus>().preferences).toEqual({
      cdnHost: 'edge-hls.doppiocdn.org',
    });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/network/routes',
          headers,
          payload: { siteOrigin: 'https://127.0.0.1' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ ...probeRequest, headers })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      const status = await routes();
      expect(status.cdnProbe.completed).toBe(initial.cdnHosts.length);
      expect(status.cdnProbe.running).toBe(false);
      expect(status.cdnProbe.error).toBeNull();
      expect(Object.keys(status.cdnProbe.results)).toHaveLength(initial.cdnHosts.length);
      expect(Object.values(status.cdnProbe.results).every((node) => node.bytesPerSecond)).toBe(
        true,
      );
      expect(status.activeCdns).toEqual({});
      expect(status.preferences).toEqual(saved.json<NetworkRoutesStatus>().preferences);
    });
  });
  it('counts only established recordings in the system recording summary', async () => {
    const { app, cookie, supervisor } = await fixture();
    supervisor.states = () => ({
      'stripchat:1': 'CAPTURING',
      'stripchat:2': 'RESOLVING',
      'stripchat:3': 'STOPPING',
      'stripchat:4': 'BACKOFF',
    });
    const response = await app.inject({ url: '/api/system', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ capture: { active: number } }>().capture.active).toBe(1);
  });
  it('authenticates and validates bounded browser player diagnostics', async () => {
    const { app, cookie } = await fixture();
    const payload = {
      subjectId: 'stripchat:42',
      media: 'live',
      phase: 'network',
      ready: false,
      error: 'synthetic-timeout',
    };
    expect(
      (await app.inject({ method: 'POST', url: '/api/diagnostics/player', payload })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/diagnostics/player',
          headers: { cookie },
          payload,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/diagnostics/player',
          headers: { cookie },
          payload: { ...payload, error: 'x'.repeat(1025) },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('does not expose a manual former-name maintenance endpoint', async () => {
    const { app, cookie } = await fixture();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/subjects/stripchat:42/profile',
          headers: { cookie },
          payload: { nameNote: 'Former' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('authenticates bounded media batches, rejects stale confirmation, and reports explicit favorite deletion', async () => {
    const { app, archive, cookie } = await fixture();
    const id = 'stripchat:42';
    await archive.upsertSubjects([{ id, providerId: 42, handle: 'batch-fixture' }]);
    await archive.commit({
      subjectId: id,
      sourceEpoch: 'batch',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 65000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const url = `/api/subjects/${id}/delete-selection`;
    const unitId = (await archive.snapshotPages!(id, 65000, 1, 30, { fromMs: 60000, toMs: 120000 }))
      .items[0].unitId;
    expect((await app.inject({ url: '/api/media-deletions' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + '/preview',
          payload: { unitIds: [unitId] },
        })
      ).statusCode,
    ).toBe(401);
    const headers = { cookie };
    const legacyPlan = vi.spyOn(archive, 'planDeletion');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + '/preview',
          headers,
          payload: { ranges: [{ fromMs: 60000, toMs: 120000 }] },
        })
      ).statusCode,
    ).toBe(400);
    expect(legacyPlan).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + '/preview',
          headers,
          payload: { unitIds: Array(100001).fill(randomUUID()) },
        })
      ).statusCode,
    ).toBe(400);
    const preview = await app.inject({
      method: 'POST',
      url: url + '/preview',
      headers,
      payload: { unitIds: [unitId] },
    });
    expect(preview.statusCode).toBe(200);
    const plan = preview.json<MediaDeletePlan>();
    const favoriteUrl = `/api/subjects/${id}/unit-favorites`;
    const incomplete = await app.inject({
      method: 'POST',
      url: favoriteUrl,
      headers,
      payload: {
        unitIds: [unitId, randomUUID()],
        liked: true,
        revision: plan.personalRevision,
      },
    });
    expect(incomplete.statusCode).toBe(409);
    expect((await archive.personal(id, 0, 300000)).favorites).toHaveLength(0);
    for (const unitIds of [[], ['invalid-id']]) {
      const shifted = await app.inject({
        method: 'POST',
        url: favoriteUrl,
        headers,
        payload: { unitIds, liked: true, revision: plan.personalRevision },
      });
      expect(shifted.statusCode).toBe(400);
    }
    const liked = await app.inject({
      method: 'POST',
      url: favoriteUrl,
      headers,
      payload: { unitIds: [unitId], liked: true, revision: plan.personalRevision },
    });
    expect(liked.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { planId: plan.id, personalRevision: plan.personalRevision },
        })
      ).statusCode,
    ).toBe(409);
    const fresh = (
      await app.inject({
        method: 'POST',
        url: url + '/preview',
        headers,
        payload: { unitIds: [unitId] },
      })
    ).json<MediaDeletePlan>();
    expect(fresh.favoriteSegments).toBe(1);
    const deleted = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { planId: fresh.id, personalRevision: fresh.personalRevision },
    });
    expect(deleted.statusCode).toBe(202);
    expect(deleted.json<{ total: number }>().total).toBe(1);
    await archive.resumeDeletions!();
    const jobs = await app.inject({ url: '/api/media-deletions', headers });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json()).toEqual([
      expect.objectContaining({ subjectId: id, state: 'completed', total: 1, processed: 1 }),
    ]);
    expect(jobs.body).not.toContain('segmentIds');
  });
  it('keeps validation failures at HTTP 400 without accepting oversized or unknown input', async () => {
    const { app, cookie, vault, archive } = await fixture();
    const keys = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`key${index}`, 'synthetic-secret']),
    );
    const invalid = [
      { method: 'PUT' as const, url: '/api/settings', payload: {} },
      { method: 'PUT' as const, url: '/api/settings', payload: { maxConcurrent: 17 } },
      { method: 'PUT' as const, url: '/api/settings', payload: { pollMs: 5000, extra: true } },
      { method: 'PUT' as const, url: '/api/keys/current', payload: { keys } },
      {
        method: 'PUT' as const,
        url: '/api/keys/current',
        payload: { name: 'constructor', value: 'synthetic-secret' },
      },
      {
        method: 'PATCH' as const,
        url: '/api/subjects/policies',
        payload: { ids: Array.from({ length: 1001 }, () => null), policy: { autoRecord: true } },
      },
      {
        method: 'POST' as const,
        url: '/api/playback',
        payload: { subjectId: 'stripchat:42', targetUtcMs: 0, fromMs: 0, toMs: 10 * 86400000 },
      },
    ];
    for (const request of invalid) {
      const response = await app.inject({ ...request, headers: { cookie } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request' });
    }
    expect(vault.count).toBe(0);
    expect(await archive.listSubjects()).toEqual([]);
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
  });

  it('returns cached health failures promptly and exposes the reason without waiting for a stalled archive', async () => {
    let error: 'archive_timeout' | null = 'archive_timeout';
    const { app, archive, cookie } = await fixture(undefined, undefined, undefined, () => ({
      error,
      checkedAtMs: 1000,
      failures: 1,
      recovery: 'retrying',
    }));
    const probe = vi
      .spyOn(archive, 'getSetting')
      .mockImplementation(() => new Promise(() => undefined));
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
    expect(probe).not.toHaveBeenCalled();
    const system = await app.inject({ url: '/api/system', headers: { cookie } });
    expect(system.json<{ archiveHealth: { error: string } }>().archiveHealth.error).toBe(
      'archive_timeout',
    );
    error = null;
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    probe.mockRestore();
  });

  it('snaps drawn ranges to actual footage, supports long selections and never continues beyond their end', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    for (const [sequence, start] of [
      [1, 60000],
      [2, 3700000],
    ])
      await archive.commit({
        subjectId: 'stripchat:42',
        sourceEpoch: 'draw',
        sourceSequence: String(sequence),
        init: null,
        bytes: Buffer.from('clip'),
        durationSeconds: 60,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const bounds = await app.inject({
      url: '/api/subjects/stripchat:42/recording-bounds?from=0&to=7200000',
      headers: { cookie },
    });
    expect(bounds.headers['cache-control']).toBe('private, no-store');
    expect(bounds.json()).toEqual({ subjectId: 'stripchat:42', fromMs: 60000, toMs: 3760000 });
    const payload = {
      subjectId: 'stripchat:42',
      targetUtcMs: 0,
      fromMs: 0,
      toMs: 7200000,
      gapPolicy: 'next',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      rangeFromMs: 60000,
      rangeToMs: 3760000,
      nextAtMs: 3700000,
    });
    expect(first.json<{ segments: unknown[] }>().segments).toHaveLength(1);
    const last = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { ...payload, targetUtcMs: 3700000 },
    });
    expect(last.json()).toMatchObject({ rangeFromMs: 60000, rangeToMs: 3760000, nextAtMs: null });
    // Deleting the tail can leave the cursor after the last survivor. Resolve
    // inside the newly snapped bounds, rather than reporting a false empty range.
    const trimmed = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { ...payload, targetUtcMs: 6000000, gapPolicy: 'next-or-previous' },
    });
    expect(trimmed.statusCode).toBe(200);
    expect(trimmed.json()).toMatchObject({
      requestedAtMs: 6000000,
      actualAtMs: 3759999,
      rangeFromMs: 60000,
      rangeToMs: 3760000,
    });
    const empty = await app.inject({
      url: '/api/subjects/stripchat:42/recording-bounds?from=120000&to=3700000',
      headers: { cookie },
    });
    expect(empty.json()).toMatchObject({ fromMs: null, toMs: null });
    expect(
      (
        await app.inject({
          url: '/api/subjects/stripchat:42/recording-bounds?from=0&to=7200000',
        })
      ).statusCode,
    ).toBe(401);
  });
  it('resolves explicit snapshot navigation by unit identity and never falls back to a same-time unit', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    const segment = await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'identity',
      sourceSequence: '0',
      init: null,
      bytes: Buffer.from('clip'),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    const unitId = randomUUID();
    const source = vi.spyOn(archive, 'unitSource').mockResolvedValue(segment);
    const locate = vi.spyOn(archive, 'locate').mockResolvedValue(null);
    const payload = { subjectId: segment.subjectId, targetUtcMs: 61000, unitId };
    const opened = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload,
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json<{ segments: { id: string }[] }>().segments[0].id).toBe(segment.id);
    expect(source).toHaveBeenCalledWith(segment.subjectId, unitId, 61000);
    expect(locate).not.toHaveBeenCalledWith(segment.subjectId, 61000, expect.anything());
    source.mockResolvedValue(null);
    locate.mockResolvedValue(segment);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toEqual({ error: 'coverage_gap' });
    expect(locate).not.toHaveBeenCalledWith(segment.subjectId, 61000, expect.anything());
  });
  it('validates a full half-hour manifest within the archive object batch limit', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    const first = await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'full-window',
      sourceSequence: '0',
      init: Buffer.from('init'),
      bytes: Buffer.from('clip'),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    const segments = Array.from({ length: 900 }, (_, index) =>
      index === 0
        ? first
        : {
            ...first,
            id: randomUUID(),
            mediaObjectId: randomUUID(),
            sourceSequence: String(index),
            wallStartMs: 60000 + index * 2000,
            wallEndMs: 62000 + index * 2000,
          },
    );
    vi.spyOn(archive, 'locate').mockImplementation((_id, at, policy) =>
      Promise.resolve(
        segments.find((s) => s.wallStartMs! <= at && s.wallEndMs! > at) ??
          (policy === 'next'
            ? segments.find((s) => s.wallStartMs! >= at)
            : policy === 'previous'
              ? [...segments].reverse().find((s) => s.wallEndMs! <= at)
              : null) ??
          null,
      ),
    );
    vi.spyOn(archive, 'timeline').mockResolvedValue({
      subjectId: first.subjectId,
      fromMs: 60000,
      toMs: 1860000,
      segments,
      unlocatedCount: 0,
      truncated: false,
      revision: 1,
      nextCursor: null,
    });
    // Enforce the real archive contract without writing 900 fsynced test objects.
    const batches = vi.spyOn(archive, 'hasMedia').mockImplementation((ids) => {
      if (ids.length > 600) throw new Error('INVALID_MEDIA_BATCH');
      return Promise.resolve(true);
    });
    const opened = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { subjectId: first.subjectId, targetUtcMs: 60000, fromMs: 60000, toMs: 1860000 },
    });
    const { manifestUrl } = opened.json<{ manifestUrl: string }>();
    const manifest = await app.inject({ url: manifestUrl, headers: { cookie } });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body.match(/#EXTINF:/g)).toHaveLength(900);
    expect(
      batches.mock.calls.every(([ids]) => ids.length <= 600 && new Set(ids).size === ids.length),
    ).toBe(true);
    expect(batches.mock.calls.flatMap(([ids]) => ids)).toEqual(
      expect.arrayContaining([first.initObjectId!, ...segments.map((s) => s.mediaObjectId)]),
    );
    batches.mockClear();
    batches.mockImplementation((ids) =>
      Promise.resolve(!ids.includes(segments.at(-1)!.mediaObjectId)),
    );
    expect((await app.inject({ url: manifestUrl, headers: { cookie } })).statusCode).toBe(410);
    expect(batches).toHaveBeenCalledTimes(2);
  });
  it('renews active manifest sessions without collecting viewing history', async () => {
    let now = Date.now();
    const { app, archive, cookie } = await fixture(undefined, undefined, () => now);
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'slow',
      sourceSequence: '1',
      init: null,
      bytes: Buffer.from('slow'),
      durationSeconds: 10,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    const opened = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { subjectId: 'stripchat:42', targetUtcMs: 60000 },
    });
    const { manifestUrl } = opened.json<{ manifestUrl: string }>();
    for (let i = 0; i < 3; i++) {
      now += 20 * 60000;
      expect((await app.inject({ url: manifestUrl, headers: { cookie } })).statusCode).toBe(200);
    }
  });
  it('continues a growing selected unit after new commits without crossing its closed successor', async () => {
    const { app, archive, cookie } = await fixture();
    const id = 'stripchat:42';
    await archive.upsertSubjects([{ id, providerId: 42, handle: 'Growing' }]);
    await archive.setObservation(id, 'PUBLIC', 60000);
    const commit = (sequence: string, start: number) =>
      archive.commit({
        subjectId: id,
        sourceEpoch: 'growing',
        sourceSequence: sequence,
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 2,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const first = await commit('1', 62000);
    const open = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/playback', headers: { cookie }, payload });
    const initial = await open({
      subjectId: id,
      targetUtcMs: 62000,
      fromMs: 62000,
      toMs: 64000,
      gapPolicy: 'next',
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      openUnitId: first.id,
      nextAtMs: 64000,
      rangeToMs: 64000,
    });
    const tailRead = vi.spyOn(archive, 'unitRange');
    let settled = false;
    const continuation = open({
      subjectId: id,
      targetUtcMs: 64000,
      fromMs: 62000,
      toMs: 64001,
      openUnitId: first.id,
      gapPolicy: 'next',
    }).then((response) => {
      settled = true;
      return response;
    });
    await vi.waitFor(() => expect(tailRead).toHaveBeenCalledWith(id, first.id));
    expect(settled).toBe(false);
    const appended = await commit('2', 66000);
    const continued = await continuation;
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({
      actualAtMs: 66000,
      windowEndMs: 68000,
      rangeToMs: 68000,
      openUnitId: first.id,
      nextAtMs: 68000,
      segments: [expect.objectContaining({ id: appended.id })],
    });
    await archive.setObservation(id, 'OFFLINE', 69000);
    await commit('3', 70000);
    const ended = await open({
      subjectId: id,
      targetUtcMs: 68000,
      fromMs: 62000,
      toMs: 68001,
      openUnitId: first.id,
      gapPolicy: 'next',
    });
    expect(ended.statusCode).toBe(409);
    expect(ended.json()).toEqual({ error: 'coverage_gap' });
  });
  it('expands a drawn endpoint to the complete unit containing its last fragment', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'tail',
      sourceSequence: '1',
      init: null,
      bytes: Buffer.from('tail'),
      durationSeconds: 2,
      wallStartMs: 1859000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { subjectId: 'stripchat:42', targetUtcMs: 1859000, fromMs: 60000, toMs: 1860000 },
    });
    expect(result.json()).toMatchObject({ windowEndMs: 1861000, nextAtMs: null });
  });
  it('keeps separated footage islands in one bounded playback manifest', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    for (const [sequence, start] of [
      [1, 60000],
      [2, 90000],
      [3, 1860000],
    ])
      await archive.commit({
        subjectId: 'stripchat:42',
        sourceEpoch: 'islands',
        sourceSequence: String(sequence),
        init: null,
        bytes: Buffer.from(String(sequence)),
        durationSeconds: 2,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const opened = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { subjectId: 'stripchat:42', targetUtcMs: 60000, fromMs: 60000, toMs: 1860000 },
    });
    const body = opened.json<{ manifestUrl: string; segments: unknown[]; nextAtMs: number }>();
    expect(body.segments).toHaveLength(2);
    expect(body.nextAtMs).toBeNull();
    const manifest = await app.inject({ url: body.manifestUrl, headers: { cookie } });
    expect(manifest.body).toContain('#EXT-X-DISCONTINUITY');
    expect(manifest.body).not.toContain('#EXT-X-PROGRAM-DATE-TIME');
  });
  it('trims blank margins while bounding playback to the actual selection', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    for (const [sequence, start] of [
      [1, 60000],
      [2, 180000],
      [3, 1920000],
    ])
      await archive.commit({
        subjectId: 'stripchat:42',
        sourceEpoch: 'fixture',
        sourceSequence: String(sequence),
        init: null,
        bytes: Buffer.from(String(sequence)),
        durationSeconds: 60,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const body = {
      subjectId: 'stripchat:42',
      targetUtcMs: 65000,
      fromMs: 65000,
      toMs: 1865000,
      gapPolicy: 'next',
    };
    const open = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/playback', headers: { cookie }, payload });
    const result = await open(body);
    expect(result.statusCode).toBe(200);
    const first = result.json<{
      sessionId: string;
      nextAtMs: number;
      hasGapAfter: boolean;
      rangeFromMs: number;
      rangeToMs: number;
    }>();
    expect(first).toMatchObject({
      rangeFromMs: 60000,
      rangeToMs: 240000,
      nextAtMs: null,
      hasGapAfter: false,
    });
    const last = (await open({ ...body, targetUtcMs: 180000 })).json<{ nextAtMs: number | null }>();
    expect(last.nextAtMs).toBeNull();
    expect((await open({ ...body, targetUtcMs: 300000 })).statusCode).toBe(409);
    for (const payload of [
      { ...body, targetUtcMs: 1865000 },
      { ...body, toMs: body.fromMs + 10 * 86400000 },
      { ...body, fromMs: undefined },
    ])
      expect((await open(payload)).statusCode).toBe(400);
    const old = (await open({ subjectId: 'stripchat:42', targetUtcMs: 180000 })).json<{
      nextAtMs: number | null;
      segments: unknown[];
    }>();
    expect(old.nextAtMs).toBeNull();
    expect(old.segments).toHaveLength(2);
  });
  it('shares favorites and a stable administrator identity across logins', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    const second = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { pin: '012345' },
    });
    const secondCookie = String(second.headers['set-cookie']).split(';')[0];
    const get = async (owner: string) =>
      (await app.inject({ url: '/api/session', headers: { cookie: owner } })).json<SessionInfo>();
    const identity = await get(cookie);
    expect((await get(secondCookie)).userId).toBe(identity.userId);
    expect(identity.userId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await app.inject('/api/session')).json<SessionInfo>().userId).toBeUndefined();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/me/favorites',
          headers: { cookie },
          payload: { subjectId: 'stripchat:42', atMs: 65000 },
        })
      ).statusCode,
    ).toBe(404);
    const segment = await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'favorite-range',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 65000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const favorite = (
      await app.inject({
        method: 'POST',
        url: '/api/subjects/stripchat:42/unit-favorites',
        headers: { cookie },
        payload: {
          unitIds: [segment.id],
          liked: true,
          revision: await archive.personalRevision(),
        },
      })
    ).json<{ favorites: { id: string }[] }>().favorites[0];
    const query = '/api/me/favorites?subjectId=stripchat:42&from=60000&to=120000';
    const data = (
      await app.inject({ url: query, headers: { cookie: secondCookie } })
    ).json<PersonalTimeline>();
    expect(data.favorites[0].id).toBe(favorite.id);
    expect((await app.inject(query)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/me/favorites?subjectId=stripchat:42&from=9007199254740992&to=9007199254740994',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(400);
    await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect((await app.inject({ url: query, headers: { cookie: secondCookie } })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/me/favorites/${favorite.id}`,
          headers: { cookie: secondCookie },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: query, headers: { cookie: secondCookie } })).json<PersonalTimeline>()
        .favorites,
    ).toEqual([]);
  });
  it('does not expose retired viewing-history routes', async () => {
    const { app, cookie } = await fixture();
    expect(
      (
        await app.inject({
          url: '/api/me/watch-ranges?subjectId=stripchat:42&from=0&to=1000',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/me/watch-progress',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it('revokes live resources on logout even when browser cleanup cannot authenticate afterward', async () => {
    const live: LiveProxy = {
      create: vi.fn(),
      manifest: vi.fn(),
      media: vi.fn(),
      destroy: vi.fn(),
      destroyOwner: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    const f = await fixture(undefined, live);
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: f.cookie } }))
        .statusCode,
    ).toBe(200);
    expect(live.destroyOwner).toHaveBeenCalledOnce();
    expect(live.destroyOwner).toHaveBeenCalledWith(f.cookie.slice(f.cookie.indexOf('=') + 1));
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: '/api/live/00000000-0000-4000-8000-000000000000',
          headers: { cookie: f.cookie },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('authenticates images and precise snapshot points without unbounded listing or paths', async () => {
    const image = new Uint8Array([255, 216, 255, 217]);
    const previews: PreviewsPort = {
      cover: vi.fn(() => Promise.resolve(image)),
      snapshot: vi.fn(() => Promise.reject(new PreviewError('preview_not_found'))),
      snapshotPoint: vi.fn<PreviewsPort['snapshotPoint']>(() => Promise.resolve(null)),
      close: vi.fn(() => Promise.resolve()),
    };
    const { app, cookie } = await fixture(previews),
      base = '/api/subjects/stripchat:42';
    for (const route of [
      '/cover.jpg',
      '/snapshot-point?at=60000',
      '/snapshots/60000.jpg',
      '/snapshot-pages?at=60000&from=0&to=120000',
    ])
      expect((await app.inject({ url: base + route })).statusCode).toBe(401);
    expect(previews.cover).not.toHaveBeenCalled();
    expect(previews.snapshot).not.toHaveBeenCalled();
    const cover = await app.inject({ url: base + '/cover.jpg?version=1', headers: { cookie } });
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toBe('image/jpeg');
    expect(cover.headers['cache-control']).toBe('private, no-cache');
    const list = await app.inject({
      url: base + '/snapshot-point?at=60000',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toBeNull();
    expect(previews.snapshotPoint).toHaveBeenCalledWith(
      'stripchat:42',
      60000,
      expect.any(AbortSignal),
    );
    expect(
      (await app.inject({ url: base + '/snapshot-point?at=-1', headers: { cookie } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: base + '/snapshots/60001.jpg', headers: { cookie } })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: base + '/snapshots/60001.jpg?to=60001', headers: { cookie } }))
        .statusCode,
    ).toBe(400);
    const gap = await app.inject({ url: base + '/snapshots/60000.jpg', headers: { cookie } });
    expect(gap.statusCode).toBe(404);
    expect(gap.json()).toEqual({ error: 'preview_not_found' });
    expect(gap.headers['cache-control']).toBe('private, no-store');
    await app.close();
    expect(previews.close).toHaveBeenCalledOnce();
  });
  it('removes every official-site browser login API while keeping local administrator auth', async () => {
    const { app, cookie } = await fixture();
    const base = '/api/account/login-sessions/11111111-1111-4111-8111-111111111111';
    for (const route of [
      { method: 'GET' as const, url: '/api/account/login' },
      { method: 'POST' as const, url: '/api/account/import-list' },
      { method: 'POST' as const, url: '/api/account/login-sessions' },
      { method: 'GET' as const, url: base + '/status' },
      { method: 'GET' as const, url: base + '/frame' },
      { method: 'POST' as const, url: base + '/input' },
      { method: 'POST' as const, url: base + '/import' },
      { method: 'POST' as const, url: base + '/credentials' },
      { method: 'DELETE' as const, url: base },
    ])
      expect((await app.inject({ ...route, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toMatchObject({
      authenticated: true,
    });
  });
  it('accepts only pasted cookie configuration, rejecting password and verification submissions', async () => {
    const { app, cookie, provider } = await fixture();
    for (const payload of [
      { username: 'Fixture', password: 'synthetic' },
      { cookiesText: 'fixture=session', password: 'synthetic' },
      { cookiesText: 'fixture=session', otp: '123456' },
      { cookiesText: 'fixture=session', captcha: 'synthetic' },
    ]) {
      const result = await app.inject({
        method: 'PUT',
        url: '/api/account-sync',
        headers: { cookie },
        payload,
      });
      expect(result.statusCode).toBe(400);
    }
    expect(provider.importList).not.toHaveBeenCalled();
  });
  it('acknowledges durable local settings and policies while remote reconciliation is still pending', async () => {
    const { app, archive, cookie, supervisor } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    let release!: () => void;
    const remote = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(supervisor.reconcile).mockImplementation(() => remote);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const requests = (async () => {
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: '/api/subjects/stripchat:42/policy',
              headers: { cookie },
              payload: { autoRecord: true },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: '/api/subjects/policies',
              headers: { cookie },
              payload: { ids: ['stripchat:42'], policy: { autoRecord: false } },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/settings',
              headers: { cookie },
              payload: { pollMs: 2000 },
            })
          ).statusCode,
        ).toBe(200);
      })();
      await Promise.race([
        requests,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('LOCAL_WRITE_WAITED_FOR_REMOTE_POLL')), 2000);
        }),
      ]);
      expect(supervisor.reconcile).toHaveBeenCalledTimes(3);
      expect((await archive.listSubjects())[0].autoRecord).toBe(false);
      expect((await SettingsStore.open(archive, {})).get().pollMs).toBe(2000);
    } finally {
      release();
      if (timer) clearTimeout(timer);
    }
  });
  it('exposes one authenticated no-store sync API, requires safe transport to save and preserves local policy', async () => {
    const { app, archive, cookie, provider } = await fixture();
    const config = { cookiesText: 'synthetic-persistent-secret' };
    expect((await app.inject({ url: '/api/account-sync' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account-sync',
          headers: { cookie, host: 'nas.lan:10002' },
          remoteAddress: '192.0.2.3',
          payload: config,
        })
      ).statusCode,
    ).toBe(412);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account-sync',
          headers: { cookie, host: 'nas.lan:10002' },
          remoteAddress: '192.0.2.3',
          payload: { cookiesText: config.cookiesText },
        })
      ).statusCode,
    ).toBe(412);
    expect(provider.importList).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account-sync',
          headers: { cookie, origin: 'https://outside.invalid' },
          payload: config,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account-sync',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account-sync',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account-sync',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    await archive.upsertSubjects([
      { id: 'stripchat:42', providerId: 42, handle: 'Old name' },
      { id: 'stripchat:43', providerId: 43, handle: 'Retained target' },
    ]);
    await archive.setPolicy('stripchat:42', { monitorEnabled: false, autoRecord: true });
    const configured = await app.inject({
      method: 'PUT',
      url: '/api/account-sync',
      headers: { cookie, host: 'localhost:10002' },
      remoteAddress: '172.18.0.1',
      payload: config,
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      imported: 1,
      status: { connected: true, lastImportedCount: 1 },
    });
    expect(configured.headers['cache-control']).toBe('no-store, private');
    expect(configured.body).not.toContain(config.cookiesText);
    expect((await archive.listSubjects()).find((row) => row.id === 'stripchat:42')).toMatchObject({
      handle: 'Fixture',
      monitorEnabled: false,
      autoRecord: true,
    });
    expect((await archive.listSubjects()).some((row) => row.id === 'stripchat:43')).toBe(true);
    const invalidConfig = await app.inject({
      method: 'PUT',
      url: '/api/account-sync',
      headers: { cookie },
      payload: {},
    });
    expect(invalidConfig.statusCode).toBe(400);
    expect(provider.importList).toHaveBeenCalledTimes(1);
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/account-sync/refresh',
      headers: { cookie, host: 'nas.lan:10002' },
    });
    expect(refreshed.statusCode).toBe(404);
    expect(provider.importList).toHaveBeenCalledTimes(1);
    const metadata = await app.inject({
      url: '/api/account-sync',
      headers: { cookie, host: 'nas.lan:10002' },
    });
    expect(metadata.headers['cache-control']).toBe('no-store, private');
    expect(metadata.body).not.toContain(config.cookiesText);
    expect(metadata.json()).not.toHaveProperty('cookiesText');
    const insecureDisconnect = await app.inject({
      method: 'DELETE',
      url: '/api/account-sync',
      headers: { cookie, host: 'nas.lan:10002' },
      remoteAddress: '192.0.2.3',
    });
    expect(insecureDisconnect.statusCode).toBe(412);
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/account-sync',
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      draft: { cookiesText: config.cookiesText },
      status: { connected: false },
    });
    expect(removed.headers['cache-control']).toBe('no-store, private');
    expect(await archive.getSetting('private.sealed.account-sync')).toBe('null');
    expect(
      (await app.inject({ url: '/api/account-sync', headers: { cookie } })).json(),
    ).toMatchObject({ connected: false, nextAttemptMs: null });
    expect(await archive.listSubjects()).toHaveLength(2);
  });

  it('bounds cookie import and maps only known provider failures without exposing upstream detail', async () => {
    const { app, archive, cookie, provider } = await fixture();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account-sync',
          payload: { cookiesText: 'synthetic' },
        })
      ).statusCode,
    ).toBe(401);
    const request = (cookiesText: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/account-sync',
        headers: { cookie },
        payload: { cookiesText },
      });
    expect((await request('x'.repeat(65537))).statusCode).toBe(400);
    expect(provider.importList).not.toHaveBeenCalled();
    expect((await request('x'.repeat(65536))).statusCode).toBe(200);
    const failures: [Error, number, string][] = [
      [new ProviderError('invalid-cookies'), 400, 'cookies_invalid'],
      [new ProviderError('no-applicable-cookies'), 400, 'cookies_invalid'],
      [new ProviderError('account-session-unavailable'), 422, 'cookies_expired'],
      [new ProviderError('upstream-http', 401), 422, 'cookies_expired'],
      [new ProviderError('upstream-http', 403), 502, 'account_access_denied'],
      [new ProviderError('upstream-http', 500), 502, 'list_import_failed'],
      [new Error('sensitive-fixture-detail https://private.invalid/'), 502, 'list_import_failed'],
    ];
    for (const [error, status, code] of failures) {
      vi.mocked(provider.importList).mockRejectedValueOnce(error);
      const response = await request('synthetic');
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: code });
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.body).not.toContain('sensitive-fixture-detail');
      expect(response.body).not.toContain('https://');
    }
    expect(await archive.getSetting('cookies')).toBeNull();
  });

  it('removes synchronous range deletion so all user deletion follows durable plans', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    const remove = vi.spyOn(archive, 'deleteRange');
    const response = await app.inject({
      method: 'POST',
      url: '/api/subjects/stripchat:42/delete-range',
      headers: { cookie },
      payload: { fromMs: 0, toMs: 60000 },
    });
    expect(response.statusCode).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });

  it('revokes in-flight archive playback admission on logout', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'epoch',
      sourceSequence: '1',
      init: null,
      bytes: Buffer.from('fragment'),
      durationSeconds: 2,
      wallStartMs: 10000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locate = archive.locate.bind(archive);
    vi.spyOn(archive, 'locate').mockImplementationOnce(async (...args) => {
      enter();
      await gate;
      return locate(...args);
    });
    const pending = app
      .inject({
        method: 'POST',
        url: '/api/playback',
        headers: { cookie },
        payload: { subjectId: 'stripchat:42', targetUtcMs: 11000 },
      })
      .then((response) => response);
    try {
      await entered;
      expect(
        (await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })).statusCode,
      ).toBe(200);
      release();
      const result = await pending;
      expect(result.statusCode).toBe(409);
      expect(result.json()).toEqual({ error: 'playback_cancelled' });
    } finally {
      release();
    }
  });

  it('requires a session for both manifests and fragment bytes, revokes logout and rejects foreign origins', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    const segment = await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'epoch',
      sourceSequence: '1',
      init: Buffer.from('init'),
      bytes: Buffer.from('fragment'),
      durationSeconds: 2,
      wallStartMs: 10000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const mediaUrl = `/api/media/${segment.mediaObjectId}`;
    expect((await app.inject({ url: mediaUrl })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/subjects/stripchat:42/policy',
          headers: { cookie, origin: 'https://foreign.invalid' },
          payload: { autoRecord: true },
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect((await app.inject({ url: mediaUrl, headers: { cookie } })).statusCode).toBe(401);
  });

  it('does not consume playback quota when delayed archive reads finish after clients abort', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'aborted-playback',
      sourceSequence: '1',
      init: null,
      bytes: Buffer.from('synthetic-fragment'),
      durationSeconds: 2,
      wallStartMs: 10000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    let release!: () => void,
      allEntered!: () => void,
      allClosed!: () => void,
      entered = 0,
      closed = 0;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      starting = new Promise<void>((resolve) => {
        allEntered = resolve;
      });
    const disconnected = new Promise<void>((resolve) => {
      allClosed = resolve;
    });
    const locate = archive.locate.bind(archive);
    const spy = vi.spyOn(archive, 'locate').mockImplementation(async (id, target, policy) => {
      if (target === 11000) {
        entered++;
        if (entered === 50) allEntered();
        await gate;
      }
      return locate(id, target, policy);
    });
    const timeline = vi.spyOn(archive, 'timeline');
    const observe = (request: IncomingMessage, response: ServerResponse): void => {
      if (request.url === '/api/playback')
        response.once('close', () => {
          closed++;
          if (closed === 50) allClosed();
        });
    };
    app.server.on('request', observe);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const controllers = Array.from({ length: 50 }, () => new AbortController());
    const requests = controllers.map((controller) =>
      fetch(origin + '/api/playback', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ subjectId: 'stripchat:42', targetUtcMs: 11000 }),
        signal: controller.signal,
      }),
    );
    const settled = Promise.allSettled(requests);
    try {
      await starting;
      for (const controller of controllers) controller.abort();
      await settled;
      await disconnected;
      release();
      await Promise.allSettled(spy.mock.results.map((result) => result.value as Promise<unknown>));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(timeline).not.toHaveBeenCalled();
      spy.mockRestore();
      timeline.mockRestore();
      for (let index = 0; index < 50; index++) {
        const playback = await app.inject({
          method: 'POST',
          url: '/api/playback',
          headers: { cookie },
          payload: { subjectId: 'stripchat:42', targetUtcMs: 11000 },
        });
        expect(playback.statusCode).toBe(200);
      }
    } finally {
      release();
      spy.mockRestore();
      timeline.mockRestore();
      app.server.removeListener('request', observe);
    }
  });

  it('maps a UTC target into a bounded VOD window and serves valid HTTP byte ranges', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    const first = await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'epoch',
      sourceSequence: '1',
      init: Buffer.from('init'),
      bytes: Buffer.from('abcdefgh'),
      durationSeconds: 2,
      wallStartMs: 10000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const next = await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'epoch',
      sourceSequence: '2',
      init: Buffer.from('init'),
      bytes: Buffer.from('moredata'),
      durationSeconds: 2,
      wallStartMs: 15000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: true,
    });
    const play = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { subjectId: 'stripchat:42', targetUtcMs: 11000 },
    });
    expect(play.statusCode).toBe(200);
    const body = play.json<{
      manifestUrl: string;
      seekOffsetSeconds: number;
      actualAtMs: number;
    }>();
    expect(body).toMatchObject({ seekOffsetSeconds: 1, actualAtMs: 11000 });
    expect((await app.inject({ url: body.manifestUrl })).statusCode).toBe(401);
    const manifest = await app.inject({ url: body.manifestUrl, headers: { cookie } });
    expect(manifest.body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(manifest.body).toContain('#EXT-X-DISCONTINUITY');
    expect(manifest.body).not.toContain('#EXT-X-PROGRAM-DATE-TIME');
    expect(manifest.body).toContain(first.mediaObjectId);
    expect(manifest.body).toContain(next.mediaObjectId);
    expect(play.json()).toMatchObject({ nextAtMs: null, hasGapAfter: false });
    const ranged = await app.inject({
      url: `/api/media/${first.mediaObjectId}`,
      headers: { cookie, range: 'bytes=1-3' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('bcd');
    expect(ranged.headers['content-range']).toBe('bytes 1-3/8');
    const head = await app.inject({
      method: 'HEAD',
      url: `/api/media/${first.mediaObjectId}`,
      headers: { cookie },
    });
    expect(head.headers['content-length']).toBe('8');
    expect(head.body).toBe('');
    expect(
      (
        await app.inject({
          url: `/api/media/${first.mediaObjectId}`,
          headers: { cookie, range: 'bytes=9-' },
        })
      ).statusCode,
    ).toBe(416);
    const gap = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { subjectId: 'stripchat:42', targetUtcMs: 13000 },
    });
    expect(gap.statusCode).toBe(409);
    const jump = await app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { cookie },
      payload: { subjectId: 'stripchat:42', targetUtcMs: 13000, gapPolicy: 'next' },
    });
    expect(jump.json()).toMatchObject({ actualAtMs: 15000, seekOffsetSeconds: 0 });
    await archive.deleteRange('stripchat:42', 10000, 12000);
    expect((await app.inject({ url: body.manifestUrl, headers: { cookie } })).statusCode).toBe(410);
  });

  it('keeps address keys encrypted and returns values only from the administrator key panel', async () => {
    const { app, archive, cookie, root } = await fixture();
    for (const [method, url] of [
      ['POST', '/api/keys/refresh'],
      ['GET', '/api/keys/events'],
    ] as const) {
      expect((await app.inject({ method, url, headers: { cookie } })).statusCode).toBe(404);
    }
    const response = await app.inject({
      method: 'PUT',
      url: '/api/keys/current',
      headers: { cookie },
      payload: { name: 'first', value: 'test-private-secret' },
    });
    expect(response.json()).toMatchObject({ keyCount: 1 });
    expect((await app.inject({ url: '/api/keys', headers: { cookie } })).body).not.toContain(
      'test-private-secret',
    );
    expect(await archive.getSetting('provider.encrypted-keys')).not.toContain(
      'test-private-secret',
    );
    const reopened = await KeyVault.open(root, archive);
    expect(reopened.lookup('first')).toBe('test-private-secret');
    expect((await readFile(path.join(root, 'private/address-key.key'))).length).toBe(32);
    expect((await app.inject({ url: '/api/keys/current' })).statusCode).toBe(401);
    const entries = await app.inject({ url: '/api/keys/current', headers: { cookie } });
    expect(entries.headers['cache-control']).toContain('no-store');
    expect(entries.json()).toEqual({
      keyCount: 1,
      key: { name: 'first', value: 'test-private-secret' },
      status: 'pending',
      checking: false,
    });
    const replaced = await app.inject({
      method: 'PUT',
      url: '/api/keys/current',
      headers: { cookie },
      payload: { name: 'second', value: 'replacement-key' },
    });
    expect(replaced.json()).toMatchObject({ keyCount: 1, key: { name: 'second' } });
    expect((await KeyVault.open(root, archive)).lookup('first')).toBeUndefined();
  });

  it('validates timeline windows and serializes initial setup', async () => {
    const { app, cookie } = await fixture();
    expect(
      (
        await app.inject({
          url: '/api/subjects/stripchat:42/timeline?from=20&to=10',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup/session',
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    const result = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { pin: '012345' },
    });
    expect(result.statusCode).toBe(200);
  });

  it('reports storage unready after the metadata worker is closed', async () => {
    const { app, archive } = await fixture();
    await archive.close();
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
  });

  it('rejects a linked private directory before creating a master key in its target', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'st-vault-key-boundary-'));
    const root = path.join(base, 'archive');
    const target = path.join(base, 'outside');
    await mkdir(root);
    await mkdir(target);
    const archive = await openArchive({ root });
    cleanups.push(async () => {
      await archive.close();
      await rm(base, { recursive: true, force: true });
    });
    await symlink(
      target,
      path.join(root, 'private'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(KeyVault.open(root, archive)).rejects.toThrow('INVALID_KEY_DIRECTORY');
    expect(await readdir(target)).toEqual([]);
  });

  it('stores the global recording default independently of current membership and remote reconciliation', async () => {
    const { app, archive, cookie, supervisor } = await fixture();
    let release!: () => void;
    vi.mocked(supervisor.reconcile).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/api/subjects/recording-default',
      headers: { cookie },
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(await archive.getSetting('recording.default')).toBe('true');
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'new' }], {
      syncAccount: true,
    });
    expect((await archive.getSubject('stripchat:42'))?.autoRecord).toBe(true);
    await archive.setPolicy('stripchat:42', { autoRecord: false });
    const system = await app.inject({ url: '/api/system', headers: { cookie } });
    expect(system.json<{ recordAll: boolean }>().recordAll).toBe(true);
    release?.();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/subjects/recording-default',
          headers: { cookie },
          payload: { enabled: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/subjects/recording-default',
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('adds public targets and applies batch policies atomically without an account', async () => {
    const { app, archive, cookie } = await fixture();
    const add = await app.inject({
      method: 'POST',
      url: '/api/subjects',
      headers: { cookie },
      payload: { providerId: 42 },
    });
    expect(add.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: '/api/subjects',
      headers: { cookie },
      payload: { providerId: 43, handle: 'Another' },
    });
    const bulk = await app.inject({
      method: 'PATCH',
      url: '/api/subjects/policies',
      headers: { cookie },
      payload: { ids: ['stripchat:42', 'stripchat:43'], policy: { autoRecord: true } },
    });
    expect(bulk.json()).toEqual({ updated: 2 });
    const failed = await app.inject({
      method: 'PATCH',
      url: '/api/subjects/policies',
      headers: { cookie },
      payload: { ids: ['stripchat:42', 'stripchat:999'], policy: { autoRecord: false } },
    });
    expect(failed.statusCode).toBe(404);
    expect((await archive.listSubjects()).every((subject) => subject.autoRecord)).toBe(true);
  });

  it('paginates a stable snapshot, reports stale deletion cursors, and uses union coverage', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    const input = {
      subjectId: 'stripchat:42',
      sourceEpoch: 'cursor-epoch',
      init: null,
      bytes: Buffer.from('media'),
      durationSeconds: 2,
      timeBasis: 'source-pdt' as const,
      uncertaintyMs: null,
      discontinuity: false,
    };
    await archive.commit({ ...input, sourceSequence: '1', wallStartMs: 10000 });
    await archive.commit({ ...input, sourceSequence: '2', wallStartMs: 11000 });
    const first = await app.inject({
      url: '/api/subjects/stripchat:42/timeline?from=9000&to=20000&limit=1',
      headers: { cookie },
    });
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    expect(cursor).toBeTruthy();
    await archive.commit({ ...input, sourceSequence: '3', wallStartMs: 15000 });
    const second = await app.inject({
      url: `/api/subjects/stripchat:42/timeline?from=9000&to=20000&limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(
      second.json<{ segments: { sourceSequence: string }[]; nextCursor: string | null }>()
        .segments[0].sourceSequence,
    ).toBe('2');
    expect(second.json<{ nextCursor: string | null }>().nextCursor).toBeNull();
    const coverage = await app.inject({
      url: '/api/subjects/stripchat:42/coverage?from=10000&to=14000&buckets=2',
      headers: { cookie },
    });
    expect(coverage.statusCode).toBe(200);
    expect(
      coverage
        .json<{ buckets: { coveredMs: number }[] }>()
        .buckets.reduce((sum, bucket) => sum + bucket.coveredMs, 0),
    ).toBe(3000);
    await archive.deleteRange('stripchat:42', 15000, 17000);
    const stale = await app.inject({
      url: `/api/subjects/stripchat:42/timeline?from=9000&to=20000&limit=1&cursor=${encodeURIComponent(cursor)}`,
      headers: { cookie },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'cursor_stale' });
  });

  it('acknowledges persisted settings while a disk check is still pending', async () => {
    const { app, archive, cookie, resources } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = vi.spyOn(resources, 'check').mockImplementation(() => gate);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: { cookie },
          payload: { pollMs: 2000 },
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('SETTINGS_WAITED_FOR_DISK_CHECK')), 2000);
        }),
      ]);
      expect(response.statusCode).toBe(200);
      expect(check).toHaveBeenCalledOnce();
      expect((await SettingsStore.open(archive, {})).get().pollMs).toBe(2000);
    } finally {
      clearTimeout(timer);
      release();
      check.mockRestore();
    }
  });
  it('deletes unlocated media explicitly and persists validated runtime settings', async () => {
    const { app, archive, cookie } = await fixture();
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Fixture' }]);
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'unknown',
      sourceSequence: '1',
      init: null,
      bytes: Buffer.from('media'),
      durationSeconds: 2,
      wallStartMs: null,
      timeBasis: 'unknown',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const deleted = await app.inject({
      method: 'POST',
      url: '/api/subjects/stripchat:42/delete-unlocated',
      headers: { cookie },
    });
    expect(deleted.json()).toEqual({ deletedSegments: 1, reclaimedBytes: 5 });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: { cookie },
          payload: { maxConcurrent: 0 },
        })
      ).statusCode,
    ).toBe(400);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie },
      payload: { pollMs: 2000 },
    });
    expect(saved.statusCode).toBe(200);
    const system = await app.inject({ url: '/api/system', headers: { cookie } });
    expect(system.json()).not.toHaveProperty('snapshotAcceleration');
    expect(system.json()).toMatchObject({
      settings: { pollMs: 2000 },
      capture: { pollMs: 2000 },
      disk: { lowSpace: false },
    });
    expect((await SettingsStore.open(archive, {})).get().pollMs).toBe(2000);
  });
});
it('keeps the status endpoint useful when an observer fails without leaking its raw error', async () => {
  const { app, archive, cookie } = await fixture();
  const observer = vi
    .spyOn(archive, 'backgroundTasks')
    .mockRejectedValue(Error('Cookie=secret; D:/private/state'));
  const deletion = vi
    .spyOn(archive, 'deletionJobs')
    .mockRejectedValue(Error('private deletion failure'));
  try {
    const response = await app.inject({ url: '/api/system', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      backgroundTasks: BackgroundTask[];
      capture: { active: number };
      capturedAtMs: number;
    }>();
    expect(body.capturedAtMs).toBeGreaterThan(0);
    expect(body.capture.active).toBe(0);
    for (const id of [
      'archive-index',
      'favorite-materialization',
      'library-checkpoint',
      'orphan-sweep',
    ])
      expect(body.backgroundTasks.find((task) => task.id === id)).toMatchObject({
        state: 'error',
        error: 'task_status_unavailable',
      });
    expect(body.backgroundTasks.find((task) => task.id === 'deletion')).toMatchObject({
      state: 'error',
      error: 'task_status_unavailable',
    });
    expect(response.body).not.toContain('Cookie=secret');
    expect(response.body).not.toContain('D:/private');
    observer.mockRestore();
    deletion.mockRestore();
    const restored = await app.inject({ url: '/api/system', headers: { cookie } });
    expect(restored.statusCode).toBe(200);
    expect(
      restored
        .json<{ backgroundTasks: BackgroundTask[] }>()
        .backgroundTasks.find((task) => task.id === 'archive-index')?.state,
    ).not.toBe('error');
  } finally {
    observer.mockRestore();
    deletion.mockRestore();
  }
});

it('refreshes account and background status together when the account binding changes', async () => {
  const create = syncModule.createSyncHub;
  const notify = vi.fn();
  const spy = vi.spyOn(syncModule, 'createSyncHub').mockImplementation((options) => {
    const hub = create(options);
    return {
      ...hub,
      notify: (topics) => {
        notify(topics);
        hub.notify(topics);
      },
    };
  });
  try {
    const { app, cookie } = await fixture();
    const headers = { cookie };
    const login = await app.inject({
      method: 'PUT',
      url: '/api/account-sync',
      headers,
      payload: { cookiesText: 'session=synthetic', origin: 'https://stripchat.com' },
    });
    expect(login.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith(['account', 'system']);
    notify.mockClear();
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/account-sync', headers })).statusCode,
    ).toBe(200);
    expect(notify).toHaveBeenCalledWith(['account', 'system']);
  } finally {
    spy.mockRestore();
  }
});

it('binds a login site, rejects post-login probes and archives every subject on account disconnect', async () => {
  const { app, archive, cookie, provider, supervisor } = await fixture();
  const headers = { cookie };
  await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'local' }]);
  const login = await app.inject({
    method: 'PUT',
    url: '/api/account-sync',
    headers,
    payload: { cookiesText: 'session=synthetic', origin: 'https://stripchat.com' },
  });
  expect(login.statusCode).toBe(200);
  await archive.setPolicy('stripchat:42', { autoRecord: true });
  const probe = await app.inject({
    method: 'POST',
    url: '/api/network/probe',
    headers,
    payload: { kind: 'sites' },
  });
  expect(probe.statusCode).toBe(409);
  const different = await app.inject({
    method: 'PUT',
    url: '/api/account-sync',
    headers,
    payload: { cookiesText: 'session=other', origin: 'https://stripchat.org' },
  });
  expect(different.statusCode).toBe(409);
  expect(different.json<{ error: string }>().error).toBe('account_origin_locked');
  const disconnected = await app.inject({ method: 'DELETE', url: '/api/account-sync', headers });
  expect(disconnected.statusCode).toBe(200);
  expect(disconnected.json()).toMatchObject({
    draft: { cookiesText: 'session=synthetic', origin: 'https://stripchat.com' },
    status: { connected: false },
  });
  const archived = await archive.listSubjects();
  expect(archived).toHaveLength(2);
  expect(archived.every((s) => s.archived && !s.autoRecord && !s.monitorEnabled)).toBe(true);
  expect(supervisor.reconcile).toHaveBeenCalled();
  const enable = await app.inject({
    method: 'PATCH',
    url: '/api/subjects/stripchat%3A42/policy',
    headers,
    payload: { autoRecord: true },
  });
  expect(enable.statusCode).toBe(409);
  expect(enable.json<{ error: string }>().error).toBe('subject_archived');
  vi.mocked(provider.importList).mockResolvedValueOnce([
    { id: 'stripchat:1', providerId: 1, handle: 'local' },
  ]);
  const next = await app.inject({
    method: 'PUT',
    url: '/api/account-sync',
    headers,
    payload: { cookiesText: 'session=new', origin: 'https://stripchat.org' },
  });
  expect(next.statusCode).toBe(200);
  expect(await archive.getSubject('stripchat:1')).toMatchObject({
    archived: false,
    autoRecord: false,
  });
  expect(await archive.getSubject('stripchat:42')).toMatchObject({
    archived: true,
    autoRecord: false,
  });
});
