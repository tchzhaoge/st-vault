import { randomUUID } from 'node:crypto';
import { runtimeLogDestination, logContext } from '../runtime/runtime-logs.js';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  accountSyncConfigSchema,
  policySchema,
  timelineSchema,
  type ArchiveHealthStatus,
  type SiteRoutesStatus,
  type BackgroundTask,
  type SnapshotJobsStatus,
  type MediaDeletionJob,
} from '@st-vault/api-schema';
import type {
  AccountSyncPort,
  ArchivePort,
  PreviewsPort,
  ProviderPort,
  SupervisorPort,
} from '../ports.js';
import { defaultRuntimeSettings, type SettingsStore } from '../runtime/settings.js';
import type { ResourceMonitor } from '../runtime/resources.js';
import { LocalAuth, LocalAuthError, sessionToken, setupToken } from './auth.js';
import type { KeyVault } from './key-vault.js';
import { createKeyValidation } from './key-validation.js';
import { AccountSyncError, createAccountSync } from '../account/account-sync.js';
import { createPreviews, PreviewError } from '../previews/index.js';
import { registerPreviews } from './previews.js';
import { registerStatusHistory } from './status-history.js';
import { createLiveProxy, type LiveProxy } from '../live/index.js';
import { registerLive } from './live.js';
import { registerEvents } from './events.js';
import { registerAccountAvatar } from './account-avatar.js';
import { createSyncHub } from './sync.js';
import { registerWorkbench } from './workbench.js';
import { getExecutionPolicy } from '../runtime/execution-policy.js';
import { registerPersonal } from './personal.js';
import { registerMediaSelection } from './media-selection.js';
import { recordingRange } from './recording-range.js';
import { registerPlayback } from './playback.js';
import { SyncClock } from '../runtime/sync-clock.js';
import { drainServices } from '../runtime/lifecycle.js';
import { runBackground } from '../runtime/background.js';
import type { NetworkRouting } from '../network/network-routing.js';
import { registerNetworkRouting } from './network-routing.js';
import { backgroundOverview } from '../runtime/background-status.js';
import { buildInfo } from '../runtime/build-info.js';
import { deploymentTimeZone } from '../runtime/time-zone.js';
import { acceptsRequestOrigin } from './request-origin.js';
import { credentialTransport } from './access-transport.js';

