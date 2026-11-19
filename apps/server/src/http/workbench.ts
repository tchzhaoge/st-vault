import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  CoverageResponse,
  PublicStatus,
  StatusHistoryBucket,
  StatusHistoryResponse,
} from '@st-vault/api-schema';
import type { ArchivePort } from '../ports.js';
import { MediaBudget } from '../provider/media-budget.js';

export interface WorkbenchOptions {
  maxRequests?: number;
  rowConcurrency?: number;
  totalRowConcurrency?: number;
}

type WorkbenchArchive = Pick<ArchivePort, 'coverage' | 'statusHistory'>;
interface Row {
  subjectId: string;
  coverage: CoverageResponse;
  status: StatusHistoryResponse;
}
interface Task {
  cancel: () => void;
  done: Promise<void>;
}
const statuses: PublicStatus[] = ['UNKNOWN', 'PUBLIC', 'PRIVATE', 'OFFLINE'];
const subject = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(10))));
const querySchema = z
  .object({
    ids: z
      .string()
      .max(2048)
      .transform((value) => [...new Set(value.split(','))])
      .pipe(z.array(subject).min(1).max(24)),
    from: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    to: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    buckets: z.coerce.number().int().min(1).max(720).default(360),
    protection: z
      .string()
      .max(2048)
      .transform((value) => [...new Set(value.split(','))])
      .pipe(z.array(subject).max(24))
      .optional(),
  })
  .strict()
  .refine((value) => value.to > value.from && value.to - value.from <= 8 * 86400000);
function dominant(bucket: StatusHistoryBucket): PublicStatus {
  return statuses.reduce(
    (best, status) => (bucket.durationsMs[status] > bucket.durationsMs[best] ? status : best),
    'UNKNOWN',
  );
}
function compactStatus(response: StatusHistoryResponse): StatusHistoryResponse {
  const buckets: StatusHistoryBucket[] = [];
  let previousStatus: PublicStatus | undefined;
  for (const bucket of response.buckets) {
    const state = dominant(bucket),
      last = buckets.at(-1);
    if (last && previousStatus === state && last.toMs === bucket.fromMs) {
      last.toMs = bucket.toMs;
      for (const status of statuses) last.durationsMs[status] += bucket.durationsMs[status];
    } else buckets.push({ ...bucket, durationsMs: { ...bucket.durationsMs } });
    previousStatus = state;
  }
  return { ...response, buckets };
}
/** Hold the request slot while a slow client still owns its JSON payload. */
async function deliver(reply: FastifyReply, rows: Row[], signal: AbortSignal): Promise<void> {
  if (signal.aborted || reply.raw.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      reply.raw.removeListener('finish', done);
      reply.raw.removeListener('close', done);
      signal.removeEventListener('abort', cancel);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };
    const cancel = (): void => {
      reply.raw.destroy();
    };
    reply.raw.once('finish', done);
    reply.raw.once('close', done);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      reply.send({ rows });
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error('WORKBENCH_SEND_FAILED'));
    }
  });
}
/** Register in the authenticated app scope; batches contain no upstream requests or cache. */
export function registerWorkbench(
  app: FastifyInstance,
  archive: WorkbenchArchive,
  options: WorkbenchOptions = {},
): void {
  const tasks = new Set<Task>();
  const rowSlots = new MediaBudget(options.totalRowConcurrency ?? 8);
  let closed = false;
  app.get('/api/workbench', async (request, reply) => {
    const query = querySchema.parse(request.query);
    reply.header('cache-control', 'private, no-store');
    if (closed) return reply.code(503).send({ error: 'workbench_unavailable' });
    if (tasks.size >= (options.maxRequests ?? 4))
      return reply.code(429).send({ error: 'workbench_busy' });
    const controller = new AbortController(),
      cancel = (): void => controller.abort();
    const disconnected = (): void => {
      if (!reply.raw.writableFinished) cancel();
    };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', disconnected);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();
    const done = (async () => {
      const rows: Row[] = new Array<Row>(query.ids.length);
      let index = 0;
      const failedQuery = (error: unknown): never => {
        controller.abort();
        throw error;
      };
      const readRow = async (subjectId: string): Promise<Row | null> => {
        const release = await rowSlots.acquire(controller.signal);
        try {
          if (controller.signal.aborted) return null;
          // Both submitted calls must settle, including after a sibling fails.
          const results = await Promise.allSettled([
            Promise.resolve()
              .then(() =>
                controller.signal.aborted
                  ? null
                  : archive.coverage(
                      subjectId,
                      query.from,
                      query.to,
                      query.buckets,
                      query.protection?.includes(subjectId) ?? false,
                    ),
              )
              .catch(failedQuery),
            Promise.resolve()
              .then(() =>
                controller.signal.aborted
                  ? null
                  : archive.statusHistory(subjectId, query.from, query.to, query.buckets),
              )
              .catch(failedQuery),
          ]);
          const [coverage, status] = results;
          if (coverage.status === 'rejected' || status.status === 'rejected') {
            controller.abort();
            throw coverage.status === 'rejected'
              ? coverage.reason
              : status.status === 'rejected'
                ? status.reason
                : new Error('WORKBENCH_QUERY_FAILED');
          }
          if (controller.signal.aborted || !coverage.value || !status.value) return null;
          return {
            subjectId,
            coverage: {
              ...coverage.value,
              buckets: coverage.value.buckets.filter((bucket) => bucket.coveredMs > 0),
            },
            status: compactStatus(status.value),
          };
        } finally {
          release();
        }
      };
      const worker = async (): Promise<void> => {
        while (!controller.signal.aborted && index < query.ids.length) {
          const position = index++;
          const row = await readRow(query.ids[position]);
          if (row) rows[position] = row;
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: options.rowConcurrency ?? 3 }, () => worker()),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (!controller.signal.aborted) await deliver(reply, rows, controller.signal);
    })();
    const task: Task = {
      done,
      cancel: () => {
        controller.abort();
        if (!reply.raw.writableFinished) reply.raw.destroy();
      },
    };
    tasks.add(task);
    try {
      await done;
      return reply;
    } finally {
      tasks.delete(task);
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', disconnected);
    }
  });
  app.addHook('preClose', async () => {
    closed = true;
    for (const task of tasks) task.cancel();
    await Promise.allSettled([...tasks].map((task) => task.done));
  });
}
