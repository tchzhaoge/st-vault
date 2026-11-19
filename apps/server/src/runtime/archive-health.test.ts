import { expect, it, vi } from 'vitest';
import { ArchiveHealthMonitor } from './archive-health.js';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
it('requires three confirmations of the same failure category before restarting', async () => {
  let now = 1000;
  const errors = [
    'SQLITE_BUSY',
    'SQLITE_BUSY',
    'METADATA_WORKER_UNAVAILABLE',
    'METADATA_WORKER_UNAVAILABLE',
    'METADATA_WORKER_UNAVAILABLE',
  ];
  const restart = vi.fn();
  const monitor = new ArchiveHealthMonitor({
    probe: () => Promise.reject(new Error(errors.shift())),
    intervalMs: () => 1000,
    now: () => now,
    canRestart: () => true,
    restart,
  });
  for (let i = 0; i < 3; i++) {
    monitor.check();
    await flush();
    now += 1000;
  }
  expect(restart).not.toHaveBeenCalled();
  for (let i = 0; i < 2; i++) {
    monitor.check();
    await flush();
    now += 1000;
  }
  expect(restart).toHaveBeenCalledTimes(1);
  monitor.close();
});
it('clears a timeout if the in-flight probe recovers before restart confirmation', async () => {
  let now = 1000,
    resolve!: () => void;
  const restart = vi.fn();
  const monitor = new ArchiveHealthMonitor({
    probe: () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
    intervalMs: () => 1000,
    timeoutMs: 2000,
    now: () => now,
    canRestart: () => true,
    restart,
  });
  monitor.check();
  await flush();
  now = 3000;
  monitor.check();
  expect(monitor.get().error).toBe('archive_timeout');
  resolve();
  await flush();
  expect(monitor.get()).toMatchObject({ error: null, failures: 0, recovery: 'none' });
  expect(restart).not.toHaveBeenCalled();
  monitor.close();
});
it('retries transient failures and clears the warning on success without restarting', async () => {
  let now = 1000;
  const probe = vi.fn().mockRejectedValueOnce(new Error('SQLITE_BUSY')).mockResolvedValue(null);
  const restart = vi.fn();
  const monitor = new ArchiveHealthMonitor({
    probe,
    intervalMs: () => 1000,
    now: () => now,
    canRestart: () => true,
    restart,
  });
  monitor.check();
  await flush();
  expect(monitor.get().error).toBe('archive_unavailable');
  now += 1000;
  monitor.check();
  await flush();
  expect(monitor.get()).toMatchObject({ error: null, failures: 0, recovery: 'none' });
  expect(restart).not.toHaveBeenCalled();
  monitor.close();
});
it('keeps one unresolved probe, confirms the timeout and requests one restart', async () => {
  let now = 1000;
  const probe = vi.fn(() => new Promise(() => undefined)),
    restart = vi.fn();
  const monitor = new ArchiveHealthMonitor({
    probe,
    intervalMs: () => 1000,
    timeoutMs: 2000,
    now: () => now,
    canRestart: () => true,
    restart,
  });
  monitor.check();
  await flush();
  now = 3000;
  monitor.check();
  expect(monitor.get().error).toBe('archive_timeout');
  expect(restart).not.toHaveBeenCalled();
  now = 4000;
  monitor.check();
  now = 5000;
  monitor.check();
  expect(restart).toHaveBeenCalledTimes(1);
  expect(monitor.get().recovery).toBe('restart-requested');
  now = 10000;
  monitor.check();
  expect(probe).toHaveBeenCalledTimes(1);
  expect(restart).toHaveBeenCalledTimes(1);
  monitor.close();
});
it('does not restart into an unwritable disk and resumes recovery after the disk is available', async () => {
  let now = 1000,
    writable = false;
  const restart = vi.fn();
  const monitor = new ArchiveHealthMonitor({
    probe: () => Promise.reject(new Error('ARCHIVE_REQUIRES_RECOVERY')),
    intervalMs: () => 1000,
    now: () => now,
    canRestart: () => writable,
    restart,
  });
  for (let i = 0; i < 4; i++) {
    monitor.check();
    await flush();
    now += 1000;
  }
  expect(restart).not.toHaveBeenCalled();
  writable = true;
  monitor.check();
  await flush();
  expect(restart).toHaveBeenCalledWith('archive_recovery_required');
  monitor.close();
});
it('ignores late probe completion after shutdown', async () => {
  let resolve!: () => void;
  const monitor = new ArchiveHealthMonitor({
    probe: () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
    intervalMs: () => 1000,
    canRestart: () => true,
    restart: vi.fn(),
  });
  monitor.check();
  await flush();
  monitor.close();
  const before = monitor.get();
  resolve();
  await flush();
  expect(monitor.get()).toEqual(before);
});
