import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

it('persists the global default and inherits only on joining, never on ordinary refresh', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-global-recording-'));
  let archive = await openArchive({ root });
  const item = (id: number) => ({ id: `stripchat:${id}`, providerId: id, handle: `subject${id}` });
  try {
    await archive.upsertSubjects([item(1)], { syncAccount: true });
    await archive.setGlobalRecording(true);
    await archive.upsertSubjects([item(1), item(2)], { syncAccount: true });
    expect((await archive.listSubjects()).every((s) => s.autoRecord)).toBe(true);
    await archive.setPolicy('stripchat:1', { autoRecord: false });
    await archive.upsertSubjects([item(1), item(2)], { syncAccount: true });
    await archive.setObservation('stripchat:1', 'PUBLIC', Date.now());
    expect((await archive.getSubject('stripchat:1'))?.autoRecord).toBe(false);
    expect(await archive.getSetting('recording.default')).toBe('true');
    await archive.upsertSubjects([item(1)], { syncAccount: true });
    expect(await archive.getSubject('stripchat:2')).toMatchObject({
      archived: true,
      autoRecord: false,
    });
    await archive.close();
    archive = await openArchive({
      root: path.join(root, 'restored'),
      mediaRoot: path.join(root, 'media'),
    });
    await archive.upsertSubjects([item(1), item(2), item(3)], { syncAccount: true });
    expect((await archive.getSubject('stripchat:1'))?.autoRecord).toBe(false);
    expect((await archive.getSubject('stripchat:2'))?.autoRecord).toBe(true);
    expect((await archive.getSubject('stripchat:3'))?.autoRecord).toBe(true);
    await archive.setGlobalRecording(false);
    await archive.upsertSubjects([item(1), item(2), item(3), item(4)], { syncAccount: true });
    expect((await archive.listSubjects()).every((s) => !s.autoRecord)).toBe(true);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('allows an empty library to choose the default without enabling archived subjects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-global-empty-'));
  const archive = await openArchive({ root });
  try {
    await archive.setGlobalRecording(true);
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'one' }], {
      syncAccount: true,
    });
    expect((await archive.getSubject('stripchat:1'))?.autoRecord).toBe(true);
    await archive.upsertSubjects([], { syncAccount: true });
    await archive.setGlobalRecording(true);
    expect(await archive.getSubject('stripchat:1')).toMatchObject({
      archived: true,
      autoRecord: false,
      monitorEnabled: false,
    });
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
