/** Isolated mixed archive benchmark; latency is controlled IO, not NAS throughput. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openArchive } from './index.js';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
const root = await mkdtemp(path.join(tmpdir(), 'stv-archive-bench-'));
let armed = false;
const archive = await openArchive({
  root,
  backgroundConcurrency: 4,
  gcConcurrency: 8,
  hashConcurrency: 2,
  fault: async (point) => {
    if (armed && point === 'before-unlink') await delay(15);
  },
});
const subjects = Array.from({ length: 4 }, (_, index) => ({
  id: 'stripchat:' + (40 + index),
  providerId: 40 + index,
  handle: 'fixture' + index,
}));
const commit = (id: string, sequence: number, start: number) =>
  archive.commit({
    subjectId: id,
    sourceEpoch: 'bench',
    sourceSequence: String(sequence),
    init: null,
    bytes: new Uint8Array(4096),
    durationSeconds: 2,
    wallStartMs: start,
    timeBasis: 'source-pdt',
    uncertaintyMs: 0,
    discontinuity: false,
  });
try {
  await archive.upsertSubjects(subjects);
  for (let sequence = 0; sequence < 16; sequence++)
    await Promise.all(subjects.map((s) => commit(s.id, sequence, 60000 + sequence * 2000)));
  const plans = await Promise.all(
    subjects.map((s) => archive.planDeletion!(s.id, [{ fromMs: 60000, toMs: 92000 }])),
  );
  const reads: number[] = [],
    writes: number[] = [],
    admissions: number[] = [];
  armed = true;
  const started = performance.now();
  const deleting = (async () => {
    for (let index = 0; index < subjects.length; index++) {
      const start = performance.now();
      await archive.deleteSelection!(
        subjects[index].id,
        plans[index].id,
        plans[index].personalRevision,
      );
      admissions.push(performance.now() - start);
    }
    await archive.resumeDeletions!();
  })();
  const recording = Promise.all(
    subjects.map(async (s) => {
      for (let sequence = 16; sequence < 24; sequence++) {
        const start = performance.now();
        await commit(s.id, sequence, 120000 + sequence * 2000);
        writes.push(performance.now() - start);
      }
    }),
  );
  const reading = (async () => {
    for (let index = 0; index < 48; index++) {
      const start = performance.now();
      await archive.locate(subjects[index % subjects.length].id, 150000, 'next');
      reads.push(performance.now() - start);
      await delay(2);
    }
  })();
  await Promise.all([deleting, recording, reading]);
  console.log(
    JSON.stringify({
      event: 'parallel_archive_benchmark',
      synthetic: true,
      scope:
        '4 subjects, 64 retired files, 15ms controlled unlink delay, 32 concurrent incoming commits, 48 playback locates; includes real PG+journal+fsync, excludes network',
      totalMs: performance.now() - started,
      admissionP95Ms: p95(admissions),
      recordingP95Ms: p95(writes),
      playbackP95Ms: p95(reads),
      recordingCount: writes.length,
      playbackCount: reads.length,
      completed: (await archive.deletionJobs!()).filter((j) => j.state === 'completed').length,
    }),
  );
} finally {
  await archive.close();
  await rm(root, { recursive: true, force: true });
}
