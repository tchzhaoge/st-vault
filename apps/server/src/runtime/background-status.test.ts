import { expect, it } from 'vitest';
import type { BackgroundTask, MediaDeletionJob } from '@st-vault/api-schema';
import { backgroundOverview } from './background-status.js';
const input = () => ({
  clock: [],
  account: {
    connected: false,
    running: false,
    needsReconnect: false,
    lastAttemptMs: null,
    lastSuccessMs: null,
    nextAttemptMs: null,
    lastImportedCount: null,
    error: null,
  },
  snapshots: null,
  deletions: [] as MediaDeletionJob[],
  tasks: [] as BackgroundTask[],
  client: { clients: 0, running: false, failed: false, lastRunAtMs: null, lastSuccessAtMs: null },
});
it('carries real screenshot execution capacity in the existing task row', () => {
  const tasks = backgroundOverview({
    ...input(),
    snapshots: {
      running: true,
      active: 3,
      limit: 8,
      pending: 20,
      failed: 0,
      completed: 100,
      mode: 'catching-up',
      averageMs: 100,
    },
  });
  expect(tasks.find((task) => task.id === 'snapshots')).toMatchObject({
    state: 'running',
    active: 3,
    limit: 8,
    pending: 17,
  });
});
it.each([
  ['upstream-challenge:403', 'site_verification_required'],
  ['request-deadline', 'site_request_timeout'],
  ['upstream-request', 'site_network_unavailable'],
  ['upstream-http:429', 'site_rate_limited'],
  ['invalid-upstream-json', 'site_response_invalid'],
])('preserves the actionable site observation %s as %s', (error, expected) => {
  const tasks = backgroundOverview({
    ...input(),
    account: { ...input().account, connected: true, origin: 'https://one.invalid' },
    sites: {
      selectedOrigin: 'https://one.invalid',
      candidates: [],
      access: { origin: 'https://one.invalid', checkedAtMs: 1, lastSuccessAtMs: null, error },
    },
  });
  expect(tasks.find((task) => task.id === 'site-access')).toMatchObject({
    state: 'error',
    error: expected,
  });
});
it('keeps domain failures and disabled policies authoritative over normal scheduling', () => {
  const value = input();
  value.tasks = [
    { id: 'retention', group: 'protection', state: 'disabled', detail: 'keep-forever' },
    {
      id: 'integrity-scan',
      group: 'protection',
      state: 'error',
      error: 'archive_integrity_check_failed',
    },
  ];
  const tasks = backgroundOverview(value);
  expect(tasks.find((task) => task.id === 'retention')?.state).toBe('disabled');
  expect(tasks.find((task) => task.id === 'integrity-scan')?.state).toBe('error');
  expect(tasks.find((task) => task.id === 'account-list')?.state).toBe('disabled');
});
it('reports exact probe progress, manual retry semantics, and indeterminate screenshot discovery', () => {
  const tasks = backgroundOverview({
    ...input(),
    snapshots: {
      pending: 10,
      failed: 2,
      completed: 8000,
      mode: 'catching-up',
      averageMs: 20,
      running: true,
    },
    sites: {
      selectedOrigin: 'https://site.invalid',
      probing: false,
      candidates: [
        {
          origin: 'https://site.invalid',
          latencyMs: null,
          failures: 1,
          checkedAtMs: 100,
          error: 'timeout',
        },
      ],
    },
  });
  expect(tasks.find((task) => task.id === 'site-probe')).toMatchObject({
    state: 'idle',
    detail: 'manual-site-probe',
  });
  expect(tasks.find((task) => task.id === 'site-probe')).not.toHaveProperty('target');
  expect(tasks.find((task) => task.id === 'snapshots')).toMatchObject({
    state: 'running',
    processed: 8000,
    pending: 10,
    failed: 2,
  });
  expect(tasks.find((task) => task.id === 'snapshots')).not.toHaveProperty('total');
});
it('aggregates deletion checkpoints without disclosing subjects or inventing retry times', () => {
  const jobs = [
    {
      id: 'private-id',
      subjectId: 'stripchat:123',
      state: 'retry',
      total: 9000,
      processed: 300,
      error: 'storage_unavailable',
      updatedAtMs: 600,
    } as MediaDeletionJob,
  ];
  const task = backgroundOverview({ ...input(), deletions: jobs }).find(
    (task) => task.id === 'deletion',
  );
  expect(task).toMatchObject({
    state: 'retrying',
    total: 9000,
    processed: 300,
    pending: 1,
    error: 'deletion_retry',
  });
  expect(task).not.toHaveProperty('nextRunAtMs');
  expect(JSON.stringify(task)).not.toContain('stripchat:123');
});
it('does not let ephemeral clock subscribers leak into the task catalog or imply business success', () => {
  const tasks = backgroundOverview({
    ...input(),
    clock: [
      {
        name: 'capture-status',
        running: false,
        lastStartedAtMs: 100,
        lastFinishedAtMs: 120,
        failed: false,
        nextTickAtMs: 1000,
      },
      {
        name: 'unit-tail:secret-id',
        running: true,
        lastStartedAtMs: 100,
        lastFinishedAtMs: null,
        failed: false,
        nextTickAtMs: 1000,
      },
    ],
  });
  const task = tasks.find((item) => item.id === 'capture-status');
  expect(task).toMatchObject({ state: 'waiting', lastRunAtMs: 100, detail: 'schedule-only' });
  expect(task?.lastSuccessAtMs).toBeUndefined();
  expect(JSON.stringify(tasks)).not.toContain('secret-id');
});
it('reports observer uncertainty while retaining independent healthy data', () => {
  const tasks = backgroundOverview({
    ...input(),
    deletions: null,
    tasks: [
      {
        id: 'archive-index',
        group: 'processing',
        state: 'error',
        error: 'task_status_unavailable',
      },
    ],
  });
  expect(tasks.find((task) => task.id === 'deletion')).toMatchObject({
    state: 'error',
    error: 'task_status_unavailable',
  });
  expect(tasks.find((task) => task.id === 'account-list')?.state).toBe('disabled');
});

