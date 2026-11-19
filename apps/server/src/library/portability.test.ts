import { cp, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from '../archive/index.js';
import { LibraryImages } from './images.js';

it('moves the complete library to a new NAS without transferring PIN or account cookies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-portable-'));
  const mediaRoot = path.join(root, 'hdd'),
    data = path.join(root, 'ssd');
  let archive = await openArchive({ root: data, mediaRoot });
  const subject = { id: 'stripchat:42', providerId: 42, handle: 'first' };
  try {
    await archive.upsertSubjects([subject], { syncAccount: true });
    await archive.upsertSubjects([{ ...subject, handle: 'renamed' }], { syncAccount: true });
    await archive.setSetting('local-auth.pin', 'private-pin-fixture');
    await archive.setSetting('private.sealed.account', 'private-account-fixture');
    await archive.setSetting('preview.avatar-version.stripchat:42', 'version-fixture');
    const segment = await archive.commit({
      subjectId: subject.id,
      sourceEpoch: 'epoch',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1, 2, 3]),
      durationSeconds: 2,
      wallStartMs: 1000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const page = await archive.snapshotPages!(subject.id, 1000, 1, 30, { fromMs: 0, toMs: 10000 });
    await archive.unitFavorites!(
      subject.id,
      [page.items[0].unitId],
      true,
      await archive.personalRevision(),
    );
    const images = new LibraryImages(mediaRoot, 'cover');
    await archive.markUnitsSeen!(subject.id, [
      { unitId: page.items[0].unitId, toMs: page.items[0].slotToMs },
    ]);
    expect(await images.put('cover:42', new Uint8Array([10, 20, 30]))).toBe(true);
    await images.close();
    await archive.close();
    const moved = path.join(root, 'other-nas', 'library');
    await cp(mediaRoot, moved, { recursive: true });
    archive = await openArchive({ root: path.join(root, 'new-private'), mediaRoot: moved });
    expect(await archive.getSubject(subject.id)).toMatchObject({
      handle: 'renamed',
      formerNames: ['first'],
    });
    expect((await archive.personal(subject.id, 0, 10000)).favorites).toHaveLength(1);
    expect((await archive.coverage(subject.id, 0, 10000, 100)).seenSpans).toEqual([
      { fromMs: 1000, toMs: 3000 },
    ]);
    expect(await archive.getSetting('local-auth.pin')).toBeNull();
    expect(await archive.getSetting('private.sealed.account')).toBeNull();
    expect(await archive.getSetting('preview.avatar-version.stripchat:42')).toBe('version-fixture');
    expect(await readFile((await archive.media(segment.id))!.path)).toEqual(Buffer.from([1, 2, 3]));
    const restored = new LibraryImages(moved, 'cover');
    expect(await restored.get('cover:42')).toEqual(Buffer.from([10, 20, 30]));
    await restored.close();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a second writer even when it uses a different hot-index directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-lock-'));
  const mediaRoot = path.join(root, 'media'),
    archive = await openArchive({ root: path.join(root, 'first'), mediaRoot });
  try {
    await expect(openArchive({ root: path.join(root, 'second'), mediaRoot })).rejects.toThrow(
      'ARCHIVE_LOCKED_OR_DATABASE_UNAVAILABLE',
    );
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('refuses to initialize beside legacy data instead of presenting an empty new library', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-legacy-guard-'));
  try {
    await writeFile(path.join(root, 'metadata.sqlite'), 'legacy');
    await expect(openArchive({ root, mediaRoot: path.join(root, 'other-media') })).rejects.toThrow(
      'LIBRARY_MIGRATION_REQUIRED',
    );
    await expect(stat(path.join(root, 'other-media'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'metadata.sqlite'), 'utf8')).toBe('legacy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
