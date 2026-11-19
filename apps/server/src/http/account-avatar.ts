import type { FastifyInstance } from 'fastify';
import type { AccountSyncPort } from '../ports.js';
import { previewImageType } from '../previews/image-type.js';
import { AccountSyncError } from '../account/account-sync.js';

/** Registered inside the normal local-admin auth boundary; never redirects a browser to the CDN. */
export function registerAccountAvatar(
  app: FastifyInstance,
  account: AccountSyncPort & { avatar?: (signal?: AbortSignal) => Promise<Uint8Array> },
): void {
  app.get('/api/account-sync/avatar', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    if (!account.avatar) return reply.code(404).send({ error: 'account_avatar_unavailable' });
    const controller = new AbortController(),
      cancel = (): void => controller.abort(),
      closed = (): void => {
        if (!reply.raw.writableFinished) cancel();
      };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', closed);
    try {
      const bytes = await account.avatar(controller.signal),
        type = previewImageType(bytes);
      if (!type || bytes.length > 512 * 1024)
        return reply.code(404).send({ error: 'account_avatar_unavailable' });
      return reply.type(type).send(Buffer.from(bytes));
    } catch (error) {
      return reply
        .code(error instanceof AccountSyncError && error.code === 'account_sync_busy' ? 429 : 404)
        .send({ error: 'account_avatar_unavailable' });
    } finally {
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', closed);
    }
  });
}
