import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
it('resolves one complete recording unit without listing an entire broadcast', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-snapshot-unit-')),
    archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'synthetic' }]);
    await archive.setObservation('stripchat:1', 'OFFLINE', 1000, 1000);
    await archive.setObservation('stripchat:1', 'PUBLIC', 2000, 600000);
    for (const at of [3000, 65000])
      await archive.commit({
        subjectId: 'stripchat:1',
        sourceEpoch: 'e',
        sourceSequence: String(at),
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 2,
        wallStartMs: at,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    expect(await archive.snapshotUnit!('stripchat:1', 65000)).toMatchObject({
      atMs: 65000,
      slotFromMs: 65000,
      slotToMs: 67000,
    });
    expect(await archive.snapshotUnit!('stripchat:1', 130000)).toBeNull();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
