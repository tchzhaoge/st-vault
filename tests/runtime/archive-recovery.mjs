// Run only in a disposable Docker container with --restart on-failure:2.
// Its writable layer retains this synthetic fixture across the tested restart.
import assert from 'node:assert/strict';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { openArchive } from '../../build/apps/server/src/archive/index.js';
import { ArchiveHealthMonitor } from '../../build/apps/server/src/runtime/archive-health.js';
import { SyncClock } from '../../build/apps/server/src/runtime/sync-clock.js';
import { createShutdown } from '../../build/apps/server/src/runtime/lifecycle.js';

if (process.env.STV_QA_RECOVERY !== '1') throw Error('DISPOSABLE_CONTAINER_REQUIRED');
const root = '/tmp/st-vault-health-recovery';
await mkdir(root, { recursive: true });
const marker = `${root}/restart-requested`;
const archive = await openArchive({ root: `${root}/archive` });
const recovered = await access(marker).then(
  () => true,
  () => false,
);
if (recovered) {
  assert.equal((await archive.locate('stripchat:1', 1000, 'report'))?.wallStartMs, 1000);
  assert.equal(archive.recoveryStats().cleanStartup, false);
  await archive.close();
  console.log('[qa] Worker failure detected, Docker restarted, durable footage recovered');
} else {
  await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'synthetic' }]);
  await archive.commit({
    subjectId: 'stripchat:1',
    sourceEpoch: 'fixture',
    sourceSequence: '1',
    init: null,
    bytes: new Uint8Array([1]),
    wallStartMs: 1000,
    durationSeconds: 2,
    timeBasis: 'source-pdt',
    uncertaintyMs: 0,
    discontinuity: false,
  });
  const clock = new SyncClock({ intervalMs: () => 1000 });
  const keepAlive = setInterval(() => undefined, 1000);
  let health;
  const stop = createShutdown({
    closeProducers: async () => {
      clearInterval(keepAlive);
      health.close();
      await clock.close();
    },
    closeArchive: () => archive.close(),
    deadlineMs: 2000,
  });
  health = new ArchiveHealthMonitor({
    probe: () => archive.getSetting('health.probe'),
    intervalMs: () => 1000,
    canRestart: () => true,
    restart: (reason) => {
      void (async () => {
        await writeFile(marker, reason, { flag: 'wx' });
        process.exitCode = 1;
        await stop().catch((error) => {
          assert.equal(error.message, 'METADATA_WORKER_UNAVAILABLE');
          console.log(
            '[qa] Failed worker cannot close cleanly; next boot will reconcile the archive',
          );
        });
      })().catch((error) => {
        console.error(error);
        process.exit(2);
      });
    },
  });
  health.start(clock);
  // Intentional test-only access: no worker-kill endpoint exists in the product.
  setTimeout(() => void archive.db.worker.terminate(), 12000);
}
