import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { openArchive } from '../archive/index.js';
import { KeyVault } from './key-vault.js';
import { createKeyValidation } from './key-validation.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'st-vault-sealed-secret-')),
    archive = await openArchive({ root });
  cleanups.push(async () => {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, archive, vault: await KeyVault.open(root, archive) };
}
describe('purpose-bound account credential encryption', () => {
  it('automatically validates the current key and replaces it atomically', async () => {
    const { root, archive, vault } = await fixture();
    const value = 'fixture-key';
    await vault.replace({ name: 'fixture', value });
    expect(vault.status()).toBe('pending');
    const bytes = Buffer.from('fixture-token');
    const digest = createHash('sha256').update(value).digest();
    for (let index = 0; index < bytes.length; index++) bytes[index] ^= digest[index];
    const token = [...bytes.toString('base64')].reverse().join('');
    const sample = vi.fn(() =>
      Promise.resolve({
        name: 'fixture',
        address: `https://fixture.invalid/segment_${token}_42.mp4`,
      }),
    );
    const validation = createKeyValidation(vault, sample);
    validation.start();
    await vi.waitFor(() => expect(vault.status()).toBe('usable'));
    expect(sample).toHaveBeenCalledOnce();
    await validation.close();
    await vault.replace({ name: 'fixture', value: 'wrong-key' });
    expect(vault.status()).toBe('unusable');
    await Promise.all([
      vault.replace({ name: 'earlier', value: 'other-key' }),
      vault.replace({ name: 'later', value: 'new-key' }),
    ]);
    const reopened = await KeyVault.open(root, archive);
    expect(reopened.key).toEqual({ name: 'later', value: 'new-key' });
    expect(reopened.lookup('fixture')).toBeUndefined();
    expect(reopened.count).toBe(1);
  });
  it('collapses an old encrypted key table to its last stored entry', async () => {
    const { root, archive } = await fixture();
    const master = await readFile(path.join(root, 'private/address-key.key'));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', master, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify({ old: 'old-key', retained: 'retained-key' }), 'utf8'),
      cipher.final(),
    ]);
    const legacy = JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
    await archive.setSetting('provider.encrypted-keys', legacy);
    const vault = await KeyVault.open(root, archive);
    expect(vault.key).toEqual({ name: 'retained', value: 'retained-key' });
    expect(vault.lookup('old')).toBeUndefined();
    expect(await archive.getSetting('provider.encrypted-keys')).not.toBe(legacy);
  });
  it('starts empty and persists only manually imported keys across reopening', async () => {
    const { root, archive, vault } = await fixture();
    const name = 'synthetic';
    expect(vault.count).toBe(0);
    expect(vault.lookup(name)).toBeUndefined();
    await vault.replace({ name, value: 'synthetic-manual-override' });
    const reopened = await KeyVault.open(root, archive);
    expect(reopened.lookup(name)).toBe('synthetic-manual-override');
    expect(reopened.count).toBe(1);
  });
  it('uses random authenticated envelopes, survives vault reopen and does not alter address keys', async () => {
    const { root, archive, vault } = await fixture(),
      plain = JSON.stringify({ cookiesText: 'synthetic-cookie-secret' });
    await vault.replace({ name: 'synthetic', value: 'synthetic-address-key' });
    await vault.writeSealedSecret('account-sync', plain);
    const first = await archive.getSetting('private.sealed.account-sync');
    expect(first).not.toContain('synthetic-cookie-secret');
    expect(first).not.toContain('cookiesText');
    expect(JSON.parse(first!) as unknown).toMatchObject({ version: 1, purpose: 'account-sync' });
    expect(await vault.readSealedSecret('account-sync')).toBe(plain);
    await vault.writeSealedSecret('account-sync', plain);
    expect(await archive.getSetting('private.sealed.account-sync')).not.toBe(first);
    const reopened = await KeyVault.open(root, archive);
    expect(await reopened.readSealedSecret('account-sync')).toBe(plain);
    expect(reopened.lookup('synthetic')).toBe('synthetic-address-key');
    expect(reopened.count).toBe(1);
    await reopened.writeSealedSecret('account-sync', null);
    expect(await reopened.readSealedSecret('account-sync')).toBeNull();
    expect(await archive.getSetting('private.sealed.account-sync')).toBe('null');
  });
  it('rejects version/purpose changes, ciphertext tampering and copying the address-key envelope', async () => {
    const { archive, vault } = await fixture();
    await vault.writeSealedSecret('account-sync', 'synthetic-cookie-secret');
    const saved = (await archive.getSetting('private.sealed.account-sync'))!;
    const envelope = JSON.parse(saved) as Record<string, unknown>;
    for (const patch of [
      { version: 2 },
      { purpose: 'other-purpose' },
      { tag: Buffer.alloc(16).toString('base64') },
      { iv: Buffer.alloc(11).toString('base64') },
      { data: 'broken==' },
    ]) {
      await archive.setSetting(
        'private.sealed.account-sync',
        JSON.stringify({ ...envelope, ...patch }),
      );
      await expect(vault.readSealedSecret('account-sync')).rejects.toThrow('SEALED_SECRET_INVALID');
    }
    await vault.replace({ name: 'synthetic', value: 'synthetic-address-key' });
    const address = JSON.parse((await archive.getSetting('provider.encrypted-keys'))!) as Record<
      string,
      unknown
    >;
    await archive.setSetting(
      'private.sealed.account-sync',
      JSON.stringify({ ...address, version: 1, purpose: 'account-sync' }),
    );
    await expect(vault.readSealedSecret('account-sync')).rejects.toThrow('SEALED_SECRET_INVALID');
    await archive.setSetting('private.sealed.account-sync', saved);
    expect(await vault.readSealedSecret('account-sync')).toBe('synthetic-cookie-secret');
  });
});
