import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openArchive } from './index.js';

it('bounds native hashing while preserving media bytes shared by independent consumers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-hash-owner-'));
  const original = webcrypto.subtle.digest.bind(webcrypto.subtle);
  let active = 0,
    maximum = 0;
  const digest = vi
    .spyOn(webcrypto.subtle, 'digest')
    .mockImplementation(async (algorithm, data) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await original(algorithm, data);
      } finally {
        active--;
      }
    });
  const archive = await openArchive({ root, hashConcurrency: 2 });
  try {
    const shared = new Uint8Array(new SharedArrayBuffer(1024 * 1024));
    shared.fill(7);
    const expected = createHash('sha256').update(shared).digest('hex');
    const subjects = Array.from({ length: 4 }, (_, index) => ({
      id: 'stripchat:' + (index + 42),
      providerId: index + 42,
      handle: 'fixture' + index,
    }));
    await archive.upsertSubjects(subjects);
    const segments = await Promise.all(
      subjects.map((subject) =>
        archive.commit({
          subjectId: subject.id,
          sourceEpoch: 'one',
          sourceSequence: '1',
          init: null,
          bytes: shared,
          durationSeconds: 2,
          wallStartMs: 60000,
          timeBasis: 'source-pdt',
          uncertaintyMs: 0,
          discontinuity: false,
        }),
      ),
    );
    expect(digest).toHaveBeenCalledTimes(4);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(shared.byteLength).toBe(1024 * 1024);
    expect(createHash('sha256').update(shared).digest('hex')).toBe(expected);
    for (const segment of segments) {
      const media = await archive.media(segment.id);
      expect(media).not.toBeNull();
      expect(
        createHash('sha256')
          .update(await readFile(media!.path))
          .digest('hex'),
      ).toBe(expected);
    }
  } finally {
    digest.mockRestore();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
