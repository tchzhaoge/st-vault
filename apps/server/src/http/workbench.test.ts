import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ArchivePort } from '../ports.js';
import type { CoverageResponse, StatusHistoryResponse } from '@st-vault/api-schema';
import { describe, it, expect, vi } from 'vitest';
import { registerWorkbench, type WorkbenchOptions } from './workbench.js';

type Archive = Pick<ArchivePort, 'coverage' | 'statusHistory'>;
const url = '/api/workbench?ids=stripchat:1&from=0&to=3600000&buckets=360';
const coverage = (subjectId = 'stripchat:1'): CoverageResponse => ({
  subjectId,
  fromMs: 0,
  toMs: 3600000,
  unlocatedCount: 2,
  revision: 9,
  buckets: [
    { fromMs: 0, toMs: 1200000, coveredMs: 0, segmentCount: 0 },
    { fromMs: 1200000, toMs: 2400000, coveredMs: 2000, segmentCount: 1 },
  ],
});
const status = (subjectId = 'stripchat:1'): StatusHistoryResponse => ({
  subjectId,
  fromMs: 0,
  toMs: 3600000,
  buckets: [
    {
      fromMs: 0,
      toMs: 1200000,
      durationsMs: { PUBLIC: 700000, PRIVATE: 500000, OFFLINE: 0, UNKNOWN: 0 },
    },
    {
      fromMs: 1200000,
      toMs: 2400000,
      durationsMs: { PUBLIC: 700000, PRIVATE: 0, OFFLINE: 500000, UNKNOWN: 0 },
    },
    {
      fromMs: 2400000,
      toMs: 3600000,
      durationsMs: { PUBLIC: 600000, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 600000 },
    },
  ],
});
const basic = (): Archive => ({
  coverage: vi.fn((id: string) => Promise.resolve(coverage(id))),
  statusHistory: vi.fn((id: string) => Promise.resolve(status(id))),
});
function appFor(archive: Archive, options?: WorkbenchOptions): FastifyInstance {
  const app = Fastify();
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(400).send({ error: 'invalid_request' }),
  );
  registerWorkbench(app, archive, options);
  return app;
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('bounded batched workbench reads', () => {
  it('requests protection only for the explicitly active deletion subject', async () => {
    const archive = basic(),
      app = appFor(archive);
    try {
      await app.inject(
        url.replace('stripchat:1', 'stripchat:1,stripchat:2') + '&protection=stripchat:2',
      );
      expect(archive.coverage).toHaveBeenCalledWith('stripchat:1', 0, 3600000, 360, false);
      expect(archive.coverage).toHaveBeenCalledWith('stripchat:2', 0, 3600000, 360, true);
    } finally {
      await app.close();
    }
  });
  it('carries protection and seen masks in coverage without a separate favorite read', async () => {
    const masks = {
      protectedSpans: [{ fromMs: 1200000, toMs: 1201000 }],
      seenSpans: [{ fromMs: 1200000, toMs: 1200500 }],
    };
    const archive = {
      ...basic(),
      coverage: vi.fn(() => Promise.resolve({ ...coverage(), ...masks })),
      favoriteCoverage: vi.fn(() => Promise.reject(Error('obsolete favorite read'))),
    };
    const app = appFor(archive);
    try {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      const row = response.json<{ rows: { coverage: CoverageResponse }[] }>().rows[0];
      expect(row.coverage).toMatchObject(masks);
      expect(row).not.toHaveProperty('favoriteCoverage');
      expect(archive.favoriteCoverage).not.toHaveBeenCalled();
      expect(archive.coverage).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('shares row execution capacity across clients while preserving per-request order', async () => {
    const wait = gate();
    let active = 0,
      maximum = 0;
    const read = async <T>(value: T): Promise<T> => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await wait.promise;
        return value;
      } finally {
        active--;
      }
    };
    const app = appFor(
      { coverage: (id) => read(coverage(id)), statusHistory: (id) => read(status(id)) },
      { maxRequests: 8, rowConcurrency: 4, totalRowConcurrency: 4 },
    );
    const ids = Array.from({ length: 8 }, (_, i) => `stripchat:${i + 1}`);
    const requests = Array.from({ length: 3 }, () =>
      app.inject(url.replace('stripchat:1', ids.join(','))),
    );
    try {
      await tick();
      expect(maximum).toBe(8);
      wait.release();
      for (const response of await Promise.all(requests)) {
        expect(response.statusCode).toBe(200);
        expect(
          response.json<{ rows: { subjectId: string }[] }>().rows.map((row) => row.subjectId),
        ).toEqual(ids);
      }
      expect(maximum).toBe(8);
    } finally {
      wait.release();
      await Promise.allSettled(requests);
      await app.close();
    }
  });
  it('deduplicates IDs and compacts transmission without changing original windows or source data', async () => {
    const archive = basic(),
      app = appFor(archive),
      original = status();
    try {
      const result = await app.inject(url.replace('stripchat:1', 'stripchat:1,stripchat:1'));
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(archive.coverage).toHaveBeenCalledTimes(1);
      const row = result.json<{
        rows: { coverage: CoverageResponse; status: StatusHistoryResponse }[];
      }>().rows[0];
      expect(row.coverage).toMatchObject({
        fromMs: 0,
        toMs: 3600000,
        unlocatedCount: 2,
        revision: 9,
      });
      expect(row.coverage.buckets).toHaveLength(1);
      expect(row.status.buckets).toEqual([
        {
          fromMs: 0,
          toMs: 2400000,
          durationsMs: { PUBLIC: 1400000, PRIVATE: 500000, OFFLINE: 500000, UNKNOWN: 0 },
        },
        original.buckets[2],
      ]);
      expect(row.status.fromMs).toBe(0);
      expect(row.status.toMs).toBe(3600000);
    } finally {
      await app.close();
    }
  });
  it('rejects invalid and oversized batches before storage work', async () => {
    const archive = basic(),
      app = appFor(archive);
    try {
      const ids = Array.from({ length: 25 }, (_, i) => `stripchat:${i + 1}`).join(',');
      for (const address of [
        url.replace('stripchat:1', ids),
        url.replace('stripchat:1', 'stripchat:0'),
        url.replace('stripchat:1', ''),
        url.replace('buckets=360', 'buckets=721'),
        url.replace('to=3600000', 'to=0'),
        url.replace('to=3600000', 'to=691200001'),
        url + '&extra=1',
      ])
        expect((await app.inject(address)).statusCode).toBe(400);
      expect(archive.coverage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('accepts minute windows for both tracks without relaxing upper bounds', async () => {
    const archive = basic(),
      app = appFor(archive);
    try {
      expect((await app.inject(url.replace('to=3600000', 'to=60000'))).statusCode).toBe(200);
      expect(archive.coverage).toHaveBeenCalledWith('stripchat:1', 0, 60000, 360, false);
      expect(archive.statusHistory).toHaveBeenCalledWith('stripchat:1', 0, 60000, 360);
      expect((await app.inject(url.replace('to=3600000', 'to=1000'))).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('processes only three rows concurrently and returns every row in input order', async () => {
    const wait = gate();
    let active = 0,
      maximum = 0,
      calls = 0;
    const read = async <T>(value: T): Promise<T> => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      try {
        await wait.promise;
        return value;
      } finally {
        active--;
      }
    };
    const app = appFor({
      coverage: (id) => read(coverage(id)),
      statusHistory: (id) => read(status(id)),
    });
    const ids = Array.from({ length: 24 }, (_, i) => `stripchat:${i + 1}`),
      result = app.inject(url.replace('stripchat:1', ids.join(',')));
    try {
      await tick();
      expect(calls).toBe(6);
      expect(maximum).toBe(6);
      wait.release();
      const response = await result;
      expect(
        response.json<{ rows: { subjectId: string }[] }>().rows.map((row) => row.subjectId),
      ).toEqual(ids);
      expect(calls).toBe(48);
      expect(maximum).toBe(6);
    } finally {
      wait.release();
      await result;
      await app.close();
    }
  });
  it('rejects the fifth active request and releases capacity only after accepted reads drain', async () => {
    const wait = gate();
    let calls = 0;
    const app = appFor({
      coverage: async (id) => {
        calls++;
        await wait.promise;
        return coverage(id);
      },
      statusHistory: async (id) => {
        calls++;
        await wait.promise;
        return status(id);
      },
    });
    const pending = Array.from({ length: 4 }, () => app.inject(url));
    try {
      await tick();
      expect(calls).toBe(8);
      expect((await app.inject(url)).json()).toEqual({ error: 'workbench_busy' });
      expect(calls).toBe(8);
      wait.release();
      expect((await Promise.all(pending)).every((result) => result.statusCode === 200)).toBe(true);
      expect((await app.inject(url)).statusCode).toBe(200);
    } finally {
      wait.release();
      await Promise.allSettled(pending);
      await app.close();
    }
  });
  it('does not abandon accepted siblings when one query rejects', async () => {
    const wait = gate();
    let settled = false,
      calls = 0;
    const app = appFor({
      coverage: (id) => {
        calls++;
        return id === 'stripchat:1'
          ? Promise.reject(new Error('fixture-failure'))
          : wait.promise.then(() => coverage(id));
      },
      statusHistory: (id) => {
        calls++;
        return wait.promise.then(() => status(id));
      },
    });
    const result = app
      .inject(url.replace('stripchat:1', 'stripchat:1,stripchat:2,stripchat:3,stripchat:4'))
      .then((value) => {
        settled = true;
        return value;
      });
    try {
      await tick();
      expect(calls).toBe(6);
      expect(settled).toBe(false);
      wait.release();
      await result;
      expect(calls).toBe(6);
    } finally {
      wait.release();
      await result;
      await app.close();
    }
  });
  it('stops scheduling after real client disconnect and drains those already submitted', async () => {
    const wait = gate();
    let calls = 0;
    const archive: Archive = {
      coverage: async (id) => {
        calls++;
        await wait.promise;
        return coverage(id);
      },
      statusHistory: async (id) => {
        calls++;
        await wait.promise;
        return status(id);
      },
    };
    const app = appFor(archive),
      origin = await app.listen({ host: '127.0.0.1', port: 0 }),
      controller = new AbortController();
    const request = fetch(
      origin + url.replace('stripchat:1', 'stripchat:1,stripchat:2,stripchat:3,stripchat:4'),
      { signal: controller.signal },
    ).catch(() => undefined);
    try {
      for (let i = 0; i < 100 && calls < 6; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(calls).toBe(6);
      controller.abort();
      await request;
      await new Promise((resolve) => setTimeout(resolve, 20));
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      await tick();
      expect(closed).toBe(false);
      wait.release();
      await closing;
      expect(calls).toBe(6);
    } finally {
      controller.abort();
      wait.release();
      await request;
      await app.close();
    }
  });
});
