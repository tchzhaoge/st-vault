import { accountSiteOrigin } from '../provider/site-routes.js';
import { createHash } from 'node:crypto';
import { runBackground } from '../runtime/background.js';
import { z } from 'zod';
import { accountSyncConfigSchema } from '@st-vault/api-schema';
import type { AccountSyncConfig, AccountSyncResult, AccountSyncStatus } from '@st-vault/api-schema';
import type { AccountSyncPort, ProviderPort, SupervisorPort } from '../ports.js';
import type { KeyVault } from '../http/key-vault.js';
import { createHttp, ProviderError, waitFor } from '../provider/http.js';
import { accountAvatarSource } from '../provider/account-profile.js';
import type { ImportedAccount, ImportedAccountProfile } from '../provider/account-profile.js';
import { previewImageType } from '../previews/image-type.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { AccountActivation, type AccountActivationArchive } from './account-activation.js';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const errorCodes = [
  'cookies_invalid',
  'cookies_domain_mismatch',
  'account_origin_invalid',
  'account_origin_redirect',
  'cookies_expired',
  'account_access_denied',
  'account_network_unavailable',
  'account_verification_required',
  'list_import_failed',
  'account_sync_timeout',
  'account_sync_unavailable',
  'account_library_changed',
] as const;
const storedProfileSchema = z
  .object({
    username: z.string().trim().min(1).max(256),
    followingCount: z.number().int().min(0).max(10000000),
    avatarSourceUrl: z.string().max(2048).nullable(),
  })
  .strict();