it('keeps screenshot initialization waiting rather than declaring storage damage', () => {
  const task = backgroundOverview({
    ...input(),
    snapshots: { mode: 'initializing', pending: 0, failed: 0, completed: 0, averageMs: 0 },
  }).find((item) => item.id === 'snapshots');
  expect(task).toMatchObject({
    state: 'waiting',
    detail: 'screenshot-storage-opening',
    error: null,
  });
});

it('reports the committed account binding, ignores old probe faults and preserves actionable cookie errors', () => {
  const tasks = backgroundOverview({
    ...input(),
    account: {
      ...input().account,
      connected: true,
      origin: 'https://new.invalid',
      needsReconnect: true,
      error: 'cookies_domain_mismatch',
    },
    sites: {
      selectedOrigin: 'https://old.invalid',
      candidates: [],
      access: {
        origin: 'https://old.invalid',
        checkedAtMs: 100,
        lastSuccessAtMs: null,
        error: 'timeout',
      },
    },
  });
  expect(tasks.find((task) => task.id === 'site-access')).toMatchObject({
    state: 'waiting',
    target: 'new.invalid',
  });
  expect(tasks.some((task) => task.id === 'site-probe')).toBe(false);
  expect(tasks.find((task) => task.id === 'account-list')).toMatchObject({
    state: 'error',
    error: 'cookies_domain_mismatch',
    nextRunAtMs: null,
  });
});

it('distinguishes a missing scheduler from a failed heartbeat', () => {
  const tasks = backgroundOverview({
    ...input(),
    clock: [
      {
        name: 'run-heartbeat',
        running: false,
        failed: true,
        lastFinishedAtMs: 1,
        lastStartedAtMs: 100,
        nextTickAtMs: 200,
      },
    ],
  });
  expect(tasks.find((task) => task.id === 'capture-status')).toMatchObject({ state: 'disabled' });
  expect(tasks.find((task) => task.id === 'run-heartbeat')).toMatchObject({
    state: 'retrying',
    error: 'run_heartbeat_failed',
    nextRunAtMs: 200,
  });
});
