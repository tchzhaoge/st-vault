import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

it('archives all absent subjects, disables recording, and restores membership durably', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-membership-'));
  let archive = await openArchive({ root });
  const item = (id: number) => ({ id: `stripchat:${id}`, providerId: id, handle: `subject${id}` });
  try {
    await archive.upsertSubjects([item(3)]);
    await archive.upsertSubjects([item(1), item(2)], { syncAccount: true });
    await archive.setPolicy('stripchat:1', { autoRecord: true });
    await archive.setPolicy('stripchat:2', { monitorEnabled: false });
    await archive.upsertSubjects([item(2)], { syncAccount: true });
    let rows = await archive.listSubjects();
    expect(rows.find((s) => s.id === 'stripchat:1')).toMatchObject({
      archived: true,
      autoRecord: false,
      monitorEnabled: false,
    });
    expect(rows.find((s) => s.id === 'stripchat:2')).toMatchObject({
      archived: false,
      monitorEnabled: false,
    });
    expect(rows.find((s) => s.id === 'stripchat:3')?.archived).toBe(true);
    await expect(archive.setPolicy('stripchat:1', { autoRecord: true })).rejects.toThrow(
      'SUBJECT_ARCHIVED',
    );
    await expect(
      archive.setPolicies(['stripchat:2', 'stripchat:1'], { autoRecord: true }),
    ).rejects.toThrow('SUBJECT_ARCHIVED');
    expect(await archive.getSubject('stripchat:2')).toMatchObject({ autoRecord: false });
    await archive.close();
    archive = await openArchive({ root });
    expect((await archive.listSubjects()).find((s) => s.id === 'stripchat:1')?.archived).toBe(true);
    await archive.upsertSubjects([item(1), item(2)], { syncAccount: true });
    rows = await archive.listSubjects();
    expect(rows.find((s) => s.id === 'stripchat:1')).toMatchObject({
      archived: false,
      autoRecord: false,
      monitorEnabled: true,
    });
    await archive.upsertSubjects([], { syncAccount: true });
    expect((await archive.listSubjects()).filter((s) => s.archived).map((s) => s.id)).toEqual([
      'stripchat:1',
      'stripchat:2',
      'stripchat:3',
    ]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
