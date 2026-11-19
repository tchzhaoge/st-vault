import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { MAX_SNAPSHOT_SELECTION } from '@st-vault/api-schema';
import type { ArchivePort } from '../ports.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { runBackground } from '../runtime/background.js';

const subject = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((v) => Number.isSafeInteger(Number(v.slice(10))));
const utc = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const exceptions = {
  includeUnitIds: z.array(z.string().uuid()).max(MAX_SNAPSHOT_SELECTION).default([]),
  excludeUnitIds: z.array(z.string().uuid()).max(MAX_SNAPSHOT_SELECTION).default([]),
};
/** Cancellation owns preparation only; accepted durable commands continue independently. */
async function prepare<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  request.raw.once('aborted', cancel);
  reply.raw.once('close', cancel);
  try {
    return await action(controller.signal);
  } finally {
    request.raw.removeListener('aborted', cancel);
    reply.raw.removeListener('close', cancel);
  }
}
export function registerMediaSelection(
  app: FastifyInstance,
  archive: ArchivePort,
  clock?: SyncClock,
): void {
  app.post('/api/subjects/:id/unit-seen', async (request, reply) => {
    if (!archive.markUnitsSeen) return reply.code(503).send({ error: 'archive_unavailable' });
    const id = subject.parse((request.params as { id: string }).id);
    const { evidence } = z
      .object({
        evidence: z
          .array(z.object({ unitId: z.string().uuid(), toMs: utc }).strict())
          .min(1)
          .max(100),
      })
      .strict()
      .parse(request.body);
    return archive.markUnitsSeen(id, evidence);
  });
  app.post('/api/subjects/:id/media-selection', async (request, reply) => {
    if (!archive.prepareMediaSelection)
      return reply.code(503).send({ error: 'archive_unavailable' });
    const id = subject.parse((request.params as { id: string }).id);
    const input = z
      .object({
        fromMs: utc,
        toMs: utc,
        mode: z.enum(['unliked', 'all', 'explicit']),
        baseSelectionId: z.string().uuid().optional(),
        ...exceptions,
      })
      .strict()
      .refine((v) => v.toMs > v.fromMs && v.toMs - v.fromMs <= 9 * 86400000)
      .parse(request.body);
    return prepare(request, reply, (signal) =>
      archive.prepareMediaSelection!(id, input, input.mode, signal, input),
    );
  });
  app.post(
    '/api/subjects/:id/media-selection/:selectionId/favorites',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      if (!archive.favoriteMediaSelection)
        return reply.code(503).send({ error: 'archive_unavailable' });
      const params = z
        .object({ id: subject, selectionId: z.string().uuid() })
        .parse(request.params);
      const input = z
        .object({ liked: z.boolean(), revision: utc, ...exceptions })
        .strict()
        .parse(request.body);
      return prepare(request, reply, (signal) =>
        archive.favoriteMediaSelection!(
          params.id,
          params.selectionId,
          input.liked,
          input.revision,
          input,
          signal,
        ),
      );
    },
  );
  app.post(
    '/api/subjects/:id/unit-favorites/query',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!archive.unitFavoriteQuery) return reply.code(503).send({ error: 'archive_unavailable' });
      const id = subject.parse((request.params as { id: string }).id);
      const input = z
        .object({ unitIds: z.array(z.string().uuid()).max(MAX_SNAPSHOT_SELECTION) })
        .strict()
        .parse(request.body);
      return archive.unitFavoriteQuery(id, input.unitIds);
    },
  );
  app.post(
    '/api/subjects/:id/unit-favorites',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      if (!archive.unitFavorites) return reply.code(503).send({ error: 'archive_unavailable' });
      const id = subject.parse((request.params as { id: string }).id);
      const input = z
        .object({
          unitIds: z.array(z.string().uuid()).min(1).max(MAX_SNAPSHOT_SELECTION),
          liked: z.boolean(),
          revision: utc,
        })
        .strict()
        .parse(request.body);
      return archive.unitFavorites(id, input.unitIds, input.liked, input.revision);
    },
  );
  const resume = (): Promise<void> => archive.resumeDeletions?.() ?? Promise.resolve();
  const detach = clock?.subscribe('media-deletions', resume);
  const resumeFavorites = (): Promise<void> => archive.resumeFavorites?.() ?? Promise.resolve();
  const detachFavorites = clock?.subscribe('favorite-materialization', resumeFavorites);
  runBackground(resumeFavorites(), 'favorite_materialization_failed');
  runBackground(resume(), 'media_deletion_resume_failed');
  app.addHook('preClose', () => {
    detach?.();
    detachFavorites?.();
    return Promise.resolve();
  });
  app.get('/api/media-deletions', () => archive.deletionJobs?.() ?? Promise.resolve([]));
  app.post(
    '/api/subjects/:id/deletion-intents',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      if (!archive.admitDeletion) return reply.code(503).send({ error: 'archive_unavailable' });
      const id = subject.parse((request.params as { id: string }).id);
      const bounds = { fromMs: utc, toMs: utc };
      const patch = z.object(exceptions).strict().optional();
      const target = z
        .discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('units'),
              ...bounds,
              unitIds: z.array(z.string().uuid()).min(1).max(MAX_SNAPSHOT_SELECTION),
            })
            .strict(),
          z
            .object({
              kind: z.literal('selection'),
              ...bounds,
              selectionId: z.string().uuid(),
              patch,
            })
            .strict(),
          z
            .object({
              kind: z.literal('range'),
              ...bounds,
              mode: z.enum(['all', 'unliked']),
              baseSelectionId: z.string().uuid().optional(),
              patch,
            })
            .strict(),
        ])
        .refine((v) => v.toMs > v.fromMs && v.toMs - v.fromMs <= 9 * 86400000);
      const input = z.object({ commandId: z.string().uuid(), target }).strict().parse(request.body);
      return reply.code(202).send(await archive.admitDeletion(id, input.commandId, input.target));
    },
  );
  app.post(
    '/api/subjects/:id/delete-selection/preview',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const id = subject.parse((request.params as { id: string }).id);
      const input = z
        .object({
          unitIds: z.array(z.string().uuid()).min(1).max(MAX_SNAPSHOT_SELECTION).optional(),
          selectionId: z.string().uuid().optional(),
          ...exceptions,
        })
        .strict()
        .refine((value) => [value.unitIds, value.selectionId].filter(Boolean).length === 1)
        .parse(request.body);
      if (input.selectionId) {
        if (!archive.planMediaSelectionDeletion)
          return reply.code(503).send({ error: 'archive_unavailable' });
        return prepare(request, reply, (signal) =>
          archive.planMediaSelectionDeletion!(id, input.selectionId!, input, signal),
        );
      }
      if (!archive.planUnitDeletion) return reply.code(503).send({ error: 'archive_unavailable' });
      return prepare(request, reply, (signal) =>
        archive.planUnitDeletion!(id, input.unitIds!, signal),
      );
    },
  );
  app.post('/api/subjects/:id/delete-selection', async (request, reply) => {
    if (!archive.deleteSelection) return reply.code(503).send({ error: 'archive_unavailable' });
    const id = subject.parse((request.params as { id: string }).id);
    const input = z
      .object({ planId: z.string().uuid(), personalRevision: utc })
      .strict()
      .parse(request.body);
    return reply
      .code(202)
      .send(await archive.deleteSelection(id, input.planId, input.personalRevision));
  });
}
