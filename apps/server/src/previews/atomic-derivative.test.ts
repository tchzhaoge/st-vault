import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  open,
  rename,
  unlink,
  opendir,
  mkdir,
  symlink,
} from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { AtomicDerivativeWriter } from './atomic-derivative.js';
import { DerivativeDiagnostics } from './derivative-diagnostics.js';
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    open: vi.fn(fs.open),
    rename: vi.fn(fs.rename),
    unlink: vi.fn(fs.unlink),
    opendir: vi.fn(fs.opendir),
  };
});
afterEach(() => {
  vi.mocked(open).mockReset();
  vi.mocked(rename).mockReset();
  vi.mocked(unlink).mockReset();
  vi.mocked(opendir).mockReset();
  vi.restoreAllMocks();
});
const target = (root: string) => path.join(root, `${'a'.repeat(64)}.img`);
const temporary = 'a'.repeat(64) + '.img.00000000-0000-4000-8000-000000000001.tmp';
const failed = (code = 'EIO') => Object.assign(new Error('synthetic I/O failure'), { code });

it('owns sidecar temporary cleanup and cancellation using the same publication boundary as JPEGs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-sidecar-'));
  await mkdir(path.join(root, '42'));
  const destination = path.join(root, '42', '60000-60500.jpg.json');
  const writer = new AtomicDerivativeWriter(root, 'snapshot', new DerivativeDiagnostics());
  try {
    vi.mocked(rename).mockRejectedValueOnce(failed());
    await expect(
      writer.write(destination, Buffer.from('{"hash":"test"}'), { sync: true }),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(await readdir(path.join(root, '42'))).toEqual([]);
    await expect(
      writer.write(destination, Buffer.from('{}'), {
        beforePublish: () => {
          throw Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(await readdir(path.join(root, '42'))).toEqual([]);
    await writer.write(destination, Buffer.from('{"hash":"valid"}'), { sync: true });
    expect(await readFile(destination, 'utf8')).toBe('{"hash":"valid"}');
  } finally {
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('recovers an unresolved orphan after restart without removing the old image or unrelated files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-orphan-restart-'));
  const diagnostics = new DerivativeDiagnostics(),
    writer = new AtomicDerivativeWriter(root, 'cache', diagnostics);
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let restarted: AtomicDerivativeWriter | undefined;
  try {
    await writeFile(target(root), 'old');
    await writeFile(path.join(root, 'video.mp4'), 'keep');
    vi.mocked(rename).mockRejectedValue(failed());
    vi.mocked(unlink).mockRejectedValue(failed('EACCES'));
    await expect(writer.write(target(root), Buffer.from('new'))).rejects.toThrow();
    await writer.close();
    diagnostics.close();
    expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(1);
    vi.mocked(rename).mockReset();
    vi.mocked(unlink).mockReset();
    restarted = new AtomicDerivativeWriter(root, 'cache', new DerivativeDiagnostics());
    await restarted.recover(1000);
    expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    expect(await readFile(target(root), 'utf8')).toBe('old');
    expect(await readFile(path.join(root, 'video.mp4'), 'utf8')).toBe('keep');
    const openCount = vi.mocked(open).mock.calls.length;
    await expect(
      restarted.write(path.join(root, 'video.mp4'), Buffer.from('invalid')),
    ).rejects.toThrow('INVALID_DERIVATIVE_DESTINATION');
    expect(vi.mocked(open)).toHaveBeenCalledTimes(openCount);
  } finally {
    vi.mocked(rename).mockReset();
    vi.mocked(unlink).mockReset();
    await writer.close();
    await restarted?.close();
    logs.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['open', 'write', 'sync', 'close', 'rename'] as const)(
  'cleans %s failure and preserves the destination',
  async (phase) => {
    const root = await mkdtemp(path.join(tmpdir(), 'st-vault-atomic-'));
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics = new DerivativeDiagnostics();
    const writer = new AtomicDerivativeWriter(root, 'cache', diagnostics);
    const closeHandles: (() => Promise<void>)[] = [];
    try {
      await writeFile(target(root), 'old');
      const actual = await vi.importActual<typeof Fs>('node:fs/promises');
      if (phase === 'rename') vi.mocked(rename).mockRejectedValueOnce(failed());
      else if (phase === 'open') vi.mocked(open).mockRejectedValueOnce(failed());
      else
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          const file = await actual.open(...args);
          const close = file.close.bind(file);
          closeHandles.push(close);
          if (phase === 'write') {
            const write = file.writeFile.bind(file);
            vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
              await write('partial');
              throw failed();
            });
          } else vi.spyOn(file, phase).mockRejectedValueOnce(failed());
          return file;
        });
      await expect(
        writer.write(target(root), Buffer.from('new'), { sync: true }),
      ).rejects.toMatchObject({ code: 'EIO' });
      expect(await readFile(target(root), 'utf8')).toBe('old');
      expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
      expect(logs).toHaveBeenCalled();
    } finally {
      for (const close of closeHandles) await close();
      await writer.close();
      diagnostics.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('blocks new temp creation while cleanup is denied and recovers on the next write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-orphan-'));
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const diagnostics = new DerivativeDiagnostics(() => 0);
  const writer = new AtomicDerivativeWriter(root, 'cache', diagnostics);
  try {
    await writeFile(target(root), 'old');
    vi.mocked(rename).mockRejectedValue(failed());
    vi.mocked(unlink).mockRejectedValue(failed('EACCES'));
    await expect(writer.write(target(root), Buffer.from('new'))).rejects.toMatchObject({
      code: 'EIO',
    });
    for (let n = 0; n < 1000; n++)
      await expect(writer.write(target(root), Buffer.from('new'))).rejects.toThrow(
        'DERIVATIVE_CLEANUP_PENDING',
      );
    expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(1);
    expect(await readFile(target(root), 'utf8')).toBe('old');
    expect(logs.mock.calls.length).toBeLessThanOrEqual(2);
    const cleanupCalls = vi.mocked(unlink).mock.calls.length;
    expect(writer.status()).toMatchObject({
      active: false,
      pending: true,
      error: 'temporary_cleanup_failed',
      retryAtMs: null,
    });
    writer.status();
    expect(vi.mocked(unlink)).toHaveBeenCalledTimes(cleanupCalls);
    vi.mocked(rename).mockReset();
    vi.mocked(unlink).mockReset();
    await writer.write(target(root), Buffer.from('new'));
    expect(await readFile(target(root), 'utf8')).toBe('new');
    expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    expect(writer.status()).toMatchObject({ pending: false, error: null });
    await writer.close();
    diagnostics.close();
    expect(logs.mock.calls.length).toBeLessThanOrEqual(3);
  } finally {
    vi.mocked(rename).mockReset();
    vi.mocked(unlink).mockReset();
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('coalesces recovery, admits one writer per destination and never unlinks an active temp', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-writer-owner-'));
  const diagnostics = new DerivativeDiagnostics();
  const writer = new AtomicDerivativeWriter(root, 'cache', diagnostics);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    expect(writer.recover()).toBe(writer.recover());
    const actual = await vi.importActual<typeof Fs>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const write = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async (bytes) => {
        await gate;
        await write(bytes);
      });
      return file;
    });
    const first = writer.write(target(root), Buffer.from('new'));
    await expect(writer.write(target(root), Buffer.from('other'))).rejects.toThrow(
      'DERIVATIVE_WRITE_BUSY',
    );
    await vi.waitFor(() => expect(vi.mocked(open)).toHaveBeenCalledOnce());
    await writer.recover(1000);
    expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(1);
    release();
    await first;
    const calls = vi.mocked(unlink).mock.calls.length;
    expect(calls).toBe(0); // A successful rename already consumed the temp.
    await writer.close();
    await expect(writer.write(target(root), Buffer.from('closed'))).rejects.toThrow(
      'DERIVATIVE_WRITER_CLOSED',
    );
  } finally {
    release();
    await writer.close();
    diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes another destination while a slow write stays owned through recovery and close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-parallel-writer-'));
  const diagnostics = new DerivativeDiagnostics();
  const writer = new AtomicDerivativeWriter(root, 'cache', diagnostics);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const actual = await vi.importActual<typeof Fs>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const write = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async (bytes) => {
        await gate;
        await write(bytes);
      });
      return file;
    });
    const first = writer.write(target(root), Buffer.from('slow'));
    await vi.waitFor(() => expect(vi.mocked(open)).toHaveBeenCalledOnce());
    const secondPath = path.join(root, 'b'.repeat(64) + '.img');
    await writer.write(secondPath, Buffer.from('fast'));
    expect(await readFile(secondPath, 'utf8')).toBe('fast');
    await writer.recover(1000);
    expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(1);
    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([first, closing]);
    expect(await readFile(target(root), 'utf8')).toBe('slow');
    expect(vi.mocked(unlink)).not.toHaveBeenCalled();
  } finally {
    release();
    await writer.close();
    diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retries a failed directory scan without a timer and recovers only recognized orphan names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-writer-restart-'));
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const diagnostics = new DerivativeDiagnostics();
  const writer = new AtomicDerivativeWriter(root, 'cache', diagnostics);
  const time = vi.spyOn(Date, 'now').mockReturnValue(10000);
  try {
    await writeFile(path.join(root, temporary), 'partial');
    await writeFile(path.join(root, 'unknown.tmp'), 'keep');
    vi.mocked(opendir).mockRejectedValueOnce(failed('EACCES'));
    await writer.recover();
    expect(writer.status()).toMatchObject({
      recovering: false,
      pending: true,
      error: 'temporary_scan_failed',
      retryAtMs: 11000,
    });
    expect(JSON.stringify(writer.status())).not.toContain(root);
    writer.status();
    expect(vi.mocked(opendir)).toHaveBeenCalledTimes(1);
    await writer.recover();
    expect(vi.mocked(opendir)).toHaveBeenCalledTimes(1);
    time.mockReturnValue(11000);
    await writer.recover(1000);
    expect(await readdir(root)).toEqual(['unknown.tmp']);
    expect(writer.status()).toMatchObject({ pending: false, error: null, retryAtMs: null });
    const before = vi.mocked(opendir).mock.calls.length;
    await writer.close();
    await writer.recover();
    expect(vi.mocked(opendir)).toHaveBeenCalledTimes(before);
    expect(logs).toHaveBeenCalledOnce();
  } finally {
    await writer.close();
    diagnostics.close();
    time.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('advances screenshot cleanup in bounded batches, preserves jpgs and skips symlink directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-writer-scan-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'st-vault-outside-'));
  const diagnostics = new DerivativeDiagnostics();
  const writer = new AtomicDerivativeWriter(root, 'snapshot', diagnostics);
  try {
    await mkdir(path.join(root, '42'));
    await writeFile(path.join(root, '42', '1-2.jpg'), 'complete');
    const orphan = '1-2.jpg.00000000-0000-4000-8000-000000000001.tmp';
    await writeFile(path.join(root, '42', orphan), 'partial');
    await writeFile(path.join(outside, orphan), 'keep');
    await symlink(outside, path.join(root, '43'));
    await writer.recover(1);
    expect(await readFile(path.join(root, '42', orphan), 'utf8')).toBe('partial');
    await writer.recover(1000);
    expect(await readdir(path.join(root, '42'))).toEqual(['1-2.jpg']);
    expect(await readFile(path.join(outside, orphan), 'utf8')).toBe('keep');
  } finally {
    await writer.close();
    diagnostics.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
it('writes unit-keyed images and removes only recognized hashed orphan temporaries after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-unit-writer-'));
  const diagnostics = new DerivativeDiagnostics(),
    writer = new AtomicDerivativeWriter(root, 'snapshot', diagnostics);
  const name = `1-2-${'a'.repeat(64)}.jpg`;
  const temporary = `3-4-${'b'.repeat(64)}.jpg.00000000-0000-4000-8000-000000000001.tmp`;
  const unrelated = `3-4-${'c'.repeat(63)}.jpg.00000000-0000-4000-8000-000000000001.tmp`;
  try {
    await mkdir(path.join(root, '42'));
    await writeFile(path.join(root, '42', temporary), 'orphan');
    await writeFile(path.join(root, '42', unrelated), 'keep');
    await writer.recover(1000);
    await expect(readFile(path.join(root, '42', temporary))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(root, '42', unrelated), 'utf8')).toBe('keep');
    await writer.write(path.join(root, '42', name), Buffer.from('complete'));
    expect(await readFile(path.join(root, '42', name), 'utf8')).toBe('complete');
    await expect(
      writer.write(path.join(root, '42', `1-2-${'a'.repeat(63)}.jpg`), Buffer.from('invalid')),
    ).rejects.toThrow('INVALID_DERIVATIVE_DESTINATION');
  } finally {
    await writer.close();
    diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});
