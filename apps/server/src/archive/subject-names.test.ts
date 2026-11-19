import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
it('automatically retains observed former names by ID across renames, re-follows and restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-names-'));
  let archive = await openArchive({ root });
  const item = (handle: string) => ({ id: 'stripchat:42', providerId: 42, handle });
  const read = async () => (await archive.listSubjects()).find((row) => row.id === 'stripchat:42')!;
  try {
    await archive.upsertSubjects([item('Before')], { syncAccount: true });
    expect((await read()).formerNames).toEqual([]);
    await archive.setPolicy('stripchat:42', { autoRecord: true });
    await archive.upsertSubjects([item('Before')], { syncAccount: true });
    expect((await read()).formerNames).toEqual([]);
    await archive.upsertSubjects(
      [item('After'), { id: 'stripchat:43', providerId: 43, handle: 'After' }],
      { syncAccount: true },
    );
    expect(await read()).toMatchObject({
      handle: 'After',
      formerNames: ['Before'],
      autoRecord: true,
      archived: false,
    });
    expect(
      (await archive.listSubjects()).find((row) => row.id === 'stripchat:43')?.formerNames,
    ).toEqual([]);
    await archive.upsertSubjects([item('After')], { syncAccount: true });
    expect((await read()).formerNames).toEqual(['Before']);
    await archive.upsertSubjects([], { syncAccount: true });
    await archive.close();
    archive = await openArchive({ root });
    expect(await read()).toMatchObject({ formerNames: ['Before'], archived: true });
    await archive.upsertSubjects([item('Again')], { syncAccount: true });
    expect((await read()).formerNames).toEqual(expect.arrayContaining(['Before', 'After']));
    await archive.upsertSubjects([item('Before')], { syncAccount: true });
    const restored = await read();
    expect(restored).toMatchObject({ handle: 'Before', autoRecord: false, archived: false });
    expect(restored.formerNames).toEqual(expect.arrayContaining(['After', 'Again']));
    expect(restored.formerNames).not.toContain('Before');
    await archive.close();
    archive = await openArchive({ root });
    expect(await read()).toEqual({ ...restored, providerStatus: 'UNKNOWN' });
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not treat a manually added placeholder as an observed former website name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-name-origin-'));
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'Local label' }]);
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'WebsiteName' }], {
      syncAccount: true,
    });
    expect((await archive.listSubjects())[0].formerNames).toEqual([]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
