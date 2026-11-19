import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

it('stores and reopens media only in the current UTC date/hour layout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-layout-'));
  let archive = await openArchive({ root });
  const subject = { id: 'stripchat:42', providerId: 42, handle: 'DoesNotBelongInPath' };
  const at = Date.parse('2026-11-06T23:59:59Z');
  try {
    await archive.upsertSubjects([subject]);
    const segment = await archive.commit({
      subjectId: subject.id,
      sourceEpoch: 'test',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1, 2, 3]),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    expect((await archive.media(segment.id))?.path).toContain(
      path.join('stripchat-42', 'recordings', '2026-11-06', '23'),
    );
    await archive.close();
    archive = await openArchive({ root });
    expect((await archive.timeline(subject.id, at, at + 5000)).segments[0].id).toBe(segment.id);
    expect(await archive.media(segment.id)).not.toBeNull();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
