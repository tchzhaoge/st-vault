import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LiveProxy } from '../live/index.js';
import { LiveError } from '../live/index.js';

const subjectId = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(10))));
const idSchema = z.string().uuid();
export function registerLive(
  app: FastifyInstance,
  live: LiveProxy,
  options: { ownerOf(request: FastifyRequest): string | undefined },
): void {
  const operation = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (owner: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    reply.header('cache-control', 'private, no-store');
    const owner = options.ownerOf(request);
    if (!owner) return reply.code(401).send({ error: 'unauthorized' });
    const controller = new AbortController(),
      cancel = (): void => controller.abort(),
      disconnected = (): void => {
        if (!reply.raw.writableFinished) cancel();
      };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', disconnected);
    try {
      return await work(owner, controller.signal);
    } catch (error) {
      if (error instanceof LiveError)
        return reply
          .code(
            error.code === 'live_not_public' || error.code === 'live_cancelled'
              ? 409
              : error.code === 'live_not_found'
                ? 404
                : error.code === 'live_busy'
                  ? 429
                  : 503,
          )
          .send({ error: error.code, reason: error.reason });
      throw error;
    } finally {
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', disconnected);
    }
  };
  app.get('/api/subjects/:id/live-progress', async (request, reply) =>
    operation(request, reply, (owner) =>
      Promise.resolve(
        live.progress?.(owner, subjectId.parse((request.params as { id: string }).id)) ?? null,
      ),
    ),
  );
  app.post('/api/subjects/:id/live', async (request, reply) =>
    operation(request, reply, async (owner, signal) => {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      const id = subjectId.parse((request.params as { id: string }).id),
        result = await live.create(
          owner,
          id,
          signal,
          request.headers['x-stv-replace-live'] === undefined
            ? undefined
            : idSchema.parse(request.headers['x-stv-replace-live']),
        );
      if (signal.aborted || reply.raw.destroyed) {
        await live.destroy(owner, result.sessionId).catch(() => undefined);
        throw new LiveError('live_cancelled');
      }
      const abandon = (): void => {
        if (!reply.raw.writableFinished)
          void live.destroy(owner, result.sessionId).catch(() => undefined);
      };
      reply.raw.once('close', abandon);
      reply.raw.once('finish', () => reply.raw.removeListener('close', abandon));
      return result;
    }),
  );
  app.get('/api/live/:id/manifest.m3u8', async (request, reply) =>
    operation(request, reply, async (owner, signal) => {
      const id = idSchema.parse((request.params as { id: string }).id),
        body = await live.manifest(owner, id, signal);
      return reply.type('application/vnd.apple.mpegurl').send(body);
    }),
  );
  app.get('/api/live/:id/media/:token.mp4', async (request, reply) =>
    operation(request, reply, async (owner, signal) => {
      const params = request.params as { id: string; token: string },
        id = idSchema.parse(params.id),
        token = idSchema.parse(params.token);
      await live.media(
        owner,
        id,
        token,
        async (bytes, abort) => {
          if (abort.aborted || reply.raw.destroyed) throw new LiveError('live_cancelled');
          await new Promise<void>((resolve, reject) => {
            const cancel = (): void => {
                reply.raw.destroy();
              },
              finish = (): void => {
                cleanup();
                resolve();
              },
              failed = (): void => {
                cleanup();
                reject(new LiveError('live_cancelled'));
              };
            const cleanup = (): void => {
              abort.removeEventListener('abort', cancel);
              reply.raw.removeListener('finish', finish);
              reply.raw.removeListener('close', failed);
            };
            abort.addEventListener('abort', cancel, { once: true });
            reply.raw.once('finish', finish);
            reply.raw.once('close', failed);
            reply
              .type('video/mp4')
              .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          });
        },
        signal,
      );
      return reply;
    }),
  );
  app.delete('/api/live/:id', async (request, reply) =>
    operation(request, reply, async (owner) => {
      await live.destroy(owner, idSchema.parse((request.params as { id: string }).id));
      return reply.code(204).send();
    }),
  );
}
