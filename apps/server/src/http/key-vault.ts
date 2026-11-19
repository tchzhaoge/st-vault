import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ArchivePort } from '../ports.js';
import { decryptAddress } from '../provider/mouflon.js';
import { ProviderError } from '../provider/http.js';

export interface AddressKey {
  name: string;
  value: string;
}

export class KeyVault {
  private current: AddressKey | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private sample: string | undefined;
  private constructor(
    private readonly archive: ArchivePort,
    private readonly master: Buffer,
  ) {}
  static async open(root: string, archive: ArchivePort): Promise<KeyVault> {
    const directory = path.join(await realpath(root), 'private');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (
      directoryInfo.isSymbolicLink() ||
      !directoryInfo.isDirectory() ||
      (await realpath(directory)) !== directory
    )
      throw new Error('INVALID_KEY_DIRECTORY');
    const file = path.join(directory, 'address-key.key');
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(randomBytes(32));
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== 'win32') {
        const parent = await open(directory, 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_KEY_FILE');
    const master = await readFile(file);
    if (master.length !== 32) throw new Error('INVALID_KEY_FILE');
    const vault = new KeyVault(archive, master);
    const saved = await archive.getSetting('provider.encrypted-keys');
    if (saved) {
      const envelope = JSON.parse(saved) as { iv: string; tag: string; data: string };
      const cipher = createDecipheriv('aes-256-gcm', master, Buffer.from(envelope.iv, 'base64'));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const stored = JSON.parse(
        Buffer.concat([
          cipher.update(Buffer.from(envelope.data, 'base64')),
          cipher.final(),
        ]).toString('utf8'),
      ) as Record<string, string>;
      const entries = Object.entries(stored);
      const last = entries.at(-1);
      if (last) {
        vault.current = { name: last[0], value: last[1] };
        if (entries.length > 1) await vault.persistKey(vault.current);
      }
    }
    return vault;
  }
  lookup = (name: string): string | undefined =>
    this.current?.name === name ? this.current.value : undefined;
  observeSample = (name: string, address: string): void => {
    if (this.current?.name === name || this.current?.name === '*') this.sample = address;
  };
  get key(): AddressKey | null {
    return this.current;
  }
  status(): 'pending' | 'usable' | 'unusable' {
    if (!this.current || !this.sample) return 'pending';
    try {
      decryptAddress(this.sample, this.current.value);
      return 'usable';
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return error.code === 'address-decryption-failed' ? 'unusable' : 'pending';
    }
  }
  get count(): number {
    return Number(this.current !== null);
  }
  /** Purpose-bound v1 secrets share the existing master, never the address-key envelope. */
  async readSealedSecret(purpose: 'account-sync'): Promise<string | null> {
    const saved = await this.archive.getSetting(`private.sealed.${purpose}`);
    if (!saved || saved === 'null') return null;
    try {
      if (saved.length > 512 * 1024) throw new Error();
      const value: unknown = JSON.parse(saved);
      if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('purpose' in value) ||
        value.purpose !== purpose
      )
        throw new Error();
      const field = (name: 'iv' | 'tag' | 'data', expected?: number): Buffer => {
        if (!(name in value)) throw new Error();
        const text = (value as Record<string, unknown>)[name];
        if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error();
        const bytes = Buffer.from(text, 'base64');
        if (
          bytes.toString('base64') !== text ||
          (expected !== undefined && bytes.length !== expected)
        )
          throw new Error();
        return bytes;
      };
      const decipher = createDecipheriv('aes-256-gcm', this.master, field('iv', 12));
      decipher.setAAD(Buffer.from(`st-vault:sealed-secret:v1:${purpose}`, 'utf8'));
      decipher.setAuthTag(field('tag', 16));
      return Buffer.concat([decipher.update(field('data')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('SEALED_SECRET_INVALID');
    }
  }
  writeSealedSecret(purpose: 'account-sync', value: string | null): Promise<void> {
    const operation = this.queue.then(async () => {
      if (value === null) {
        await this.archive.setSetting(`private.sealed.${purpose}`, 'null');
        return;
      }
      if (Buffer.byteLength(value, 'utf8') > 320 * 1024) throw new Error('SECRET_TOO_LARGE');
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.master, iv);
      cipher.setAAD(Buffer.from(`st-vault:sealed-secret:v1:${purpose}`, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      await this.archive.setSetting(
        `private.sealed.${purpose}`,
        JSON.stringify({
          version: 1,
          purpose,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        }),
      );
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  replace(key: AddressKey): Promise<void> {
    const operation = this.queue.then(async () => {
      await this.persistKey(key);
      if (this.current?.name !== key.name) this.sample = undefined;
      this.current = key;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private async persistKey(key: AddressKey): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ [key.name]: key.value }), 'utf8'),
      cipher.final(),
    ]);
    await this.archive.setSetting(
      'provider.encrypted-keys',
      JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      }),
    );
  }
}
