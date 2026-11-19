import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { registerAccountAvatar } from './account-avatar.js';
import type { AccountSyncPort } from '../ports.js';

describe('local account avatar proxy', () => {
  it('stays inside admin auth, returns detected raster MIME and does not redirect or expose source URLs', async () => {
    const account: AccountSyncPort = {
      status: () => ({
        connected: true,
        running: false,
        needsReconnect: false,
        lastAttemptMs: null,
        lastSuccessMs: null,
        nextAttemptMs: null,
        lastImportedCount: 0,
        error: null,
      }),
      configure: () => Promise.reject(new Error('unused')),
      refresh: () => Promise.reject(new Error('unused')),
      disconnect: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    };
    let calls = 0;
    const app = Fastify();
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-fixture-admin'] !== 'yes')
        return reply.code(401).send({ error: 'unauthorized' });
    });
    registerAccountAvatar(app, {
      ...account,
      avatar: () => {
        calls++;
        return Promise.resolve(
          Buffer.from('5249464610000000574542505650384c0400000000000000', 'hex'),
        );
      },
    });
    try {
      expect((await app.inject('/api/account-sync/avatar')).statusCode).toBe(401);
      expect(calls).toBe(0);
      const response = await app.inject({
        url: '/api/account-sync/avatar?version=1',
        headers: { 'x-fixture-admin': 'yes' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers.location).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
