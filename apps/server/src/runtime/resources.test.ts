import { describe, expect, it, vi } from 'vitest';
import { ResourceMonitor } from './resources.js';
import { defaultRuntimeSettings } from './settings.js';
describe('storage budgets and retention ownership', () => {
  it('checks both independent volumes and blocks recording if only the index disk is full', async () => {
    let dataFree = 0;
    const writeProbe = vi.fn(() => Promise.resolve());
    const monitor = new ResourceMonitor({
      root: '/media',
      dataRoot: '/data',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk: (root) =>
        Promise.resolve({
          freeBytes: root === '/data' ? dataFree : 10 ** 12,
          totalBytes: 2 * 10 ** 12,
        }),
      writeProbe,
    });
    try {
      await monitor.checkDisk();
      expect(monitor.canRecord()).toBe(false);
      expect(monitor.get().error).toBe('data_disk_low_space');
      expect(writeProbe).toHaveBeenCalledWith('/media');
      expect(writeProbe).toHaveBeenCalledWith('/data');
      dataFree = 10 ** 12;
      await monitor.checkDisk();
      expect(monitor.canRecord()).toBe(true);
    } finally {
      await monitor.close();
    }
  });
  it('keeps recording disk admission independent of a blocked retention sweep', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pruneBefore = vi.fn(async () => {
      await gate;
      return { deletedSegments: 0, reclaimedBytes: 0 };
    });
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore },
      settings: () => ({ ...defaultRuntimeSettings, retentionDays: 1 }),
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () => Promise.resolve(),
      now: () => 100000,
    });
    const maintenance = monitor.check();
    try {
      await vi.waitFor(() => expect(pruneBefore).toHaveBeenCalledTimes(1));
      await monitor.checkDisk();
      expect(monitor.canRecord()).toBe(true);
    } finally {
      release();
      await maintenance;
      await monitor.close();
    }
  });
  it('pauses recording when storage checks are stale and resumes after a fresh successful check', async () => {
    let now = 100000;
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () => Promise.resolve(),
      now: () => now,
    });
    await monitor.check();
    expect(monitor.canRecord()).toBe(true);
    now += 30001;
    expect(monitor.get().error).toBe('disk_check_stale');
    expect(monitor.canRecord()).toBe(false);
    await monitor.check();
    expect(monitor.canRecord()).toBe(true);
    await monitor.close();
  });
  it('detects a read-only volume despite readable space statistics and recovers on the next write probe', async () => {
    let now = 100000,
      writable = false;
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () =>
        writable
          ? Promise.resolve()
          : Promise.reject(Object.assign(new Error('readonly'), { code: 'EROFS' })),
      now: () => now,
    });
    await monitor.check();
    expect(monitor.get().error).toBe('disk_read_only');
    expect(monitor.canRecord()).toBe(false);
    writable = true;
    now += 30000;
    await monitor.check();
    expect(monitor.get().error).toBeNull();
    expect(monitor.canRecord()).toBe(true);
    await monitor.close();
  });
  it('clears obsolete retention errors when retention is disabled', async () => {
    let retentionDays = 1;
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.reject(new Error('denied')) },
      settings: () => ({ ...defaultRuntimeSettings, retentionDays }),
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () => Promise.resolve(),
      now: () => 100000,
    });
    await monitor.check();
    expect(monitor.maintenanceError()).toBe('retention_cleanup_failed');
    retentionDays = 0;
    await monitor.check();
    expect(monitor.maintenanceError()).toBeNull();
    await monitor.close();
  });
  it('blocks capture on low disk, recovers after cleanup, and prunes only by the configured cutoff', async () => {
    let freeBytes = 10;
    const changed = vi.fn();
    const pruneBefore = vi.fn(() => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }));
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore },
      settings: () => ({ ...defaultRuntimeSettings, minFreeBytes: 100, retentionDays: 1 }),
      readDisk: () => Promise.resolve({ freeBytes, totalBytes: 1000 }),
      changed,
      now: () => 200000000,
    });
    await monitor.check();
    expect(monitor.canRecord()).toBe(false);
    expect(pruneBefore).toHaveBeenCalledWith(200000000 - 86400000);
    freeBytes = 200;
    await monitor.check();
    expect(monitor.canRecord()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(pruneBefore).toHaveBeenCalledTimes(1);
    await monitor.close();
    expect(monitor.canRecord()).toBe(false);
  });
  it('coalesces checks and reports disk errors without allowing capture or overlapping cleanup', async () => {
    let finish: ((value: { freeBytes: number; totalBytes: number }) => void) | undefined;
    const readDisk = vi.fn(
      () =>
        new Promise<{ freeBytes: number; totalBytes: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk,
    });
    const first = monitor.check();
    expect(monitor.check()).toBe(first);
    expect(readDisk).toHaveBeenCalledTimes(1);
    finish!({ freeBytes: -1, totalBytes: 10 });
    await first;
    expect(monitor.get().error).toBe('disk_unavailable');
    expect(monitor.canRecord()).toBe(false);
    await monitor.close();
  });
  it('clears a repaired integrity warning independently of retention failures', async () => {
    let now = 100000,
      broken = true;
    const monitor = new ResourceMonitor({
      root: '.',
      archive: {
        pruneBefore: () => Promise.reject(new Error('unavailable')),
        scrub: () =>
          broken
            ? Promise.reject(new Error('corrupt'))
            : Promise.resolve({ checked: 0, nextCursor: null }),
      },
      settings: () => ({ ...defaultRuntimeSettings, retentionDays: 1 }),
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      now: () => now,
    });
    await monitor.check();
    expect(monitor.maintenanceError()).toBe('archive_integrity_check_failed');
    broken = false;
    now += 60000;
    await monitor.check();
    expect(monitor.maintenanceError()).toBe('retention_cleanup_failed');
    await monitor.close();
  });
});

