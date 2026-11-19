import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerStatusHistory } from './status-history.js';
describe('bounded status history HTTP parameters', () => {
  it('validates subject/window/bucket bounds before querying storage and disables response caching', async () => {
    const app = Fastify();
    const statusHistory = vi.fn(() =>
      Promise.resolve({ subjectId: 'stripchat:42', fromMs: 0, toMs: 3600000, buckets: [] }),
    );
    app.setErrorHandler((_error, _request, reply) =>
      reply.code(400).send({ error: 'invalid_request' }),
    );
    registerStatusHistory(app, { statusHistory });
    try {
      const good = await app.inject(
        '/api/subjects/stripchat:42/status-history?from=0&to=3600000&buckets=360',
      );
      expect(good.statusCode).toBe(200);
      expect(good.headers['cache-control']).toBe('private, no-store');
      expect(statusHistory).toHaveBeenCalledWith('stripchat:42', 0, 3600000, 360);
      for (const query of [
        'from=0&to=691200001',
        'from=2&to=1',
        'from=0&to=1000&buckets=721',
        'from=0&to=1000&buckets=0',
        'from=0&to=1000&junk=1',
      ])
        expect(
          (await app.inject(`/api/subjects/stripchat:42/status-history?${query}`)).statusCode,
        ).toBe(400);
      expect(
        (await app.inject('/api/subjects/stripchat:0/status-history?from=0&to=1000')).statusCode,
      ).toBe(400);
      expect(statusHistory).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
