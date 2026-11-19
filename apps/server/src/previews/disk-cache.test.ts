import { mkdtemp, rm, unlink, readdir, stat, open, rename } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { PreviewDiskCache } from './disk-cache.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof Fs>();
  return { ...fs, unlink: vi.fn(fs.unlink), open: vi.fn(fs.open), rename: vi.fn(fs.rename) };
});

it.each(['write', 'close', 'rename'] as const)(
  'cleans partial %s failures while preserving the previous image',
  async (phase) => {
    const root = await mkdtemp(path.join(tmpdir(), 'st-vault-cache-atomic-'));
    const image = Buffer.from([255, 216, 255, 217]);
    const disk = new PreviewDiskCache(root, 64, 2);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handles: Fs.FileHandle[] = [];
    try {
      expect(await disk.put('cover', image)).toBe(true);
      const actual = await vi.importActual<typeof Fs>('node:fs/promises');
      if (phase === 'rename')
        vi.mocked(rename).mockRejectedValueOnce(
          Object.assign(new Error('rename failed'), { code: 'EIO' }),
        );
      else
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          const file = await actual.open(...args);
          handles.push(file);
          if (phase === 'close')
            vi.spyOn(file, 'close').mockRejectedValueOnce(
              Object.assign(new Error('close failed'), { code: 'EIO' }),
            );
          else {
            const write = file.writeFile.bind(file);
            vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
              await write(image.subarray(0, 1));
              throw Object.assign(new Error('partial write'), { code: 'EIO' });
            });
          }
          return file;
        });
      expect(await disk.put('cover', Buffer.from([1, 2, 3, 4]))).toBe(false);
      expect(await disk.get('cover')).toEqual(image);
      expect((await readdir(root)).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      vi.mocked(open).mockReset();
      vi.mocked(rename).mockReset();
      for (const file of handles) await file.close();
      await disk.close();
      warnings.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('rejects new cache files when persistent unlink failures prevent quota recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-cache-quota-'));
  const image = Buffer.from([255, 216, 255, 217]);
  const disk = new PreviewDiskCache(root, 4, 1);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    expect(await disk.put('original', image)).toBe(true);
    vi.mocked(unlink).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    for (let n = 0; n < 5; n++) expect(await disk.put(`new-${n}`, image)).toBe(false);
    expect(await disk.get('original')).toEqual(image);
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect((await stat(path.join(root, files[0]))).size).toBe(4);
    expect(await disk.put('original', Buffer.from([255, 216, 255, 216, 255]))).toBe(false);
    expect(await disk.get('original')).toEqual(image);
  } finally {
    vi.mocked(unlink).mockReset();
    warning.mockRestore();
    await disk.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains failed pruning entries and retries without losing disk accounting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-cache-prune-'));
  const image = Buffer.from([255, 216, 255, 217]);
  const disk = new PreviewDiskCache(root, 6, 1);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await disk.put('cover', image);
    const original = (await readdir(root)).find((file) => file.endsWith('.img'))!;
    const actual = await vi.importActual<typeof Fs>('node:fs/promises');
    vi.mocked(unlink).mockImplementation(async (filename) => {
      if (String(filename).endsWith(original))
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      await actual.unlink(filename);
    });
    expect(await disk.put('new', image)).toBe(false);
    expect(await disk.get('cover')).toEqual(image);
    expect(warning).toHaveBeenCalled();
    vi.mocked(unlink).mockReset();
    expect(await disk.put('new', image)).toBe(true);
    expect(await disk.get('cover')).toBeNull();
  } finally {
    vi.mocked(unlink).mockReset();
    await disk.close();
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds generic cover and avatar derivatives and survives reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-cache-reopen-'));
  const image = Buffer.from([255, 216, 255, 217]);
  let disk = new PreviewDiskCache(root, 6, 1);
  try {
    await disk.put('cover:synthetic', image);
    await disk.put('avatar:synthetic', image);
    expect(await disk.get('cover:synthetic')).toBeNull();
    await disk.close();
    disk = new PreviewDiskCache(root, 6, 1);
    expect(await disk.get('avatar:synthetic')).toEqual(image);
  } finally {
    await disk.close();
    await rm(root, { recursive: true, force: true });
  }
});
