import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openArchive } from './index.js';

it('looks up canonical IDs without a whole-directory read and returns null for absent IDs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-subject-lookup-'));
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Before' }], {
      syncAccount: true,
    });
    const list = vi.spyOn(archive, 'listSubjects');
    expect(await archive.getSubject('stripchat:42')).toMatchObject({
      handle: 'Before',
      providerId: 42,
    });
    // Former names come from an authoritative website sync, not local placeholders.
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'After' }], {
      syncAccount: true,
    });
    expect(await archive.getSubject('stripchat:42')).toMatchObject({
      handle: 'After',
      formerNames: ['Before'],
    });
    expect(await archive.getSubject('stripchat:99')).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(() => archive.getSubject('../42')).toThrow('INVALID_SUBJECT_ID');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
