// Isolated synthetic metadata benchmark; never opens the deployment's data directory.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openArchive } from '../../build/apps/server/src/archive/index.js';

const root = await mkdtemp(path.join(tmpdir(), 'stv-lookup-benchmark-'));
const archive = await openArchive({ root });
try {
  const count = 1000,
    rounds = 30;
  await archive.upsertSubjects(
    Array.from({ length: count }, (_, index) => ({
      id: `stripchat:${index + 1}`,
      providerId: index + 1,
      handle: `synthetic-${index + 1}`,
    })),
  );
  const measure = async (action) => {
    await action();
    const start = performance.now();
    let payloadBytes = 0;
    for (let index = 0; index < rounds; index++) {
      const result = await action();
      payloadBytes += Buffer.byteLength(JSON.stringify(result));
    }
    return {
      meanMs: Math.round(((performance.now() - start) / rounds) * 1000) / 1000,
      meanPayloadBytes: payloadBytes / rounds,
    };
  };
  const list = await measure(() => archive.listSubjects());
  const single = await measure(() => archive.getSubject('stripchat:42'));
  assert.equal((await archive.getSubject('stripchat:42')).providerId, 42);
  console.log(JSON.stringify({ synthetic: true, subjects: count, rounds, list, single }));
} finally {
  await archive.close();
  await rm(root, { recursive: true, force: true });
}
