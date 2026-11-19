import path from 'node:path';
import { closeRuntimeLogs } from './runtime/runtime-logs.js';
import { mkdir, realpath, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openArchive } from './archive/index.js';
import { createProvider } from './provider/index.js';
import { StatusEvidence } from './provider/status-evidence.js';
import { accountSiteOrigin, SiteRoutes } from './provider/site-routes.js';
import { NetworkRouting } from './network/network-routing.js';
import { runBackground } from './runtime/background.js';
import { createSupervisor } from './capture/supervisor.js';
import { KeyVault } from './http/key-vault.js';
import { buildApp } from './http/app.js';
import { createShutdown, drainServices } from './runtime/lifecycle.js';
import type { AccountSyncPort, ProviderPort, SupervisorPort } from './ports.js';
import { SettingsStore } from './runtime/settings.js';
import { SyncClock } from './runtime/sync-clock.js';
import { ResourceMonitor } from './runtime/resources.js';
import { ArchiveHealthMonitor } from './runtime/archive-health.js';
import { createAccountSync } from './account/account-sync.js';
import { createRunEvents } from './runtime/run-events.js';
import { createPreviews } from './previews/index.js';
import type { PreviewsPort } from './ports.js';
import { createIngressHub, type IngressHub } from './ingest/index.js';
import { ingressMemoryBytes } from './ingest/memory-config.js';
import { createLiveProxy } from './live/index.js';
import { resolveDataDirectory } from './runtime/data-path.js';
import { getExecutionPolicy } from './runtime/execution-policy.js';

const moduleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const parentManifest = path.join(moduleRoot, '..', 'package.json');
let localBuild = false;
if (path.basename(path.normalize(moduleRoot)) === 'build') {
  try {
    localBuild =
      (JSON.parse(await readFile(parentManifest, 'utf8')) as { name?: string }).name === 'st-vault';
  } catch {
    /* A deployed image has no parent checkout. */
  }
}
const projectRoot = localBuild ? path.dirname(path.normalize(moduleRoot)) : moduleRoot;
const startupAt = performance.now();
let previousStageAt = startupAt;
const startupStage = (stage: string): void => {
  const at = performance.now();
  console.info(
    JSON.stringify({
      event: 'startup_stage',
      stage,
      durationMs: Math.round(at - previousStageAt),
      elapsedMs: Math.round(at - startupAt),
    }),
  );
  previousStageAt = at;
};
const configuredRoot = resolveDataDirectory(projectRoot, process.env.STV_DATA_DIR);
await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
const root = await realpath(configuredRoot);
const mediaRoot = path.resolve(projectRoot, process.env.STV_MEDIA_DIR ?? 'media');
const port = Number(process.env.STV_PORT ?? 10002);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
const execution = getExecutionPolicy();
const archive = await openArchive({ root, mediaRoot, ...execution.archive });
const libraryId = (
  JSON.parse(await readFile(path.join(mediaRoot, 'library.json'), 'utf8')) as { id: string }
).id;
startupStage('archive');
let runtimeSettings: SettingsStore | undefined;
const clock = new SyncClock({
  intervalMs: () => runtimeSettings?.get().pollMs ?? 5000,
});
const runEvents = createRunEvents(
  archive,
  () => {
    console.error(JSON.stringify({ event: 'event_heartbeat_failed' }));
  },
  clock,
);
let outcome: 'normal' | 'abnormal' = 'normal';
let supervisor: SupervisorPort | undefined;
let resources: ResourceMonitor | undefined;
let accountSync: AccountSyncPort | undefined;
let previews: PreviewsPort | undefined;
let ingress: IngressHub | undefined;
let statusEvidence: StatusEvidence | undefined;
let archiveHealth: ArchiveHealthMonitor | undefined;
const sites = new SiteRoutes();
let network: NetworkRouting | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
// The same ownership graph handles normal exit and partial initialization.
const stop = createShutdown({
  closeProducers: async () => {
    archiveHealth?.close();
    clock.stop();
    sites.close();
    await drainServices([
      () => network?.close(),
      () => runEvents.pause(),
      () =>
        app
          ? app.close()
          : drainServices([
              () => supervisor?.close(),
              () => accountSync?.close(),
              () => previews?.close(),
            ]),
      () => ingress?.close(),
      () => statusEvidence?.close(),
      () => resources?.close(),
      () => clock.close(),
    ]);
  },
  closeArchive: async () => {
    await runEvents.finish(outcome);
    await archive.close();
    console.info(JSON.stringify({ event: 'shutdown_complete', outcome }));
    await closeRuntimeLogs();
  },
});
try {
  const vault = await KeyVault.open(root, archive);
  network = await NetworkRouting.open(archive, sites, { keyLookup: vault.lookup });
  // Restore the account origin before admitting any anonymous network workers.
  const upstream = createProvider({
    sites,
    accountOrigin: accountSiteOrigin(process.env.STV_ACCOUNT_ORIGIN),
    onCoverObserved: (id, source) => previews?.observeCover?.(id, source),
  });
  accountSync = await createAccountSync({
    origin: accountSiteOrigin(process.env.STV_ACCOUNT_ORIGIN),
    clock,
    archive,
    provider: upstream,
    supervisor: { reconcile: () => supervisor?.reconcile() ?? Promise.resolve() },
    vault,
    onImported: (ids) => previews?.warmCovers?.(ids),
  });
  const bindAccountSite = (): void =>
    sites.configure(
      accountSync!.status().origin ?? accountSiteOrigin(process.env.STV_ACCOUNT_ORIGIN),
    );
  bindAccountSite();
  accountSync.subscribe?.(bindAccountSite);
  previews = createPreviews({
    ...execution.previews,
    sites,
    clock,
    archive,
    cacheRoot: path.join(root, 'jobs', libraryId),
    mediaRoot,
    ffmpegPath: process.env.STV_FFMPEG_PATH,
    canGenerate: () => resources?.canRecord() ?? false,
  });
  const settings = (runtimeSettings = await SettingsStore.open(archive));
  resources = new ResourceMonitor({
    clock,
    root: mediaRoot,
    dataRoot: root,
    archive,
    settings: settings.get,
    changed: () => {
      if (supervisor) runBackground(supervisor.reconcile(), 'storage_reconcile_failed');
    },
  });
  // Admission needs a writable disk, not a completed retention/integrity sweep.
  // The existing resources heartbeat owns that bounded maintenance after startup.
  await resources.checkDisk();
  startupStage('storage');
  const storage = resources;
  const evidence = (statusEvidence = new StatusEvidence({
    ...execution.status,
    provider: upstream,
    clock,
    intervalMs: () => settings.get().pollMs,
    persist: (id, status, at, lease, transitionAt) =>
      archive.setObservation(id, status, at, lease, transitionAt),
  }));
  const mediaMemoryBytes = ingressMemoryBytes(
    process.env.STV_INGRESS_MEMORY_MB,
    execution.memoryBytes,
  );
  console.info(
    JSON.stringify({
      event: 'ingress_memory_config',
      maxBytes: mediaMemoryBytes,
      containerLimitBytes: process.constrainedMemory(),
    }),
  );
  const sharedIngress = (ingress = createIngressHub({
    evidence,
    maxBytes: mediaMemoryBytes,
    preferredCdn: network.preferredCdn,
    onCdnSelected: network.selectedCdn,
    onCdnStopped: network.stoppedCdn,
    provider: upstream,
    keyLookup: vault.lookup,
    onKeySample: vault.observeSample,
    sourceCheckpoint: (id) => archive.sourceCheckpoint(id),
  }));
  network.subscribeCdn(() => sharedIngress.changeCdn());
  const provider: ProviderPort = {
    ...upstream,
    capture: (subject, sink, signal) =>
      sharedIngress.capture(
        subject,
        {
          commit: async (input) => {
            if (Date.now() - storage.get().checkedAtMs > 1000) await storage.checkDisk();
            if (!storage.canRecord()) throw new Error('STORAGE_LOW_OR_UNAVAILABLE');
            return sink.commit(input);
          },
        },
        signal,
      ),
  };
  supervisor = createSupervisor({
    statusConcurrency: execution.status.publicConcurrency,
    evidence,
    clock,
    archive,
    provider,
    runtime: settings.get,
    canRecord: storage.canRecord,
  });
  resources.start();
  const live = createLiveProxy({ ...execution.live, archive, provider, ingress: sharedIngress });
  app = await buildApp({
    clock,
    archive,
    provider,
    supervisor,
    vault,
    accountSync,
    previews,
    settings,
    resources,
    siteRoutes: () => sites.status(),
    network,
    archiveHealth: () =>
      archiveHealth?.get() ?? {
        error: 'archive_checking',
        checkedAtMs: 0,
        failures: 0,
        recovery: 'none',
      },
    live,
    backgroundTasks: () => [runEvents.backgroundTask()],
    ingressStats: () => sharedIngress.stats(),
    secureCookie: process.env.STV_SECURE_COOKIE === '1',
    allowedOrigins: ['http://127.0.0.1:5174', 'http://localhost:5174'],
  });
  const onSignal = (): void => {
    runBackground(
      stop().catch((error) => {
        process.exitCode = 1;
        throw error;
      }),
      'shutdown_failed',
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  const abnormal = (error: unknown): void => {
    outcome = 'abnormal';
    process.exitCode = 1;
    console.error('abnormal_shutdown', error);
    runBackground(stop(), 'abnormal_shutdown_failed');
  };
  archiveHealth = new ArchiveHealthMonitor({
    probe: () => archive.getSetting('health.probe'),
    intervalMs: () => settings.get().pollMs,
    canRestart: () =>
      storage.canRecord() && storage.maintenanceError() !== 'archive_integrity_check_failed',
    restart: (reason) => abnormal(new Error(reason)),
  });
  process.once('uncaughtException', abnormal);
  process.once('unhandledRejection', abnormal);
  const host = process.env.STV_HOST ?? '127.0.0.1';
  startupStage('services');
  await app.listen({ host, port });
  startupStage('http_listening');
  archiveHealth.start(clock);
  if (await runEvents.start())
    console.log(
      JSON.stringify({
        event: 'server_ready',
        host,
        port,
        isolatedDataRoot: root,
      }),
    );
} catch (error) {
  outcome = 'abnormal';
  try {
    await stop();
  } catch (cleanupError) {
    console.error('shutdown_failed', cleanupError);
  }
  throw error;
}
