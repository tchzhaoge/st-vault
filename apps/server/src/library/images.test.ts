import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LibraryImages } from './images.js';
import { AtomicDerivativeWriter } from '../previews/atomic-derivative.js';

it('publishes independent portraits concurrently while preserving same-key order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-images-parallel-'));
  const store = new LibraryImages(root, 'avatar', 4);
  const original = AtomicDerivativeWriter.prototype.write;
  let unblock!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const writing = vi
    .spyOn(AtomicDerivativeWriter.prototype, 'write')
    .mockImplementation(async function (this: AtomicDerivativeWriter, destination, bytes, options) {
      if (destination.includes('stripchat-1/') && !started) {
        started = true;
        await gate;
      }
      return original.call(this, destination, bytes, options);
    });
  try {
    const first = store.put('avatar:stripchat:1', Buffer.from('one'));
    await vi.waitFor(() => expect(started).toBe(true));
    const replacement = store.put('avatar:stripchat:1', Buffer.from('new'));
    await expect(store.put('avatar:stripchat:2', Buffer.from('two'))).resolves.toBe(true);
    expect(await store.get('avatar:stripchat:2')).toEqual(Buffer.from('two'));
    unblock();
    await Promise.all([first, replacement]);
    expect(await store.get('avatar:stripchat:1')).toEqual(Buffer.from('new'));
  } finally {
    unblock();
    await store.close();
    writing.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
