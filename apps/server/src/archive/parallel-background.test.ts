import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { openArchive } from './index.js';

it('starts a newly admitted subject while another deletion is blocked, without duplicate execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-parallel-delete-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let armed = false,
    unlinks = 0;
  const archive = await openArchive({
    root,
    backgroundConcurrency: 2,
    gcConcurrency: 2,
    fault: async (point) => {
      if (point === 'before-unlink') {
        unlinks++;
        if (armed) {
          armed = false;
          entered();
          await gate;
        }
      }
    },
  });
  try {
    for (const number of [42, 43]) {
      const id = 'stripchat:' + number;
      await archive.upsertSubjects([{ id, providerId: number, handle: 'fixture' + number }]);
      await archive.commit({
        subjectId: id,
        sourceEpoch: 'one',
        sourceSequence: '1',
        init: null,
        bytes: new Uint8Array([1, 2]),
        durationSeconds: 2,
        wallStartMs: 60000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    }
    const first = await archive.planDeletion!('stripchat:42', [{ fromMs: 60000, toMs: 62000 }]);
    armed = true;
    await archive.deleteSelection!('stripchat:42', first.id, first.personalRevision);
    await blocked;
    const next = await archive.planDeletion!('stripchat:43', [{ fromMs: 60000, toMs: 62000 }]);
    const second = await archive.deleteSelection!('stripchat:43', next.id, next.personalRevision);
    await vi.waitFor(async () =>
      expect((await archive.deletionJobs!()).find((job) => job.id === second.id)?.state).toBe(
        'completed',
      ),
    );
    expect((await archive.deletionJobs!()).find((job) => job.id === first.id)?.processed).toBe(0);
    release();
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!()).filter((job) => job.state === 'completed')).toHaveLength(
      2,
    );
    expect(unlinks).toBe(2);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
