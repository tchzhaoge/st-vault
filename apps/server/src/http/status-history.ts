import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArchivePort } from '../ports.js';

/** Register inside the app's authenticated API scope. No client chooses observation timestamps. */
export function registerStatusHistory(
  app: FastifyInstance,
  archive: Pick<ArchivePort, 'statusHistory'>,
): void {
  app.get('/api/subjects/:id/status-history', async (request, reply) => {
    const id = z
      .string()
      .regex(/^stripchat:[1-9]\d*$/)
      .refine((value) => Number.isSafeInteger(Number(value.slice(10))))
      .parse((request.params as { id: string }).id);
    const query = z
      .object({
        from: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        to: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        buckets: z.coerce.number().int().min(1).max(720).default(240),
      })
      .strict()
      .refine((value) => value.to > value.from && value.to - value.from <= 8 * 86400000)
      .parse(request.query);
    reply.header('cache-control', 'private, no-store');
    return archive.statusHistory(id, query.from, query.to, query.buckets);
  });
}
