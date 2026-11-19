import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSubjectAvatars } from './avatars.js';
import type { Subject } from '@st-vault/api-schema';
import { SyncClock } from '../runtime/sync-clock.js';
import { SiteRoutes } from '../provider/site-routes.js';
const urlOf = (url: string | URL | Request) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
it('drains all queued portraits in one heartbeat with bounded parallel downloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-avatar-parallel-'));
  const rows = Array.from(
    { length: 17 },
    (_, index) => ({ id: `stripchat:${index + 1}`, providerId: index + 1 }) as Subject,
  );
  const settings = new Map(
    rows.map((row) => [
      `preview.avatar-source.${row.id}`,
      `https://static-cdn.strpst.com/avatars/${row.providerId}`,
    ]),
  );
  let active = 0,
    maximum = 0;
  const fetch = vi.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return new Response(Buffer.from([255, 216, 255, 217]));
  });
  const service = createSubjectAvatars({
    root,
    concurrency: 4,
    fetch,
    archive: {
      listSubjects: () => Promise.resolve(rows),
      getSetting: (key) => Promise.resolve(settings.get(key) ?? null),
      setSetting: (key, value) => {
        settings.set(key, value);
        return Promise.resolve();
      },
    },
  });
  try {
    for (const row of rows) await service.read(row.id);
    await service.refresh();
    expect(fetch).toHaveBeenCalledTimes(17);
    expect(maximum).toBe(4);
    expect(service.status()).toMatchObject({ state: 'idle', pending: 0 });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('retries a failed portrait on the next heartbeat without another browser image read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-avatar-recovery-'));
  const image = Buffer.from([255, 216, 255, 217]);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(image));
  const settings = new Map([
    ['preview.avatar-source.stripchat:42', 'https://static-cdn.strpst.com/avatars/first'],
  ]);
  const service = createSubjectAvatars({
    root,
    fetch,
    archive: {
      listSubjects: () => Promise.resolve([{ id: 'stripchat:42', providerId: 42 } as Subject]),
      getSetting: (key) => Promise.resolve(settings.get(key) ?? null),
      setSetting: (key, value) => {
        settings.set(key, value);
        return Promise.resolve();
      },
    },
  });
  try {
    await service.read('stripchat:42');
    await service.refresh();
    expect(service.status()).toMatchObject({ state: 'retrying', failed: 1 });
    await service.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.status()).toMatchObject({ state: 'idle', failed: 0, error: null });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('retains the bound avatar profile host on failure and uses a newly bound host after account change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-avatar-sites-'));
  const image = Buffer.from([255, 216, 255, 217]);
  const fetch = vi.fn((input: string | URL | Request) => {
    const url = new URL(urlOf(input));
    return Promise.resolve(
      url.hostname === 'stripchat.com'
        ? new Response(null, { status: 503 })
        : url.hostname === 'backup.invalid'
          ? Response.json({
              user: { user: { id: 42, avatarUrl: 'https://static-cdn.strpst.com/avatars/frame' } },
            })
          : new Response(image),
    );
  });
  const sites = new SiteRoutes({
    origins: ['https://stripchat.com', 'https://backup.invalid'],
    fetch,
  });
  const service = createSubjectAvatars({
    root,
    sites,
    fetch,
    archive: {
      listSubjects: () => Promise.resolve([{ id: 'stripchat:42', providerId: 42 } as Subject]),
      getSetting: () => Promise.resolve(null),
      setSetting: () => Promise.resolve(),
    },
  });
  try {
    await service.read('stripchat:42');
    await service.refresh();
    expect(await service.read('stripchat:42')).toBeNull();
    expect(sites.status().selectedOrigin).toBe('https://stripchat.com');
    expect(
      fetch.mock.calls.every(([input]) => new URL(urlOf(input)).hostname === 'stripchat.com'),
    ).toBe(true);
    sites.configure('https://backup.invalid');
    await service.refresh();
    expect(await service.read('stripchat:42')).toEqual(image);
    expect(sites.status().selectedOrigin).toBe('https://backup.invalid');
  } finally {
    await service.close();
    sites.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('registers on the shared heartbeat and never starts upstream work from an image read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-avatar-clock-'));
  const clock = new SyncClock({ intervalMs: () => 300000 });
  const subscribe = vi.spyOn(clock, 'subscribe');
  const settings = new Map([
    ['preview.avatar-source.stripchat:42', 'https://static-cdn.strpst.com/avatars/first'],
  ]);
  const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    return Promise.resolve(new Response(Buffer.from([255, 216, 255, 217])));
  });
  const service = createSubjectAvatars({
    root,
    clock,
    fetch,
    archive: {
      listSubjects: () => Promise.resolve([{ id: 'stripchat:42', providerId: 42 } as Subject]),
      getSetting: (key) => Promise.resolve(settings.get(key) ?? null),
      setSetting: (key, value) => {
        settings.set(key, value);
        return Promise.resolve();
      },
    },
  });
  try {
    expect(subscribe).toHaveBeenCalledWith('subject-avatars', expect.any(Function));
    await service.read('stripchat:42');
    expect(fetch).not.toHaveBeenCalled();
    const beat = subscribe.mock.calls[0][1];
    await beat({ nowMs: 1, intervalMs: 300000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await service.read('stripchat:42');
    await beat({ nowMs: 300001, intervalMs: 300000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
    await clock.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('warms requested avatars, skips unchanged versions across restarts and retains valid bytes on failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-avatar-'));
  const settings = new Map([
    ['preview.avatar-source.stripchat:42', 'https://static-cdn.strpst.com/avatars/first'],
  ]);
  const image = Buffer.from([255, 216, 255, 217]);
  const archive = {
    listSubjects: () => Promise.resolve([{ id: 'stripchat:42', providerId: 42 } as Subject]),
    getSetting: (key: string) => Promise.resolve(settings.get(key) ?? null),
    setSetting: (key: string, value: string) => {
      settings.set(key, value);
      return Promise.resolve();
    },
  };
  const fetch = vi.fn(() => Promise.resolve(new Response(image)));
  let service = createSubjectAvatars({ root, archive, fetch });
  try {
    expect(await service.read('stripchat:42')).toBeNull();
    const first = service.refresh();
    expect(service.refresh()).toBe(first);
    await first;
    expect(await service.read('stripchat:42')).toEqual(image);
    await service.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    await service.close();
    service = createSubjectAvatars({ root, archive, fetch });
    expect(await service.read('stripchat:42')).toEqual(image);
    await service.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    settings.set(
      'preview.avatar-source.stripchat:42',
      'https://static-cdn.strpst.com/avatars/second',
    );
    fetch.mockImplementation(() => Promise.resolve(new Response('unavailable', { status: 503 })));
    await service.read('stripchat:42');
    await service.refresh();
    expect(await service.read('stripchat:42')).toEqual(image);
    expect(settings.get('preview.avatar-version.stripchat:42')).toContain('/first');
    fetch.mockImplementation(() => Promise.resolve(new Response(image)));
    await service.refresh();
    expect(settings.get('preview.avatar-version.stripchat:42')).toContain('/second');
    expect(await service.read('stripchat:42')).toEqual(image);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('resolves a missing portrait anonymously by stable id and rejects an unrelated profile or unsafe image source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-avatar-profile-'));
  let id = 99;
  const fetch = vi.fn((url: string | URL | Request) =>
    Promise.resolve(
      urlOf(url).includes('/cam')
        ? Response.json({ user: { user: { id, avatarUrl: 'https://attacker.invalid/portrait' } } })
        : new Response('unexpected'),
    ),
  );
  const service = createSubjectAvatars({
    root,
    fetch,
    archive: {
      listSubjects: () => Promise.resolve([{ id: 'stripchat:42', providerId: 42 } as Subject]),
      getSetting: () => Promise.resolve(null),
      setSetting: () => Promise.resolve(),
    },
  });
  try {
    await service.read('stripchat:42');
    await service.refresh();
    expect(await service.read('stripchat:42')).toBeNull();
    id = 42;
    await service.refresh();
    expect(
      fetch.mock.calls.every(
        ([url]) => urlOf(url) === 'https://stripchat.com/api/front/v2/models/42/cam',
      ),
    ).toBe(true);
    expect(await service.read('stripchat:42')).toBeNull();
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps failed avatar refresh observable through an idle heartbeat without exposing source details', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-avatar-observation-'));
  let fail = true;
  const fetch = vi.fn(() =>
    Promise.resolve(
      fail ? new Response(null, { status: 503 }) : new Response(Buffer.from([255, 216, 255, 217])),
    ),
  );
  const service = createSubjectAvatars({
    root,
    fetch,
    archive: {
      listSubjects: () => Promise.resolve([{ id: 'stripchat:42', providerId: 42 } as Subject]),
      getSetting: () => Promise.resolve('https://static-cdn.strpst.com/avatars/private'),
      setSetting: () => Promise.resolve(),
    },
  });
  try {
    expect(service.status()).toMatchObject({ state: 'idle', pending: 0 });
    expect(fetch).not.toHaveBeenCalled();
    await service.read('stripchat:42');
    expect(service.status().pending).toBe(1);
    await service.refresh();
    expect(service.status()).toMatchObject({
      state: 'retrying',
      failed: 1,
      lastSuccessAtMs: null,
      error: 'avatar_refresh_partial',
    });
    await service.refresh();
    expect(service.status().state).toBe('retrying');
    expect(JSON.stringify(service.status())).not.toContain('https:');
    fail = false;
    await service.read('stripchat:42');
    await service.refresh();
    expect(service.status()).toMatchObject({ state: 'idle', failed: 0, error: null });
    expect(service.status().lastSuccessAtMs).toBeGreaterThan(0);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
