import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { openArchive } from './index.js';
it('keeps recording the same subject while retired immutable files wait for physical GC', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-gc-recording-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let armed = false;
  const archive = await openArchive({
    root,
    fault: async (point) => {
      if (armed && point === 'before-unlink') {
        armed = false;
        entered();
        await gate;
      }
    },
  });
  let incoming: Promise<unknown> | undefined;
  try {
    const subject = { id: 'stripchat:42', providerId: 42, handle: 'fixture' };
    await archive.upsertSubjects([subject]);
    const commit = (sequence: string, start: number) =>
      archive.commit({
        subjectId: subject.id,
        sourceEpoch: 'one',
        sourceSequence: sequence,
        init: new Uint8Array([0, 1]),
        bytes: new Uint8Array([1, 2]),
        durationSeconds: 2,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const old = await commit('1', 60000);
    const plan = await archive.planDeletion!(subject.id, [{ fromMs: 60000, toMs: 62000 }]);
    armed = true;
    await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision);
    await deleting;
    let next: Awaited<ReturnType<typeof commit>> | undefined;
    incoming = commit('2', 90000).then((value) => {
      next = value;
    });
    await vi.waitFor(() => expect(next).toBeDefined());
    expect(next!.initObjectId).not.toBe(old.initObjectId);
    expect(await archive.hasMedia([next!.id])).toBe(true);
    release();
    await archive.resumeDeletions!();
    expect(await archive.hasMedia([old.id])).toBe(false);
    expect(await archive.media(next!.initObjectId!)).not.toBeNull();
  } finally {
    release();
    await incoming;
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
// 129 real fsynced files exercise the batch boundary; allow filesystem contention
// during the full suite without weakening the checkpoint assertions.
it('checkpoints an in-flight batch on graceful shutdown and resumes the remaining batch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-closing-delete-'));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let armed = true;
  let archive = await openArchive({
    root,
    fault: async (point) => {
      if (armed && point === 'before-unlink') {
        armed = false;
        entered();
        await gate;
      }
    },
  });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    for (let i = 0; i < 129; i++)
      await archive.commit({
        subjectId: 'stripchat:42',
        sourceEpoch: 'one',
        sourceSequence: String(i),
        init: null,
        bytes: new Uint8Array([i]),
        durationSeconds: 0.1,
        wallStartMs: 60000 + i * 100,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const plan = await archive.planDeletion!('stripchat:42', [{ fromMs: 60000, toMs: 120000 }]);
    const result = await archive.deleteSelection!('stripchat:42', plan.id, plan.personalRevision);
    expect(result.state).toBe('queued');
    await deleting;
    const closing = archive.close();
    release();
    await closing;

    // A different NAS has no old hot index or screenshot queue. Recovery must
    // reproduce the exact frozen progress before resetting runnable jobs.
    archive = await openArchive({
      root: path.join(root, 'restored-data'),
      mediaRoot: path.join(root, 'media'),
    });
    expect((await archive.deletionJobs!())[0]).toMatchObject({
      total: 129,
      processed: 128,
      state: 'queued',
    });
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!())[0]).toMatchObject({
      total: 129,
      processed: 129,
      state: 'completed',
    });
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
it('recovers a confirmed deletion after interruption without deleting later recordings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-durable-delete-'));
  let armed = false;
  let archive = await openArchive({
    root,
    fault: (point) => {
      if (armed && point === 'before-unlink') {
        armed = false;
        throw Error('INJECTED_DELETE_STOP');
      }
    },
  });
  try {
    const subject = { id: 'stripchat:42', providerId: 42, handle: 'fixture' };
    await archive.upsertSubjects([subject]);
    const commit = (sequence: string) =>
      archive.commit({
        subjectId: subject.id,
        sourceEpoch: 'one',
        sourceSequence: sequence,
        init: null,
        bytes: new Uint8Array([1, 2]),
        durationSeconds: 2,
        wallStartMs: 60000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const first = await commit('1');
    const plan = await archive.planDeletion!(subject.id, [{ fromMs: 60000, toMs: 120000 }]);
    armed = true;
    expect((await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision)).state).toBe(
      'queued',
    );
    await archive.resumeDeletions!();
    // Public archive reads fail closed while recovery is required.
    await archive.close();
    archive = await openArchive({ root });
    const later = await commit('2');
    const pending = await archive.deletionJobs!();
    expect(pending[0]).toMatchObject({ state: 'queued', total: 1, processed: 0 });
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!())[0]).toMatchObject({
      state: 'completed',
      total: 1,
      processed: 1,
      error: null,
    });
    expect(await archive.hasMedia([first.id])).toBe(false);
    expect(await archive.hasMedia([later.id])).toBe(true);
    await archive.close();
    archive = await openArchive({ root });
    expect((await archive.deletionJobs!())[0].state).toBe('completed');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('resumes the frozen deletion after a process exits between tombstone commit and progress checkpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-crashed-delete-'));
  const script = `import {openArchive} from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const a=await openArchive({root:${JSON.stringify(root)},fault(point){if(point==='after-tombstone-commit')process.exit(73)}});
    await a.upsertSubjects([{id:'stripchat:42',providerId:42,handle:'fixture'}]);
    for(let i=0;i<129;i++) await a.commit({subjectId:'stripchat:42',sourceEpoch:'one',sourceSequence:String(i),init:null,bytes:new Uint8Array([i]),durationSeconds:2,wallStartMs:60000+i*2000,timeBasis:'source-pdt',uncertaintyMs:0,discontinuity:false});
    const p=await a.planDeletion('stripchat:42',[{fromMs:60000,toMs:120000},{fromMs:120000,toMs:180000},{fromMs:180000,toMs:240000},{fromMs:240000,toMs:300000},{fromMs:300000,toMs:360000}]);
    await a.deleteSelection('stripchat:42',p.id,p.personalRevision);`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(73);
    const archive = await openArchive({ root });
    try {
      expect((await archive.deletionJobs!())[0]).toMatchObject({
        total: 129,
        processed: 0,
        state: 'queued',
      });
      await archive.resumeDeletions!();
      expect((await archive.deletionJobs!())[0]).toMatchObject({
        total: 129,
        processed: 129,
        state: 'completed',
      });
      expect((await archive.timeline('stripchat:42', 0, 400000)).segments).toHaveLength(0);
    } finally {
      await archive.close();
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