const storedSchema = z
  .object({
    version: z.literal(1),
    cookiesText: z.string().min(1).max(65536),
    origin: z.string().url().optional(),
    lastAttemptMs: timestamp,
    lastSuccessMs: timestamp,
    lastImportedCount: z.number().int().nonnegative().nullable(),
    error: z.enum(errorCodes).nullable(),
    needsReconnect: z.boolean(),
    profile: storedProfileSchema.nullable(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;
type FailureCode =
  | (typeof errorCodes)[number]
  | 'account_sync_disconnected'
  | 'account_sync_busy'
  | 'account_sync_cancelled'
  | 'account_origin_locked';
export class AccountSyncError extends Error {
  constructor(
    readonly code: FailureCode,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
  }
}
interface Job {
  generation: number;
  controller: AbortController;
  kind: 'configure' | 'refresh' | 'disconnect' | 'recover';
  work: Promise<AccountSyncResult>;
  timedOut: boolean;
  accepted: boolean;
}
export interface AccountSyncOptions {
  clock: SyncClock;
  origin?: string;
  onImported?: (subjectIds: string[]) => void | Promise<void>;
  archive: AccountActivationArchive;
  provider: Pick<ProviderPort, 'importList'> & {
    importAccount?: (
      cookiesText: string,
      signal?: AbortSignal,
      onValidated?: () => void,
      origin?: string,
    ) => Promise<ImportedAccount>;
  };
  supervisor: Pick<SupervisorPort, 'reconcile'>;
  vault: Pick<KeyVault, 'readSealedSecret' | 'writeSealedSecret'>;
  now?: () => number;
  timeoutMs?: number;
  startupDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}
export interface AccountSyncService extends AccountSyncPort {
  avatar(signal?: AbortSignal): Promise<Uint8Array>;
}
function failure(error: unknown): (typeof errorCodes)[number] {
  if (error instanceof Error && error.message === 'ACCOUNT_ACTIVATION_LIBRARY_MISMATCH')
    return 'account_library_changed';
  if (error instanceof ProviderError) {
    if (error.code === 'upstream-request') return 'account_network_unavailable';
    if (error.code === 'request-deadline') return 'account_sync_timeout';
    if (error.challenge) return 'account_verification_required';
    if (error.code === 'cookies-domain-mismatch') return 'cookies_domain_mismatch';
    if (error.code === 'account-redirect-denied') return 'account_origin_redirect';
    if (['invalid-cookies', 'no-applicable-cookies'].includes(error.code)) return 'cookies_invalid';
    if (error.code === 'account-session-unavailable' || error.status === 401)
      return 'cookies_expired';
    if (error.code === 'upstream-http' && error.status === 403) return 'account_access_denied';
  }
  return error instanceof AccountSyncError &&
    errorCodes.includes(error.code as (typeof errorCodes)[number])
    ? (error.code as (typeof errorCodes)[number])
    : 'list_import_failed';
}

/** One persisted account, one actual importer, and bounded scheduling across restarts. */
export async function createAccountSync(options: AccountSyncOptions): Promise<AccountSyncService> {
  const defaultOrigin = accountSiteOrigin(options.origin);
  const now = options.now ?? Date.now,
    timeoutMs = options.timeoutMs ?? 120000,
    startupDelayMs = options.startupDelayMs ?? 10000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isFinite(startupDelayMs) ||
    startupDelayMs < 1
  )
    throw new Error('INVALID_ACCOUNT_SYNC_OPTIONS');
  let closed = false,
    generation = 0,
    notBeforeMs = 0,
    nextAttemptMs: number | null = null;
  let tail: Promise<unknown> = Promise.resolve(),
    active: Job | undefined,
    closing: Promise<void> | undefined;
  const jobs = new Set<Job>();
  const pendingCovers = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  let warming: Promise<void> | undefined;
  let stage: AccountSyncStatus['stage'];
  const warmCovers = (ids: string[]): void => {
    if (!options.onImported || closed) return;
    for (const id of ids) pendingCovers.add(id);
    if (warming) return;
    warming = Promise.resolve()
      .then(async () => {
        while (!closed && pendingCovers.size) {
          const batch = [...pendingCovers];
          pendingCovers.clear();
          try {
            await options.onImported!(batch);
          } catch (error) {
            console.warn(
              'Imported cover warming failed',
              error instanceof Error ? error.name : 'unknown',
            );
          }
        }
      })
      .finally(() => {
        warming = undefined;
        notify();
        if (pendingCovers.size && !closed) warmCovers([]);
      });
    notify();
  };
  const avatarHttp = createHttp({
    fetch: options.fetch,
    timeoutMs: 5000,
    allow: (url) => accountAvatarSource(url.href) !== null,
  });
  interface AvatarTask {
    key: string;
    controller: AbortController;
    done: Promise<Uint8Array>;
  }
  const avatarTasks = new Set<AvatarTask>();
  let avatarPending: AvatarTask | undefined,
    avatarCache: { key: string; bytes: Uint8Array; expires: number } | undefined;
  const avatarKey = (): string =>
    connection.active?.profile
      ? JSON.stringify([
          connection.active.profile.username,
          connection.active.profile.avatarSourceUrl,
        ])
      : '';
  const clearAvatar = (): void => {
    avatarCache = undefined;
    avatarPending = undefined;
    for (const task of avatarTasks) task.controller.abort();
  };
  const empty = (): Omit<AccountSyncStatus, 'connected' | 'running' | 'nextAttemptMs'> => ({
    needsReconnect: false,
    lastAttemptMs: null,
    lastSuccessMs: null,
    lastImportedCount: null,
    error: null,
  });
  let state = empty();
  const adopt = (value: Stored): void => {
    state = {
      needsReconnect: value.needsReconnect,
      lastAttemptMs: value.lastAttemptMs,
      lastSuccessMs: value.lastSuccessMs,
      lastImportedCount: value.lastImportedCount,
      error: value.error,
    };
  };
  let committedAvatarKey = '';
  const connection = new AccountActivation<Stored>({
    archive: options.archive,
    vault: options.vault,
    parse: (value) => {
      const parsed = storedSchema.parse(value);
      return { ...parsed, origin: accountSiteOrigin(parsed.origin ?? defaultOrigin) };
    },
    changed: () => {
      if (connection.active) adopt(connection.active);
      else state = empty();
      const nextAvatarKey = avatarKey();
      if (nextAvatarKey !== committedAvatarKey) clearAvatar();
      committedAvatarKey = nextAvatarKey;
      notify();
    },
  });
  try {
    await connection.load();
    if (connection.recovering) await connection.recover();
  } catch (error) {
    state = {
      ...state,
      error:
        failure(error) === 'account_library_changed'
          ? 'account_library_changed'
          : 'account_sync_unavailable',
      needsReconnect: failure(error) === 'account_library_changed' || !connection.recovering,
    };
  }
  const status = (): AccountSyncStatus => ({
    origin: connection.active?.origin ?? defaultOrigin,
    ...state,
    ...(stage ? { stage } : {}),
    ...(warming ? { warmingCovers: true } : {}),
    profile: connection.active?.profile
      ? {
          username: connection.active.profile.username,
          followingCount: connection.active.profile.followingCount,
          avatarUrl: accountAvatarSource(connection.active.profile.avatarSourceUrl)
            ? `/api/account-sync/avatar?version=${createHash('sha256')
                .update(connection.active.profile.avatarSourceUrl ?? '')
                .digest('hex')
                .slice(0, 16)}`
            : null,
        }
      : null,
    connected: connection.active !== null,
    running: jobs.size > 0,
    nextAttemptMs,
  });
  const clearSchedule = (): void => {
    nextAttemptMs = null;
  };
  const dueAt = (): number =>
    Math.max(
      notBeforeMs,
      Math.max(
        connection.active?.lastAttemptMs ?? 0,
        connection.active?.lastSuccessMs ?? 0,
        state.lastAttemptMs ?? 0,
        state.lastSuccessMs ?? 0,
      ) + options.clock.intervalMs(),
    );
  const schedule = (startup = false): void => {
    clearSchedule();
    if (connection.recovering && state.error === 'account_library_changed') return;
    if (!closed && !jobs.size && connection.recovering) {
      nextAttemptMs = now() + options.clock.intervalMs();
      return;
    }
    if (closed || jobs.size || !connection.active || state.needsReconnect) return;
    // At most one network attempt per configured interval. Restarting never
    // bypasses the persisted attempt time; overdue startup waits a short grace.
    notBeforeMs = now() + (startup ? startupDelayMs : 1000);
    nextAttemptMs = dueAt();
  };
  const valid = (job: Job): void => {
    if (job.accepted) return;
    if (closed || job.generation !== generation || job.controller.signal.aborted)
      throw new AccountSyncError(job.timedOut ? 'account_sync_timeout' : 'account_sync_cancelled');
  };
  const invalidate = (): number => {
    generation++;
    clearSchedule();
    for (const job of jobs) if (!job.accepted) job.controller.abort();
    return generation;
  };
  const persist = async (value: Stored, job: Job): Promise<void> => {
    valid(job);
    try {
      await connection.update(value);
    } catch (error) {
      throw new AccountSyncError('account_sync_unavailable', error);
    }
    // The serialized vault write is the commit point. Cancellation cannot undo
    // an accepted durable write: adopt it before checking the generation again.
    // Later queued mutations therefore start from the same value as a restart.
    valid(job);
  };
  const launch = (
    kind: Job['kind'],
    number: number,
    run: (job: Job) => Promise<number | null>,
  ): Job => {
    const reportFailure = (code: (typeof errorCodes)[number]): void => {
      // A rejected candidate never replaced the saved credentials. Status belongs
      // to that committed connection; the caller receives the candidate's error.
      if (connection.recovering)
        state = { ...state, error: code, needsReconnect: code === 'account_library_changed' };
      else if (kind === 'configure' && connection.active) adopt(connection.active);
      else state = { ...state, error: code };
    };
    const job: Job = {
      kind,
      generation: number,
      controller: new AbortController(),
      timedOut: false,
      accepted: false,
      work: Promise.resolve({ imported: null, status: status() }),
    };
    const work = tail
      .catch(() => undefined)
      .then(async () => {
        valid(job);
        if (connection.recovering && kind !== 'disconnect') {
          try {
            await connection.recover();
          } catch (error) {
            throw new AccountSyncError(
              failure(error) === 'account_library_changed'
                ? 'account_library_changed'
                : 'account_sync_unavailable',
              error,
            );
          }
          valid(job);
        }
        const deadline = setTimeout(() => {
          if (job.accepted) return;
          job.timedOut = true;
          if (!closed && job.generation === generation) reportFailure('account_sync_timeout');
          job.controller.abort();
        }, timeoutMs);
        try {
          const imported = await run(job);
          valid(job);
          return { imported, status: { ...status(), running: false } };
        } catch (error) {
          if (!closed && job.generation === generation) {
            const code = job.controller.signal.aborted
              ? job.timedOut
                ? 'account_sync_timeout'
                : 'account_sync_cancelled'
              : failure(error);
            if (code !== 'account_sync_cancelled') reportFailure(code);
          }
          if (error instanceof AccountSyncError) throw error;
          throw new AccountSyncError(failure(error));
        } finally {
          clearTimeout(deadline);
        }
      });
    jobs.add(job);
    active = job;
    // Keep ownership until actual work settles, even when a caller/deadline
    // has already stopped waiting for an importer which ignores cancellation.
    job.work = work.finally(() => {
      jobs.delete(job);
      if (active === job) active = undefined;
      if (job.generation === generation) stage = undefined;
      notify();
      if (job.generation === generation || !jobs.size) schedule();
    });
    tail = job.work.catch(() => undefined);
    return job;
  };
  const wait = async (
    job: Job,
    signal?: AbortSignal,
    cancelOwner = false,
  ): Promise<AccountSyncResult> => {
    const cancel = (): void => {
      if (cancelOwner && !job.accepted) job.controller.abort();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await waitFor(waitFor(job.work, job.controller.signal), signal);
      return { imported: result.imported, status: status() };
    } catch (error) {
      if (job.controller.signal.aborted || signal?.aborted)
        throw new AccountSyncError(
          job.timedOut ? 'account_sync_timeout' : 'account_sync_cancelled',
        );
      if (error instanceof AccountSyncError) throw error;
      throw new AccountSyncError('list_import_failed');
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  const available = (): void => {
    if (closed) throw new AccountSyncError('account_sync_unavailable');
    if (jobs.size >= 8) throw new AccountSyncError('account_sync_busy');
  };
  const synchronize = async (
    job: Job,
    cookiesText: string,
    replacing: boolean,
    origin = connection.active?.origin ?? defaultOrigin,
  ): Promise<number> => {
    const attempt = now();
    stage = options.provider.importAccount ? 'validating' : 'syncing';
    notify();
    state = { ...state, lastAttemptMs: attempt, error: null };
    if (!replacing && connection.active)
      await persist({ ...connection.active, lastAttemptMs: attempt }, job);
    let subjects: Awaited<ReturnType<ProviderPort['importList']>>,
      profile: ImportedAccountProfile | null = !replacing
        ? (connection.active?.profile ?? null)
        : null;
    try {
      if (options.provider.importAccount) {
        const result = await options.provider.importAccount(
          cookiesText,
          job.controller.signal,
          () => {
            valid(job);
            stage = 'syncing';
            notify();
          },
          origin,
        );
        subjects = result.subjects;
        profile = storedProfileSchema.parse(result.profile);
        profile.avatarSourceUrl = accountAvatarSource(profile.avatarSourceUrl);
      } else subjects = await options.provider.importList(cookiesText, job.controller.signal);
    } catch (error) {
      valid(job);
      const code = failure(error);
      console.warn(
        JSON.stringify({ event: 'account_sync_failed', origin, code, operation: job.kind }),
      );
      if (!replacing && connection.active)
        await persist(
          {
            ...connection.active,
            lastAttemptMs: attempt,
            error: code,
            needsReconnect:
              connection.active.needsReconnect ||
              [
                'cookies_expired',
                'cookies_invalid',
                'cookies_domain_mismatch',
                'account_origin_redirect',
                'account_verification_required',
              ].includes(code),
          },
          job,
        );
      throw new AccountSyncError(code);
    }
    valid(job);
    // Only a complete successful import reconciles membership; recordings and local policies survive.
    stage = 'saving';
    notify();
    try {
      await connection.activate(
        subjects,
        {
          version: 1,
          origin,
          cookiesText,
          lastAttemptMs: attempt,
          lastSuccessMs: now(),
          lastImportedCount: subjects.length,
          error: null,
          needsReconnect: false,
          profile,
        },
        () => valid(job),
        () => {
          job.accepted = true;
        },
      );
    } catch (error) {
      if (error instanceof AccountSyncError) throw error;
      throw new AccountSyncError('account_sync_unavailable', error);
    }
    runBackground(options.supervisor.reconcile(), 'account_reconcile_failed');
    // Cover I/O has separate ownership from a successfully persisted account.
    warmCovers(subjects.map((subject) => subject.id));
    return subjects.length;
  };
  function refresh(signal?: AbortSignal): Promise<AccountSyncResult> {
    try {
      available();
      if (signal?.aborted) throw new AccountSyncError('account_sync_cancelled');
      if (active?.kind === 'refresh' && active.generation === generation)
        return wait(active, signal);
      if (jobs.size) throw new AccountSyncError('account_sync_busy');
      if (!connection.active) throw new AccountSyncError('account_sync_disconnected');
      clearSchedule();
      const current = connection.active;
      return wait(
        launch('refresh', generation, (job) => synchronize(job, current.cookiesText, false)),
        signal,
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new AccountSyncError('list_import_failed'),
      );
    }
  }
  const detachClock = options.clock.subscribe('account-list', async () => {
    if (!closed && connection.recovering && !jobs.size && nextAttemptMs !== null) {
      if (now() >= nextAttemptMs)
        await wait(
          launch('recover', generation, async (job) => {
            job.accepted = true;
            stage = 'saving';
            notify();
            await connection.recover();
            runBackground(options.supervisor.reconcile(), 'account_reconcile_failed');
            return connection.active?.lastImportedCount ?? null;
          }),
        );
      return;
    }
    if (
      !closed &&
      connection.active &&
      !state.needsReconnect &&
      !jobs.size &&
      nextAttemptMs !== null
    ) {
      nextAttemptMs = dueAt();
      if (now() >= nextAttemptMs) await refresh();
    }
  });
  schedule(true);
  return {
    status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    avatar: async (signal) => {
      if (closed) throw new AccountSyncError('account_sync_unavailable');
      if (signal?.aborted) throw new AccountSyncError('account_sync_cancelled');
      const key = avatarKey(),
        url = accountAvatarSource(connection.active?.profile?.avatarSourceUrl);
      if (!key || !url) throw new AccountSyncError('account_sync_disconnected');
      if (avatarCache?.key === key && avatarCache.expires > now()) return avatarCache.bytes;
      if (avatarPending?.key === key) return await waitFor(avatarPending.done, signal);
      if (avatarTasks.size >= 2) throw new AccountSyncError('account_sync_busy');
      const controller = new AbortController();
      const done = (async () => {
        try {
          const bytes = await avatarHttp.bytes(url, {
            signal: controller.signal,
            maxBytes: 512 * 1024,
          });
          if (closed || controller.signal.aborted || key !== avatarKey())
            throw new AccountSyncError('account_sync_disconnected');
          if (!previewImageType(bytes)) throw new AccountSyncError('account_sync_unavailable');
          avatarCache = { key, bytes, expires: now() + 300000 };
          return bytes;
        } catch (error) {
          if (error instanceof AccountSyncError) throw error;
          throw new AccountSyncError('account_sync_unavailable');
        }
      })();
      const task = { key, controller, done };
      avatarTasks.add(task);
      avatarPending = task;
      void done
        .finally(() => {
          avatarTasks.delete(task);
          if (avatarPending === task) avatarPending = undefined;
        })
        .catch(() => undefined);
      return await waitFor(done, signal);
    },
    configure: async (
      config: AccountSyncConfig,
      signal?: AbortSignal,
    ): Promise<AccountSyncResult> => {
      available();
      const parsed = accountSyncConfigSchema.parse(config);
      if (signal?.aborted) throw new AccountSyncError('account_sync_cancelled');
      let origin: string;
      try {
        origin = accountSiteOrigin(parsed.origin ?? connection.active?.origin ?? defaultOrigin);
      } catch {
        throw new AccountSyncError('account_origin_invalid');
      }
      if (connection.active && origin !== connection.active.origin)
        throw new AccountSyncError('account_origin_locked');
      const currentGeneration = invalidate();
      const job = launch('configure', currentGeneration, async (current) => {
        if (connection.active && origin !== connection.active.origin)
          throw new AccountSyncError('account_origin_locked');
        return synchronize(current, parsed.cookiesText, true, origin);
      });
      return wait(job, signal, true);
    },
    refresh,
    disconnect: async () => {
      available();
      let draft: AccountSyncConfig | null = null;
      const currentGeneration = invalidate();
      const job = launch('disconnect', currentGeneration, async (current) => {
        valid(current);
        try {
          // Capture committed credentials inside the serialized operation. Only
          // the explicit disconnect caller receives them after successful removal.
          const active = connection.active;
          draft = active ? { cookiesText: active.cookiesText, origin: active.origin } : null;
          await connection.disconnect();
          await options.supervisor.reconcile();
        } catch {
          throw new AccountSyncError('account_sync_unavailable');
        }

        valid(current);
        return null;
      });
      await wait(job);
      return draft;
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      listeners.clear();
      detachClock?.();
      invalidate();
      clearAvatar();
      pendingCovers.clear();
      closing = Promise.allSettled([
        tail,
        warming,
        ...[...avatarTasks].map((task) => task.done),
      ]).then(() => undefined);
      return closing;
    },
  };
}
