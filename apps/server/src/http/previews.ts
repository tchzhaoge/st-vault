import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_SNAPSHOT_PAGE_SIZE } from '@st-vault/api-schema';
import type { PreviewsPort } from '../ports.js';
import { PreviewError } from '../previews/index.js';
import { previewImageType } from '../previews/image-type.js';
import { createHash } from 'node:crypto';

const subject = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(10))));
export function registerPreviews(app: FastifyInstance, previews: PreviewsPort): void {
  const operation = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    reply.header('cache-control', 'private, no-store');
    const controller = new AbortController(),
      cancel = (): void => controller.abort(),
      close = (): void => {
        if (!reply.raw.writableEnded) cancel();
      };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', close);
    try {
      return await work(controller.signal);
    } finally {
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', close);
    }
  };
  for (const kind of ['cover', 'avatar'] as const)
    app.get(`/api/subjects/:id/${kind}.jpg`, async (request, reply) => {
      const id = subject.parse((request.params as { id: string }).id);
      const query = z.object({ cached: z.literal('1').optional() }).parse(request.query);
      const bytes = await operation(request, reply, (signal) =>
        kind === 'avatar'
          ? (previews.avatar?.(id, signal) ?? Promise.reject(new PreviewError('preview_not_found')))
          : previews.cover(id, signal, query.cached === '1'),
      ).catch((error) => {
        if (
          (kind === 'avatar' || query.cached === '1') &&
          error instanceof PreviewError &&
          error.code === 'preview_not_found'
        )
          return null;
        throw error;
      });
      if (!bytes) return reply.code(204).send();
      const type = previewImageType(bytes);
      if (!type) throw new PreviewError('preview_failed');
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
      reply.header('cache-control', 'private, no-cache').header('etag', etag);
      const validators = request.headers['if-none-match']
        ?.split(',')
        .map((value) => value.trim().replace(/^W\//, ''));
      if (validators?.includes(etag) || validators?.includes('*')) return reply.code(304).send();
      return reply.type(type).send(Buffer.from(bytes));
    });
  app.get('/api/subjects/:id/snapshot-point', async (request, reply) => {
    const id = subject.parse((request.params as { id: string }).id);
    const query = z
      .object({
        at: z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .parse(request.query);
    return operation(request, reply, (signal) => previews.snapshotPoint(id, query.at, signal));
  });
  app.get('/api/subjects/:id/snapshot-pages', async (request, reply) => {
    const id = subject.parse((request.params as { id: string }).id);
    const query = z
      .object({
        at: z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER - 1),
        page: z
          .union([z.literal('last'), z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER)])
          .default(1),
        limit: z.coerce.number().int().min(1).max(MAX_SNAPSHOT_PAGE_SIZE).default(30),
        follow: z.literal('1').optional(),
        unitId: z.string().uuid().optional(),
        from: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        to: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .refine((value) => value.to > value.from && value.to - value.from <= 9 * 86400000)
      .parse(request.query);
    if (!previews.snapshotPages) throw new PreviewError('preview_unavailable');
    return operation(request, reply, (signal) =>
      previews.snapshotPages!(
        id,
        query.at,
        query.page === 'last' ? Number.MAX_SAFE_INTEGER : query.page,
        query.limit,
        signal,
        {
          fromMs: query.from,
          toMs: query.to,
        },
        query.follow === '1',
        query.unitId,
      ),
    );
  });
  app.get('/api/subjects/:id/snapshots/:at.jpg', async (request, reply) => {
    const params = request.params as { id: string; at: string },
      id = subject.parse(params.id);
    const at = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(params.at);
    const query = z
      .object({
        to: z.coerce.number().int().max(Number.MAX_SAFE_INTEGER).optional(),
        unit: z.string().uuid().optional(),
      })
      .strict()
      .refine((value) => value.to === undefined || (value.to > at && value.to - at <= 86460000))
      .parse(request.query);
    const bytes = await operation(request, reply, (signal) =>
      query.unit
        ? previews.snapshot(id, at, signal, query.to, query.unit)
        : previews.snapshot(id, at, signal, query.to),
    ).catch((error) => {
      if (error instanceof PreviewError && error.code === 'preview_pending') return null;
      throw error;
    });
    if (!bytes) return reply.header('retry-after', '1').code(202).send({ pending: true });
    return reply.type('image/jpeg').send(Buffer.from(bytes));
  });
}
