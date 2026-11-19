/* eslint-disable @typescript-eslint/require-await -- Offline importer fixture. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openArchive } from '../archive/index.js';
import { KeyVault } from '../http/key-vault.js';
import { SyncClock } from '../runtime/sync-clock.js';
import { createAccountSync } from './account-sync.js';

it('recovers an encrypted accepted account against the real portable library without replaying membership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-activation-'));
  const clock = new SyncClock({ intervalMs: () => 5000 });
  let archive = await openArchive({ root });
  let vault = await KeyVault.open(root, archive);
  const firstCookie = 'synthetic-private-account-A',
    nextCookie = 'synthetic-private-account-B';
  const provider = {
    importList: vi.fn(async (cookies: string) => [
      {
        id: cookies === firstCookie ? 'stripchat:42' : 'stripchat:84',
        providerId: cookies === firstCookie ? 42 : 84,
        handle: cookies === firstCookie ? 'AccountA-follow' : 'AccountB-follow',
      },
    ]),
  };
  const options = { clock, provider, supervisor: { reconcile: async () => undefined } };
  let service = await createAccountSync({ ...options, archive, vault });
  try {
    await service.configure({ cookiesText: firstCookie });
    const write = vault.writeSealedSecret.bind(vault);
    vi.spyOn(vault, 'writeSealedSecret')
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(Error('SIMULATED_FINAL_PRIVATE_FAILURE'));
    await expect(service.configure({ cookiesText: nextCookie })).rejects.toThrow(
      'account_sync_unavailable',
    );
    const published = await archive.accountActivation();
    expect(published).toMatch(/^[a-f0-9-]{36}$/);
    expect((await archive.listSubjects()).find((row) => row.id === 'stripchat:42')?.archived).toBe(
      true,
    );
    expect((await archive.listSubjects()).find((row) => row.id === 'stripchat:84')?.archived).toBe(
      false,
    );
    const pending = JSON.parse((await vault.readSealedSecret('account-sync'))!) as unknown;
    expect(pending).toMatchObject({
      version: 2,
      active: { cookiesText: firstCookie },
      pending: { generation: published, next: { cookiesText: nextCookie } },
    });
    await service.close();
    await archive.close();
    archive = await openArchive({ root });
    vault = await KeyVault.open(root, archive);
    const replay = vi.spyOn(archive, 'activateAccountSubjects');
    service = await createAccountSync({ ...options, archive, vault });
    expect(replay).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ connected: true, error: null });
    expect(JSON.parse((await vault.readSealedSecret('account-sync'))!) as unknown).toMatchObject({
      active: { cookiesText: nextCookie },
      pending: null,
    });
    await service.refresh();
    expect(provider.importList).toHaveBeenLastCalledWith(nextCookie, expect.any(AbortSignal));
    // Inspect only this tiny synthetic library, not any formal media directory.
    const inspect = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) await inspect(filename);
        else {
          const bytes = await readFile(filename);
          expect(bytes.includes(Buffer.from(firstCookie))).toBe(false);
          expect(bytes.includes(Buffer.from(nextCookie))).toBe(false);
        }
      }
    };
    await inspect(path.join(root, 'media'));
  } finally {
    await service.close();
    await clock.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