interface AppOptions {
  clock?: SyncClock;
  archive: ArchivePort;
  provider: ProviderPort;
  supervisor: SupervisorPort;
  vault: KeyVault;
  now?: () => number;
  secureCookie?: boolean;
  uiRoot?: string;
  allowedOrigins?: string[];
  settings?: SettingsStore;
  resources?: ResourceMonitor;
  archiveHealth?: () => ArchiveHealthStatus;
  siteRoutes?: () => SiteRoutesStatus;
  network?: NetworkRouting;
  accountSync?: AccountSyncPort;
  previews?: PreviewsPort;
  live?: LiveProxy;
  backgroundTasks?: () => BackgroundTask[];
  ingressStats?: () => { subjects: number; retainedBytes: number; maxBytes: number };
}
const subjectId = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(10))));
const pinSchema = z.object({ pin: z.string().regex(/^[0-9]{6}$/) }).strict();
const setupSessionSchema = z.object({ password: z.string().min(1).max(256).optional() }).strict();
const keySchema = z
  .object({
    name: z
      .string()
      .regex(/^\S{1,128}$/)
      .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name)),
    value: z.string().trim().min(1).max(1024),
  })
  .strict();

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const timeZone = deploymentTimeZone();
  const { archive, provider, supervisor, vault } = options;
  const keyValidation = createKeyValidation(
    vault,
    options.network?.keySample.bind(options.network),
  );
  const now = options.now ?? Date.now;
  const auth = await LocalAuth.open(archive, now);
  const clock =
    options.clock ??
    new SyncClock({
      intervalMs: () => options.settings?.get().pollMs ?? defaultRuntimeSettings.pollMs,
      now,
    });
  const accountSync =
    options.accountSync ??
    (await createAccountSync({
      archive,
      provider,
      supervisor,
      vault,
      now,
      clock,
    }));
  const app = Fastify({
    logger: runtimeLogDestination
      ? {
          stream: runtimeLogDestination,
          serializers: {
            req: (request: FastifyRequest) => ({
              method: request.method,
              route: request.routeOptions.url,
            }),
          },
        }
      : false,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 512 * 1024,
  });
  app.addHook('onRequest', (request, reply, done) => {
    request.log.info({
      event: 'http_started',
      method: request.method,
      route: request.routeOptions.url,
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished)
        request.log.warn({
          event: 'http_aborted',
          route: request.routeOptions.url,
          elapsedMs: Math.round(reply.elapsedTime),
        });
    });
    logContext.run({ requestId: request.id }, done);
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      event: 'http_completed',
      method: request.method,
      route: request.routeOptions.url,
      status: reply.statusCode,
      elapsedMs: Math.round(reply.elapsedTime),
      subjectId:
        typeof request.params === 'object' &&
        request.params !== null &&
        'id' in request.params &&
        typeof request.params.id === 'string' &&
        /^stripchat:\d+$/.test(request.params.id)
          ? request.params.id
          : undefined,
    });
  });
  app.addHook('onError', async (request, _reply, error) => {
    request.log.warn({ event: 'http_failed', err: error, route: request.routeOptions.url });
  });
  const previews =
    options.previews ?? createPreviews({ archive, ffmpegPath: process.env.STV_FFMPEG_PATH });
  const live =
    options.live ??
    createLiveProxy({
      archive,
      provider,
      keyLookup: vault.lookup,
      onKeySample: vault.observeSample,
    });
  const operations = new Map<AbortController, string>();
  // Like runtime settings, expose the last durable value without blocking health
  // reporting on another database read. This process owns policy writes.
  let recordAll = (await archive.getSetting('recording.default')) === 'true';
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const publicRoutes = new Set(['/api/session', '/api/setup/session', '/api/login', '/api/logout']);
  let setupCompleting = false;
  let ready = true;
  const tokenOf = (cookie?: string): string | undefined => sessionToken(cookie);
  const sync = createSyncHub({
    clock,
    authorized: (owner) => auth.authenticated(owner),
    now,
    read: async () => {
      const [subjects, meta, personal] = await Promise.all([
        archive.listSubjects(),
        archive.eventMeta(),
        archive.personalRevision(),
      ]);
      const states = supervisor.states(),
        diagnostics = supervisor.diagnostics?.() ?? {},
        account = accountSync.status();
      return {
        subjects: JSON.stringify(
          subjects.map((subject) => [
            subject.id,
            subject.handle,
            subject.formerNames,
            subject.providerStatus,
            subject.monitorEnabled,
            subject.archived,
            subject.autoRecord,
            subject.lastRecordedAtMs,
            subject.lastOnlineAtMs,
            states[subject.id],
          ]),
        ),
        timeline: JSON.stringify([
          Object.entries(diagnostics).map(([id, item]) => [id, item.lastSuccessMs]),
          Math.floor(now() / clock.intervalMs()),
        ]),
        events: JSON.stringify(meta),
        personal: String(personal),
        playback: '',
        account: JSON.stringify(account),
        keys: String(vault.count),
        system: JSON.stringify([
          options.resources?.get(),
          options.settings?.get(),
          states,
          account,
        ]),
      };
    },
  });
  // One durable capture transition refreshes both the button and its coverage.
  const detachCapture = supervisor.subscribe?.(() => sync.notify(['subjects', 'timeline']));
  const detachAccount = accountSync.subscribe?.(() => sync.notify(['account', 'system']));
  const detachPlayback = live.subscribe?.(() => sync.notify('playback'));
  const detachNetwork = options.network?.subscribe(() => sync.notify('system'));
  app.addHook('onClose', (_instance, done) => {
    detachCapture?.();
    detachAccount?.();
    detachPlayback?.();
    detachNetwork?.();
    done();
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    const url = request.url.split('?')[0];
    if (
      url === '/api/account-sync' ||
      url.startsWith('/api/account-sync/') ||
      url.startsWith('/api/setup')
    )
      reply.header('cache-control', 'no-store, private');
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !acceptsRequestOrigin(request.headers, options.allowedOrigins)
    )
      return reply.code(403).send({ error: 'origin_rejected' });
    const setupAccess =
      request.method === 'POST' &&
      url === '/api/setup' &&
      auth.setupAuthorized(setupToken(request.headers.cookie));
    if (
      url.startsWith('/api/') &&
      !publicRoutes.has(url) &&
      !auth.authenticated(tokenOf(request.headers.cookie)) &&
      !setupAccess
    )
      return reply.code(401).send({ error: 'unauthorized' });
    if (!ready && url !== '/health/live') return reply.code(503).send({ error: 'stopping' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request' });
    const code = error instanceof Error ? error.message : '';
    if (code === 'unauthorized') return reply.code(401).send({ error: 'unauthorized' });
    if (code === 'ALREADY_CONFIGURED') return reply.code(409).send({ error: 'already_configured' });
    if (error instanceof LocalAuthError) {
      if (error.code === 'rate_limited') reply.header('retry-after', error.retryAfterSeconds ?? 60);
      return reply
        .code(error.code === 'rate_limited' ? 429 : error.code === 'invalid_password' ? 401 : 409)
        .send({ error: error.code });
    }
    if (code === 'SUBJECT_NOT_FOUND') return reply.code(404).send({ error: 'subject_not_found' });
    if (code === 'SUBJECT_ARCHIVED') return reply.code(409).send({ error: 'subject_archived' });
    if (code === 'CURSOR_STALE') return reply.code(409).send({ error: 'cursor_stale' });
    if (['STALE_DELETE_PLAN', 'MEDIA_SELECTION_STALE', 'PERSONAL_REVISION_STALE'].includes(code))
      return reply.code(409).send({ error: 'media_selection_stale' });
    if (code === 'COMMAND_ID_CONFLICT')
      return reply.code(409).send({ error: 'command_id_conflict' });
    if (code === 'MEDIA_DELETION_PENDING')
      return reply.code(503).send({ error: 'media_deletion_pending' });
    if (code === 'METADATA_READ_BUSY' || code === 'MEDIA_SELECTION_QUEUE_FULL')
      return reply.header('retry-after', 1).code(503).send({ error: 'archive_busy' });
    if (code === 'MEDIA_DELETION_QUEUE_FULL')
      return reply.code(429).send({ error: 'media_deletion_queue_full' });
    if (code === 'INVALID_MEDIA_SELECTION')
      return reply.code(400).send({ error: 'invalid_request' });
    if (code === 'INVALID_CURSOR') return reply.code(400).send({ error: 'invalid_cursor' });
    if (code === 'ACCOUNT_SYNC_HTTPS_REQUIRED')
      return reply.code(412).send({ error: 'account_sync_https_required' });
    if (code === 'KEYS_HTTPS_REQUIRED')
      return reply.code(412).send({ error: 'keys_https_required' });
    if (error instanceof AccountSyncError) {
      const status =
        error.code === 'cookies_invalid' || error.code === 'account_sync_disconnected'
          ? 400
          : error.code === 'cookies_expired'
            ? 422
            : error.code === 'account_sync_busy' ||
                error.code === 'account_sync_cancelled' ||
                error.code === 'account_origin_locked'
              ? 409
              : error.code === 'account_sync_unavailable'
                ? 503
                : error.code === 'account_sync_timeout'
                  ? 504
                  : 502;
      return reply.code(status).send({ error: error.code });
    }
    if (error instanceof PreviewError)
      return reply
        .code(
          error.code === 'preview_not_found'
            ? 404
            : error.code === 'preview_busy'
              ? 429
              : error.code === 'preview_unavailable'
                ? 503
                : error.code === 'preview_cancelled'
                  ? 409
                  : 502,
        )
        .send({ error: error.code });
    if (
      ['ARCHIVE_REQUIRES_RECOVERY', 'ARCHIVE_CLOSED', 'METADATA_WORKER_UNAVAILABLE'].includes(code)
    )
      return reply.code(503).send({ error: 'archive_unavailable' });
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ error: 'invalid_request' });
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.get('/health/live', (_request, reply) => reply.send({ ok: true }));
  app.get('/health/ready', async (_request, reply) => {
    const health = options.archiveHealth?.();
    if (health)
      return reply.code(ready && !health.error ? 200 : 503).send({ ready: ready && !health.error });
    try {
      await archive.getSetting('health.probe');
      return reply.code(ready ? 200 : 503).send({ ready });
    } catch {
      return reply.code(503).send({ ready: false });
    }
  });
  app.get('/api/session', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const authenticated = auth.authenticated(tokenOf(request.headers.cookie));
    return {
      authenticated,
      timeZone,
      setupRequired: await auth.setupRequired(),
      credential: auth.credential() ?? undefined,
      setupAuthorized: auth.setupAuthorized(setupToken(request.headers.cookie)),
      ...(authenticated ? await archive.identity() : {}),
    };
  });
  app.get('/api/sync', (request, reply) => {
    const token = tokenOf(request.headers.cookie);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    if (!sync.open(token, reply.raw)) return reply.code(429).send({ error: 'sync_busy' });
    reply.hijack();
    return reply;
  });
  app.addHook('onResponse', (request, reply, done) => {
    if (
      reply.statusCode < 400 &&
      !['GET', 'HEAD'].includes(request.method) &&
      !request.url.endsWith('/preview')
    ) {
      const route = request.url.split('?')[0];
      if (route.includes('/subjects/')) {
        sync.invalidate('subjects');
        sync.invalidate('timeline');
      }
      if (route.includes('/account-sync')) sync.invalidate('account');
      if (route.includes('/keys')) sync.notify('keys');
      if (route.includes('/settings')) sync.invalidate('system');
      if (route.startsWith('/api/network/')) sync.invalidate('system');
      if (route.includes('/events/read')) sync.invalidate('events');
      if (route.startsWith('/api/me/')) sync.invalidate('personal');
    }
    done();
  });
  app.post('/api/diagnostics/player', async (request, reply) => {
    const value = z
      .object({
        subjectId: subjectId,
        media: z.enum(['live', 'archive']),
        phase: z.enum([
          'engine',
          'manifest',
          'decoding',
          'buffering',
          'network',
          'decoder',
          'ended',
          'blocked',
        ]),
        ready: z.boolean(),
        error: z.string().max(1024),
      })
      .strict()
      .parse(request.body);
    request.log.info({ event: 'browser_player_state', ...value });
    return reply.code(204).send();
  });
  const limitAuth = (request: FastifyRequest): void => {
    for (const [key, record] of loginAttempts) if (record.until <= now()) loginAttempts.delete(key);
    const previous = loginAttempts.get(request.ip);
    if (previous && previous.count >= 10)
      throw new LocalAuthError(
        'rate_limited',
        Math.max(1, Math.ceil((previous.until - now()) / 1000)),
      );
    if (loginAttempts.size >= 1000 && !previous) throw new LocalAuthError('rate_limited', 60);
    loginAttempts.set(request.ip, {
      count: (previous?.count ?? 0) + 1,
      until: previous?.until ?? now() + 60000,
    });
  };
  app.post('/api/setup/session', { bodyLimit: 1024 }, async (request, reply) => {
    if (!safeAccountTransport(request)) throw new Error('ACCOUNT_SYNC_HTTPS_REQUIRED');
    const { password } = setupSessionSchema.parse(request.body);
    limitAuth(request);
    const token = await auth.beginSetup(password, setupToken(request.headers.cookie));
    loginAttempts.delete(request.ip);
    reply.header('set-cookie', auth.setupCookie(token, transport(request).secureCookie));
    return { ok: true };
  });
  app.post('/api/setup', { bodyLimit: 1024 }, async (request, reply) => {
    if (!safeAccountTransport(request)) throw new Error('ACCOUNT_SYNC_HTTPS_REQUIRED');
    const { pin } = pinSchema.parse(request.body);
    const owner = setupToken(request.headers.cookie);
    if (!owner || !auth.setupAuthorized(owner)) throw new LocalAuthError('setup_expired');
    if (setupCompleting) throw new LocalAuthError('setup_busy');
    setupCompleting = true;
    try {
      const token = await auth.completeSetup(pin, owner);
      reply.header('set-cookie', [
        auth.cookie(token, transport(request).secureCookie),
        auth.clearSetupCookie(transport(request).secureCookie),
      ]);
      return { ok: true };
    } finally {
      setupCompleting = false;
    }
  });
  app.post('/api/login', { bodyLimit: 1024 }, async (request, reply) => {
    if (!safeAccountTransport(request)) throw new Error('ACCOUNT_SYNC_HTTPS_REQUIRED');
    const { pin } = pinSchema.parse(request.body);
    limitAuth(request);
    const token = await auth.login(pin);
    if (!token) return reply.code(401).send({ error: 'invalid_pin' });
    loginAttempts.delete(request.ip);
    reply.header('set-cookie', auth.cookie(token, transport(request).secureCookie));
    return { ok: true };
  });
  app.post('/api/logout', async (request, reply) => {
    const token = tokenOf(request.headers.cookie);
    const setup = setupToken(request.headers.cookie);
    for (const [controller, owner] of operations) if (owner === token) controller.abort();
    if (setup) {
      await auth.logout(setup);
    }
    await auth.logout(token);
    if (token) sync.closeOwner(token);
    if (token) await live.destroyOwner(token);
    if (token) playback.closeOwner(token);
    reply.header('set-cookie', [
      auth.clearCookie(transport(request).secureCookie),
      auth.clearSetupCookie(transport(request).secureCookie),
    ]);
    return { ok: true };
  });
  const transport = (request: FastifyRequest) =>
    credentialTransport(request.headers, request.protocol, options.secureCookie);
  const safeAccountTransport = (request: FastifyRequest): boolean => transport(request).allowed;
  const accountOperation = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const owner = tokenOf(request.headers.cookie);
    if (!owner || !auth.authenticated(owner)) throw new Error('unauthorized');
    const controller = new AbortController();
    operations.set(controller, owner);
    const detach = clock.subscribe(
      'account-operation-expiry',
      () => {
        if (!auth.authenticated(owner)) controller.abort();
      },
      { everyPulse: true },
    );
    const cancel = (): void => controller.abort(),
      disconnected = (): void => {
        if (!reply.raw.writableEnded) cancel();
      };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', disconnected);
    try {
      return await run(controller.signal);
    } finally {
      operations.delete(controller);
      detach();
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', disconnected);
    }
  };
  app.get('/api/account-sync', () => accountSync.status());
  registerAccountAvatar(app, accountSync);
  registerEvents(app, archive);
  const execution = getExecutionPolicy();
  registerWorkbench(app, archive, {
    maxRequests: Math.max(4, Math.min(16, Math.floor(execution.networkConcurrency / 4))),
    rowConcurrency: 3,
    totalRowConcurrency: Math.max(
      3,
      Math.min(8, Math.floor(execution.database.interactiveConnections / 2)),
    ),
  });
  if (options.network) registerNetworkRouting(app, options.network, accountSync, archive);
  registerPersonal(app, archive);
  app.put('/api/account-sync', async (request, reply) => {
    if (!safeAccountTransport(request)) throw new Error('ACCOUNT_SYNC_HTTPS_REQUIRED');
    const config = accountSyncConfigSchema.parse(request.body);
    return accountOperation(request, reply, (signal) => accountSync.configure(config, signal));
  });
  app.delete('/api/account-sync', async (request, reply) => {
    if (!safeAccountTransport(request)) throw new Error('ACCOUNT_SYNC_HTTPS_REQUIRED');
    const draft = await accountSync.disconnect();
    reply.header('cache-control', 'no-store, private');
    return { draft, status: accountSync.status() };
  });
  app.get('/api/keys', () => ({ keyCount: vault.count }));
  app.route({
    method: ['GET', 'PUT'],
    url: '/api/keys/current',
    async handler(request, reply) {
      reply.header('cache-control', 'no-store, private');
      if (!safeAccountTransport(request)) throw new Error('KEYS_HTTPS_REQUIRED');
      if (request.method === 'PUT') {
        await vault.replace(keySchema.parse(request.body));
        keyValidation.start(true);
      }
      return {
        keyCount: vault.count,
        key: vault.key,
        status: vault.status(),
        checking: keyValidation.checking,
      };
    },
  });
  app.get('/api/subjects', async () => {
    const states = supervisor.states();
    const diagnostics = supervisor.diagnostics?.() ?? {};
    return (await archive.listSubjects()).map((subject) => ({
      ...subject,
      captureState: states[subject.id] ?? 'IDLE',
      captureError: diagnostics[subject.id]?.error ?? null,
      lastCapturedAtMs: diagnostics[subject.id]?.lastSuccessMs ?? null,
    }));
  });
  app.post('/api/subjects', async (request, reply) => {
    const input = z
      .object({
        providerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        handle: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .parse(request.body);
    const id = `stripchat:${input.providerId}`;
    await archive.upsertSubjects([
      {
        id,
        providerId: input.providerId,
        handle: input.handle ?? `主播 #${input.providerId}`,
      },
    ]);
    runBackground(supervisor.reconcile(), 'recording_reconcile_failed');
    return reply.code(201).send(await archive.getSubject(id));
  });
  app.patch('/api/subjects/policies', async (request) => {
    const requestedAtMs = Date.now();
    const input = z
      .object({
        ids: z.array(subjectId).min(1).max(1000),
        policy: policySchema,
      })
      .strict()
      .parse(request.body);
    const updated = await archive.setPolicies([...new Set(input.ids)], input.policy);
    await supervisor.requestRecording?.(input.ids, requestedAtMs);
    console.info(
      JSON.stringify({
        event: 'recording_policy_applied',
        subjects: input.ids.length,
        elapsedMs: Date.now() - requestedAtMs,
      }),
    );
    // Acknowledge the durable local policy, without waiting for every remote
    // status batch. Reconcile revokes disabled generations before polling.
    runBackground(supervisor.reconcile(), 'recording_reconcile_failed');
    return { updated };
  });
  app.put('/api/subjects/recording-default', async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const requestedAtMs = Date.now();
    await archive.setGlobalRecording(enabled);
    recordAll = enabled;
    sync.notify(['subjects', 'system']);
    runBackground(
      (async () => {
        const ids = (await archive.listSubjects()).filter((s) => !s.archived).map((s) => s.id);
        await supervisor.requestRecording?.(ids, requestedAtMs);
        await supervisor.reconcile();
      })(),
      'recording_reconcile_failed',
    );
    return { enabled };
  });
  app.patch('/api/subjects/:id/policy', async (request) => {
    const requestedAtMs = Date.now();
    const id = subjectId.parse((request.params as { id: string }).id);
    const subject = await archive.setPolicy(id, policySchema.parse(request.body));
    await supervisor.requestRecording?.([id], requestedAtMs);
    runBackground(supervisor.reconcile(), 'recording_reconcile_failed');
    const diagnostic = supervisor.diagnostics?.()[id];
    return {
      ...subject,
      captureState: supervisor.states()[id] ?? 'IDLE',
      captureError: diagnostic?.error ?? null,
      lastCapturedAtMs: diagnostic?.lastSuccessMs ?? null,
    };
  });
  app.get('/api/subjects/:id/timeline', async (request) => {
    const id = subjectId.parse((request.params as { id: string }).id);
    const query = timelineSchema.parse(request.query);
    const cursor = z
      .string()
      .max(4096)
      .optional()
      .parse((request.query as { cursor?: string }).cursor);
    return archive.timeline(id, query.from, query.to, query.limit, cursor);
  });
  app.get('/api/subjects/:id/coverage', async (request) => {
    const id = subjectId.parse((request.params as { id: string }).id);
    const query = z
      .object({
        from: z.coerce.number().int().nonnegative(),
        to: z.coerce.number().int().positive(),
        buckets: z.coerce.number().int().min(1).max(720).default(240),
      })
      .refine((value) => value.to > value.from && value.to - value.from <= 31 * 86400000)
      .parse(request.query);
    return archive.coverage(id, query.from, query.to, query.buckets);
  });
  app.get('/api/subjects/:id/recording-bounds', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const id = subjectId.parse((request.params as { id: string }).id);
    const query = z
      .object({
        from: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        to: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .refine((value) => value.to > value.from && value.to - value.from <= 9 * 86400000)
      .parse(request.query);
    const range = await recordingRange(archive, id, query.from, query.to);
    return {
      subjectId: id,
      fromMs: range?.fromMs ?? null,
      toMs: range?.toMs ?? null,
    };
  });
  registerPreviews(app, previews);
  const playback = registerPlayback(app, {
    archive,
    clock,
    now,
    ownerOf: (request) => {
      const token = tokenOf(request.headers.cookie);
      return auth.authenticated(token) ? token : undefined;
    },
  });
  registerStatusHistory(app, archive);
  registerMediaSelection(app, archive, clock);
  registerLive(app, live, {
    ownerOf: (request) => {
      const token = tokenOf(request.headers.cookie);
      return auth.authenticated(token) ? token : undefined;
    },
  });
  app.post('/api/subjects/:id/delete-unlocated', async (request) =>
    archive.deleteUnlocated(subjectId.parse((request.params as { id: string }).id)),
  );
  const failedTaskReaders = new Set<string>();
  const readStatus = async <T>(scope: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      const result = await read();
      if (failedTaskReaders.delete(scope))
        app.log.info({ event: 'background_status_recovered', scope });
      return result;
    } catch (error) {
      if (!failedTaskReaders.has(scope)) {
        failedTaskReaders.add(scope);
        app.log.warn({
          event: 'background_status_unavailable',
          scope,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
      return fallback;
    }
  };
  const readTasks = (
    scope: string,
    read: () => Promise<BackgroundTask[]>,
    fallback: BackgroundTask[],
  ) =>
    readStatus(
      scope,
      read,
      fallback.map((task) => ({
        ...task,
        state: 'error' as const,
        error: 'task_status_unavailable',
      })),
    );
  app.get('/api/system', async (_request, reply) => {
    const settings = options.settings?.get() ?? defaultRuntimeSettings;
    const archiveFallback: BackgroundTask[] = [
      { id: 'archive-index', group: 'processing', state: 'disabled' },
      { id: 'favorite-materialization', group: 'processing', state: 'disabled' },
      { id: 'library-checkpoint', group: 'protection', state: 'disabled' },
      { id: 'orphan-sweep', group: 'processing', state: 'disabled' },
    ];
    const previewFallback: BackgroundTask[] = [
      { id: 'cover-sync', group: 'sync', state: 'disabled' },
      { id: 'avatar-sync', group: 'sync', state: 'disabled' },
      { id: 'snapshot-maintenance', group: 'processing', state: 'disabled' },
    ];
    const [snapshotJobs, archiveTasks, previewTasks, deletions] = await Promise.all([
      readStatus<SnapshotJobsStatus | null>(
        'snapshots',
        () => previews.jobs?.() ?? Promise.resolve(null),
        {
          mode: 'unavailable',
          pending: 0,
          failed: 0,
          completed: 0,
          averageMs: 0,
          error: 'task_status_unavailable',
        },
      ),
      readTasks(
        'archive',
        () => archive.backgroundTasks?.() ?? Promise.resolve(archiveFallback),
        archiveFallback,
      ),
      readTasks(
        'previews',
        () => previews.backgroundTasks?.() ?? Promise.resolve(previewFallback),
        previewFallback,
      ),
      readStatus<MediaDeletionJob[] | null>(
        'deletions',
        () => archive.deletionJobs?.() ?? Promise.resolve([]),
        null,
      ),
    ]);
    const capturedAtMs = now(),
      states = Object.values(supervisor.states()),
      network = options.network?.status(),
      siteRoutes = options.siteRoutes?.() ?? network?.sites;
    const tasks = backgroundOverview({
      clock: clock.status(),
      account: accountSync.status(),
      sites: siteRoutes,
      snapshots: snapshotJobs,
      deletions,
      tasks: [
        ...archiveTasks,
        ...previewTasks,
        ...(options.resources?.backgroundTasks() ?? []),
        ...(options.backgroundTasks?.() ?? []),
      ],
      client: sync.status(),
    });
    return reply.send({
      capturedAtMs,
      backgroundTasks: tasks,
      ingress: options.ingressStats?.() ?? null,
      ...buildInfo,
      settings,
      recordAll,
      snapshotJobs,
      disk: options.resources?.get() ?? {
        freeBytes: 0,
        totalBytes: 0,
        lowSpace: true,
        error: 'not_configured',
        checkedAtMs: 0,
      },
      maintenanceError: options.resources?.maintenanceError() ?? null,
      archiveHealth: options.archiveHealth?.() ?? null,
      siteRoutes: siteRoutes ?? null,
      capture: {
        pollMs: settings.pollMs,
        active: states.filter((state) => state === 'CAPTURING').length,
        starting: states.filter((state) => state === 'RESOLVING' || state === 'QUEUED').length,
        retrying: states.filter((state) => state === 'BACKOFF').length,
      },
    });
  });
  app.put('/api/settings', async (request, reply) => {
    if (!options.settings) return reply.code(503).send({ error: 'settings_unavailable' });
    const settings = await options.settings.update(request.body);
    runBackground(
      options.resources?.check() ?? Promise.resolve(),
      'settings_resources_check_failed',
    );
    runBackground(supervisor.reconcile(), 'settings_reconcile_failed');
    return settings;
  });
  app.get('/api/media/:id', async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const object = await archive.media(id);
    if (!object) return reply.code(404).send({ error: 'media_not_found' });
    const size = (await stat(object.path)).size;
    reply
      .type(object.contentType)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, no-store');
    let start = 0,
      end = size - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (match[1] === '' && match[2] === ''))
        return reply.header('content-range', `bytes */${size}`).code(416).send();
      if (match[1] === '') {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
          return reply.header('content-range', `bytes */${size}`).code(416).send();
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      )
        return reply.header('content-range', `bytes */${size}`).code(416).send();
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
    }
    reply.header('content-length', end - start + 1);
    return reply.send(createReadStream(object.path, { start, end }));
  });
  const uiRoot = path.resolve(
    options.uiRoot ?? fileURLToPath(new URL('../../../ui/dist/', import.meta.url)),
  );
  const sendUiFile = async (relative: string): Promise<{ file: string; type: string } | null> => {
    const candidate = path.resolve(uiRoot, relative);
    if (!candidate.startsWith(uiRoot + path.sep)) return null;
    try {
      const actual = await realpath(candidate);
      if (!actual.startsWith((await realpath(uiRoot)) + path.sep) || !(await stat(actual)).isFile())
        return null;
      return {
        file: actual,
        type: candidate.endsWith('.js')
          ? 'text/javascript'
          : candidate.endsWith('.css')
            ? 'text/css'
            : candidate.endsWith('.html')
              ? 'text/html'
              : candidate.endsWith('.png')
                ? 'image/png'
                : 'application/octet-stream',
      };
    } catch {
      return null;
    }
  };
  app.get('/', async (_request, reply) => {
    const file = await sendUiFile('index.html');
    return file
      ? reply.type(file.type).send(createReadStream(file.file))
      : reply.code(503).send({ error: 'ui_not_built' });
  });
  app.get('/assets/*', async (request, reply) => {
    const file = await sendUiFile(`assets/${(request.params as { '*': string })['*']}`);
    return file ? reply.type(file.type).send(createReadStream(file.file)) : reply.code(404).send();
  });
  app.addHook('preClose', async () => {
    ready = false;
    for (const controller of operations.keys()) controller.abort();
    await drainServices([
      () => sync.close(),
      () => supervisor.close(),
      () => accountSync.close(),
      () => previews.close(),
      () => live.close(),
      () => playback.close(),
      () => keyValidation.close(),
    ]);
    if (!options.clock) await clock.close();
  });
  keyValidation.start();
  return app;
}
