import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

it('stages a public list without changing membership and activates it idempotently after reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-stage-'));
  let archive = await openArchive({ root });
  const old = { id: 'stripchat:1', providerId: 1, handle: 'old' },
    next = { id: 'stripchat:2', providerId: 2, handle: 'next' };
  const generation = randomUUID();
  try {
    await archive.upsertSubjects([old], { syncAccount: true });
    const extra = { ...next, cookiesText: 'sensitive-extra-field-must-not-enter-media' };
    await archive.prepareAccountSubjects([extra], generation);
    for (const file of await readdir(path.join(root, 'media', 'postgres-journal')))
      expect(
        (await readFile(path.join(root, 'media', 'postgres-journal', file))).includes(
          Buffer.from(extra.cookiesText),
        ),
      ).toBe(false);
    expect(await archive.getSubject(old.id)).toMatchObject({ archived: false });
    expect(await archive.getSubject(next.id)).toBeNull();
    await archive.close();
    archive = await openArchive({
      root: path.join(root, 'restored'),
      mediaRoot: path.join(root, 'media'),
    });
    await archive.activateAccountSubjects(generation);
    expect(await archive.accountActivation()).toBe(generation);
    expect(await archive.getSubject(old.id)).toMatchObject({ archived: true });
    expect(await archive.getSubject(next.id)).toMatchObject({ archived: false });
    await archive.activateAccountSubjects(generation);
    expect(await archive.accountActivation()).toBe(generation);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('discards an unaccepted preparation without changing the active list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-discard-'));
  const archive = await openArchive({ root }),
    generation = randomUUID();
  try {
    await archive.prepareAccountSubjects(
      [{ id: 'stripchat:2', providerId: 2, handle: 'unused' }],
      generation,
    );
    await archive.discardAccountPreparation(generation);
    await expect(archive.activateAccountSubjects(generation)).rejects.toThrow(
      'ACCOUNT_ACTIVATION_MISSING',
    );
    expect(await archive.listSubjects()).toEqual([]);
    expect(await archive.accountActivation()).toBeNull();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('activates and refreshes avatar sources through the real metadata worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-avatar-'));
  let archive = await openArchive({ root });
  const subject = { id: 'stripchat:7', providerId: 7, handle: 'with-avatar' };
  const key = `preview.avatar-source.${subject.id}`;
  try {
    for (const source of [
      'https://images.invalid/avatar-v1.jpg',
      'https://images.invalid/avatar-v2.jpg',
      'https://images.invalid/avatar-v2.jpg',
    ]) {
      const generation = randomUUID();
      await archive.prepareAccountSubjects([{ ...subject, avatarSourceUrl: source }], generation);
      await archive.activateAccountSubjects(generation);
      expect(await archive.accountActivation()).toBe(generation);
      expect(await archive.getSetting(key)).toBe(source);
      expect(await archive.getSubject(subject.id)).toMatchObject({ archived: false });
    }
    await archive.close();
    archive = await openArchive({ root });
    expect(await archive.getSetting(key)).toBe('https://images.invalid/avatar-v2.jpg');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
