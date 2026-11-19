import path from 'node:path';
import type { ArchivePort } from '../ports.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { createHttp, ProviderError } from '../provider/http.js';
import { SiteRoutes } from '../provider/site-routes.js';
import { coverSource } from '../provider/cover-source.js';
import { PreviewDiskCache } from './disk-cache.js';
import { LibraryImages } from '../library/images.js';
import { previewImageType } from './image-type.js';
import type { BackgroundTask } from '@st-vault/api-schema';
import { DerivativeDiagnostics } from './derivative-diagnostics.js';

/** Requested portraits share the process heartbeat; reads never start upstream work. */
export function createSubjectAvatars(options: {
  root: string;
  mediaRoot?: string;
  archive: Pick<ArchivePort, 'getSetting' | 'setSetting' | 'listSubjects'> &
    Partial<Pick<ArchivePort, 'withBackgroundReads'>>;
  clock?: SyncClock;
  fetch?: typeof fetch;
  sites?: SiteRoutes;
  concurrency?: number;
  publishConcurrency?: number;
}) {
  if (
    !Number.isInteger(options.concurrency ?? 2) ||
    (options.concurrency ?? 2) < 1 ||
    (options.concurrency ?? 2) > 64
  )
    throw Error('INVALID_AVATAR_CONCURRENCY');
  const sites =
    options.sites ??
    new SiteRoutes({ origins: ['https://stripchat.com'], fetch: options.fetch, timeoutMs: 5000 });
  const disk = options.mediaRoot
    ? new LibraryImages(options.mediaRoot, 'avatar', options.publishConcurrency)
    : new PreviewDiskCache(path.join(options.root, 'avatars'), 64 * 1024 ** 2, 2048);
  const pending = new Set<string>();
  const failures = new Set<string>();
  const diagnostics = new DerivativeDiagnostics();
  const controller = new AbortController();
  const http = createHttp({
    fetch: options.fetch,
    timeoutMs: 5000,
    allow: (url) => coverSource(url.href) !== null,
  });
  let work: Promise<void> | undefined;
  let lastRunAtMs: number | null = null,
    lastSuccessAtMs: number | null = null,
    failed = false;
  const refresh = (): Promise<void> => {
    if (work) return work;
    if (controller.signal.aborted) return Promise.resolve();
    if (!pending.size) return Promise.resolve();
    const run = async () => {
      lastRunAtMs = Date.now();
      const subjects = new Map((await options.archive.listSubjects()).map((row) => [row.id, row]));
      const attempted = new Set<string>();
      failed = false;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const id = [...pending].find((id) => !attempted.has(id));
          if (!id) return;
          attempted.add(id);
          pending.delete(id);
          const row = subjects.get(id);
          if (!row) {
            failures.delete(id);
            continue;
          }
          let source: string | null = null;
          try {
            source = coverSource(await options.archive.getSetting(`preview.avatar-source.${id}`));
            if (!source) {
              const user = await sites.read(
                `/api/front/v2/models/${row.providerId}/cam`,
                (text) => {
                  const value = JSON.parse(text) as {
                    user?: { user?: { id?: number; avatarUrl?: unknown } };
                  };
                  const user = value?.user?.user;
                  if (!user) throw new ProviderError('upstream-item-unavailable');
                  if (user.id !== row.providerId)
                    throw new ProviderError('upstream-identity-mismatch');
                  return user;
                },
                controller.signal,
              );
              source = coverSource(user.avatarUrl);
            }
            if (!source) {
              failures.delete(id);
              continue;
            }
            const key = `avatar:${id}`,
              versionKey = `preview.avatar-version.${id}`;
            const previous = await disk.get(key);
            if (
              previous &&
              previewImageType(previous) &&
              (await options.archive.getSetting(versionKey)) === source
            ) {
              failures.delete(id);
              continue;
            }
            const bytes = await http.bytes(source, {
              signal: controller.signal,
              maxBytes: 512 * 1024,
            });
            if (!previewImageType(bytes)) throw Error('INVALID_AVATAR_IMAGE');
            if (!(previous && Buffer.from(previous).equals(bytes)) && !(await disk.put(key, bytes)))
              throw Error('AVATAR_CACHE_WRITE_FAILED');
            await options.archive.setSetting(versionKey, source);
            failures.delete(id);
          } catch (error) {
            if (!controller.signal.aborted) {
              failures.add(id);
              pending.add(id);
              diagnostics.record(
                'avatar_refresh_failed',
                error,
                'warn',
                source ? new URL(source).hostname : undefined,
              );
            }
          }
        }
      };
      await Promise.all(Array.from({ length: options.concurrency ?? 2 }, () => worker()));
      if (attempted.size && !failures.size && !failed && !controller.signal.aborted)
        lastSuccessAtMs = Date.now();
    };
    work = (options.archive.withBackgroundReads?.(run) ?? run())
      .catch((error: unknown) => {
        if (!controller.signal.aborted) failed = true;
        throw error;
      })
      .finally(() => {
        work = undefined;
      });
    return work;
  };
  const stop = options.clock?.subscribe('subject-avatars', refresh);
  return {
    status: (): BackgroundTask => ({
      id: 'avatar-sync',
      group: 'sync',
      state: work
        ? 'running'
        : failed || failures.size
          ? 'retrying'
          : pending.size
            ? 'waiting'
            : 'idle',
      pending: pending.size,
      failed: failures.size + Number(failed),
      lastRunAtMs,
      lastSuccessAtMs,
      error: failed || failures.size ? 'avatar_refresh_partial' : null,
    }),
    read: async (id: string): Promise<Uint8Array | null> => {
      if (controller.signal.aborted || !/^stripchat:[1-9]\d*$/.test(id)) return null;
      pending.add(id);
      if (pending.size > 2048) {
        const oldest = pending.values().next().value!;
        pending.delete(oldest);
        failures.delete(oldest);
      }
      const bytes = await disk.get(`avatar:${id}`);
      return bytes && previewImageType(bytes) ? bytes : null;
    },
    refresh,
    close: async () => {
      stop?.();
      controller.abort();
      if (!options.sites) sites.close();
      try {
        await work;
      } finally {
        pending.clear();
        failures.clear();
        diagnostics.close();
        await disk.close();
      }
    },
  };
}
