import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerEvents } from './events.js';
import type { ArchivePort } from '../ports.js';

describe('event read-only and acknowledgment API', () => {
  it('bounds both pagination directions, windows and ack bodies while never accepting event creation', async () => {
    const app = Fastify(),
      meta = {
        latestCursor: 20,
        readCursor: 2,
        oldestCursor: 1,
        unreadCount: 18,
        revision: 21,
        retentionDays: 30,
        maxEvents: 100000,
      };
    const archive: Pick<ArchivePort, 'events' | 'eventMeta' | 'ackEvents' | 'runHistory'> = {
      events: vi.fn(() =>
        Promise.resolve({ items: [], nextCursor: 0, hasMore: false, cursorExpired: false, meta }),
      ),
      eventMeta: vi.fn(() => Promise.resolve(meta)),
      ackEvents: vi.fn((cursor: number) =>
        cursor > 20
          ? Promise.reject(new Error('INVALID_EVENT_CURSOR'))
          : Promise.resolve({ ...meta, readCursor: cursor }),
      ),
      runHistory: vi.fn((fromMs: number, toMs: number) =>
        Promise.resolve({ fromMs, toMs, runs: [], gaps: [], truncated: false }),
      ),
    };
    app.setErrorHandler((_error, _request, reply) =>
      reply.code(400).send({ error: 'invalid_request' }),
    );
    registerEvents(app, archive);
    try {
      const page = await app.inject('/api/events?before=21&limit=100');
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('private, no-store');
      expect(archive.events).toHaveBeenCalledWith({ before: 21, limit: 100 });
      expect((await app.inject('/api/events?after=2&limit=200')).statusCode).toBe(200);
      for (const query of [
        'after=1&before=2',
        'limit=201',
        'after=-1',
        'before=NaN',
        'after=9007199254740992',
        'x=1',
      ])
        expect((await app.inject(`/api/events?${query}`)).statusCode).toBe(400);
      expect((await app.inject('/api/events/meta')).json()).toEqual(meta);
      expect((await app.inject('/api/events/runs?from=0&to=3600000')).statusCode).toBe(200);
      expect((await app.inject('/api/events/runs?from=0&to=60000')).statusCode).toBe(200);
      expect((await app.inject('/api/events/runs?from=0&to=0')).statusCode).toBe(400);
      expect((await app.inject('/api/events/runs?from=0&to=1000')).statusCode).toBe(200);
      expect((await app.inject('/api/events/runs?from=0&to=691200001')).statusCode).toBe(400);
      expect(
        (
          await app.inject({ method: 'POST', url: '/api/events/read', payload: { cursor: 10 } })
        ).json(),
      ).toMatchObject({ readCursor: 10 });
      expect(
        (await app.inject({ method: 'POST', url: '/api/events/read', payload: { cursor: 21 } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/events/read',
            payload: { cursor: 1, subjectId: 'stripchat:1' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/events',
            payload: { kind: 'status_changed' },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