it('reports domain work and failures without starting maintenance from observation', async () => {
  let now = 100000,
    retentionDays = 1,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pruneBefore = vi.fn(async () => {
    await gate;
    throw Error('private filesystem path');
  });
  const scrub = vi.fn(() => Promise.resolve({ checked: 16, nextCursor: 'opaque-private-cursor' }));
  const monitor = new ResourceMonitor({
    root: '.',
    archive: { pruneBefore, scrub },
    settings: () => ({ ...defaultRuntimeSettings, retentionDays }),
    now: () => now,
    readDisk: () => Promise.resolve({ freeBytes: 1e12, totalBytes: 2e12 }),
    writeProbe: () => Promise.resolve(),
  });
  try {
    expect(monitor.backgroundTasks().find((task) => task.id === 'retention')?.state).toBe('paused');
    expect(pruneBefore).not.toHaveBeenCalled();
    const work = monitor.check();
    await vi.waitFor(() => expect(pruneBefore).toHaveBeenCalledOnce());
    expect(monitor.backgroundTasks().find((task) => task.id === 'retention')?.state).toBe(
      'running',
    );
    release();
    await work;
    const rows = monitor.backgroundTasks();
    expect(rows.find((task) => task.id === 'retention')).toMatchObject({
      state: 'retrying',
      lastSuccessAtMs: null,
      error: 'retention_cleanup_failed',
      nextRunAtMs: 160000,
    });
    expect(rows.find((task) => task.id === 'integrity-scan')).toMatchObject({
      processed: 16,
      lastSuccessAtMs: 100000,
    });
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(JSON.stringify(rows)).not.toContain('opaque');
    retentionDays = 0;
    now++;
    expect(monitor.backgroundTasks().find((task) => task.id === 'retention')?.state).toBe(
      'disabled',
    );
    expect(pruneBefore).toHaveBeenCalledOnce();
  } finally {
    release();
    await monitor.close();
  }
});
