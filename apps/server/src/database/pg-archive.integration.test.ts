import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startTestPostgres } from './postgres.test-support.js';
import { openArchive } from '../archive/index.js';
let server: Awaited<ReturnType<typeof startTestPostgres>>;
beforeAll(async () => {
  server = await startTestPostgres();
}, 30000);
afterAll(async () => {
  await server.close();
});
it('opens the PostgreSQL archive and preserves recording identity across restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-pg-archive-'));
  let archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    await archive.commit({
      subjectId: 'stripchat:42',
      sourceEpoch: 'epoch',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1, 2]),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    expect((await archive.timeline('stripchat:42', 0, 120000)).segments).toHaveLength(1);
    await archive.close();
    archive = await openArchive({ root });
    expect((await archive.timeline('stripchat:42', 0, 120000)).segments).toHaveLength(1);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
