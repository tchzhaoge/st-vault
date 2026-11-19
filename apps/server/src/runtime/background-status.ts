import type {
  AccountSyncStatus,
  BackgroundTask,
  MediaDeletionJob,
  SiteRoutesStatus,
  SnapshotJobsStatus,
} from '@st-vault/api-schema';
import type { ScheduledWorkStatus } from './sync-clock.js';

interface Input {
  clock: ScheduledWorkStatus[];
  account: AccountSyncStatus;
  sites?: SiteRoutesStatus;
  snapshots: SnapshotJobsStatus | null;
  deletions: MediaDeletionJob[] | null;
  tasks: BackgroundTask[];
  client: {
    clients: number;
    running: boolean;
    failed: boolean;
    lastRunAtMs: number | null;
    lastSuccessAtMs: number | null;
  };
}
/** Domain snapshots win over scheduler facts: a resolved callback is not proof of success. */
export function backgroundOverview(input: Input): BackgroundTask[] {
  const schedule = (
    name: string,
    id = name,
    group: BackgroundTask['group'] = 'sync',
  ): BackgroundTask => {
    const job = input.clock.find((item) => item.name === name);
    return {
      id,
      group,
      state: job?.running ? 'running' : job?.failed ? 'retrying' : job ? 'waiting' : 'disabled',
      lastRunAtMs: job?.lastStartedAtMs,
      nextRunAtMs: job?.nextTickAtMs,
      error: job?.failed
        ? name === 'run-heartbeat'
          ? 'run_heartbeat_failed'
          : 'status_sync_failed'
        : null,
      detail: 'schedule-only',
    };
  };
  const account = input.account,
    sites = input.sites,
    snapshots = input.snapshots;
  const active = (input.deletions ?? []).filter((job) => job.state !== 'completed');
  const boundOrigin = account.connected ? account.origin : undefined;
  const access = sites && boundOrigin && sites.access?.origin === boundOrigin ? sites.access : null;
  const siteError = access?.error;
  const siteReason = !siteError
    ? null
    : siteError.startsWith('upstream-challenge')
      ? 'site_verification_required'
      : siteError.startsWith('request-deadline') || siteError === 'site-deadline'
        ? 'site_request_timeout'
        : siteError.startsWith('upstream-request')
          ? 'site_network_unavailable'
          : siteError === 'upstream-http:429'
            ? 'site_rate_limited'
            : siteError === 'invalid-upstream-json' || siteError === 'invalid-utf8'
              ? 'site_response_invalid'
              : 'site_unavailable';
  const siteProbeFailed =
    !sites?.probing &&
    (sites?.probeProgress?.total ?? 0) > 0 &&
    sites?.probeProgress?.failed === sites?.probeProgress?.total;
  const tasks: BackgroundTask[] = [
    schedule('capture-status'),
    ...(input.clock.some((job) => job.name === 'public-status-evidence')
      ? [schedule('public-status-evidence', 'public-status-evidence', 'protection')]
      : []),
    {
      id: 'account-list',
      group: 'sync',
      state: account.running
        ? 'running'
        : account.needsReconnect || (!account.connected && !!account.error)
          ? 'error'
          : !account.connected
            ? 'disabled'
            : account.error
              ? 'retrying'
              : 'waiting',
      lastRunAtMs: account.lastAttemptMs,
      lastSuccessAtMs: account.lastSuccessMs,
      nextRunAtMs: account.needsReconnect ? null : account.nextAttemptMs,
      error: account.error ?? (account.needsReconnect ? 'account_reconnect' : null),
      detail: !account.connected ? 'account-disconnected' : account.stage,
    },
    account.connected
      ? {
          id: 'site-access',
          group: 'sync',
          state: access?.error
            ? 'error'
            : access?.checkedAtMs !== null && access?.checkedAtMs !== undefined
              ? 'idle'
              : 'waiting',
          target:
            boundOrigin && URL.canParse(boundOrigin) ? new URL(boundOrigin).hostname : undefined,
          lastRunAtMs: access?.checkedAtMs,
          lastSuccessAtMs: access?.lastSuccessAtMs,
          error: siteReason,
          detail: 'account-bound',
        }
      : {
          id: 'site-probe',
          group: 'sync',
          state: sites?.probing
            ? 'running'
            : siteProbeFailed
              ? 'error'
              : sites
                ? 'idle'
                : 'disabled',
          processed: sites?.probeProgress?.completed,
          total: sites?.probeProgress?.total,
          failed: sites?.probeProgress?.failed,
          lastRunAtMs: sites?.lastProbeAtMs,
          error: siteProbeFailed ? 'site_probe_failed' : null,
          detail: 'manual-site-probe',
        },
    {
      id: 'snapshots',
      group: 'processing',
      state: !snapshots
        ? 'disabled'
        : snapshots.mode === 'initializing'
          ? 'waiting'
          : snapshots.mode === 'unavailable'
            ? 'error'
            : snapshots.mode === 'paused'
              ? 'paused'
              : snapshots.running
                ? 'running'
                : snapshots.failed
                  ? 'retrying'
                  : snapshots.pending
                    ? 'waiting'
                    : 'idle',
      processed: snapshots?.completed,
      active: snapshots?.active,
      limit: snapshots?.limit,
      pending: snapshots ? Math.max(0, snapshots.pending - (snapshots.active ?? 0)) : undefined,
      failed: snapshots?.failed,
      lastSuccessAtMs: snapshots?.lastCompletedAtMs,
      detail: snapshots?.mode === 'initializing' ? 'screenshot-storage-opening' : undefined,
      error:
        snapshots?.mode === 'unavailable'
          ? snapshots.error === 'task_status_unavailable'
            ? 'task_status_unavailable'
            : 'screenshot_storage_unavailable'
          : null,
    },
    {
      id: 'deletion',
      group: 'processing',
      state:
        input.deletions === null
          ? 'error'
          : active.some((job) => job.state === 'failed')
            ? 'error'
            : active.some(
                  (job) => job.state === 'running' || (job.state === 'preparing' && !job.error),
                )
              ? 'running'
              : active.some((job) => job.state === 'retry' || job.error)
                ? 'retrying'
                : active.length
                  ? 'waiting'
                  : 'idle',
      pending: active.length,
      processed: active.length ? active.reduce((sum, job) => sum + job.processed, 0) : undefined,
      total: active.length ? active.reduce((sum, job) => sum + job.total, 0) : undefined,
      lastRunAtMs:
        (input.deletions ?? []).reduce((latest, job) => Math.max(latest, job.updatedAtMs), 0) ||
        null,
      error:
        input.deletions === null
          ? 'task_status_unavailable'
          : active.some((job) => job.error)
            ? 'deletion_retry'
            : null,
    },
    {
      id: 'client-sync',
      group: 'sync',
      state: input.client.failed
        ? 'retrying'
        : input.client.running
          ? 'running'
          : input.client.clients
            ? 'waiting'
            : 'idle',
      processed: input.client.clients,
      detail: 'connected-clients',
      lastRunAtMs: input.client.lastRunAtMs,
      lastSuccessAtMs: input.client.lastSuccessAtMs,
      nextRunAtMs: input.client.clients
        ? input.clock.find((job) => job.name === 'ui-sync')?.nextTickAtMs
        : null,
      error: input.client.failed ? 'client_sync_failed' : null,
    },
    schedule('run-heartbeat', 'run-heartbeat', 'protection'),
  ];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of input.tasks) {
    const job = input.clock.find(
      (item) =>
        item.name ===
        (
          { 'avatar-sync': 'subject-avatars', 'run-heartbeat': 'run-heartbeat' } as Record<
            string,
            string
          >
        )[task.id],
    );
    byId.set(task.id, {
      ...task,
      nextRunAtMs:
        task.nextRunAtMs ??
        (task.state === 'waiting' || task.state === 'retrying' ? job?.nextTickAtMs : null),
    });
  }
  return [...byId.values()];
}
