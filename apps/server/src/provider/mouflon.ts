import { createHash } from 'node:crypto';
import { ProviderError } from './http.js';

/** Decode an advertised address token; this never authorizes access to a room. */
export function decryptAddress(address: string, secret: string): string {
  if (!secret || secret.length > 65536) throw new ProviderError('invalid-decryption-key');
  const match = /_([^_?#]+)_(\d+)\.mp4(?=[?#]|$)/.exec(address);
  if (!match || match[1].length > 16384) throw new ProviderError('invalid-address-token');
  const encoded = [...match[1]].reverse().join('');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1)
    throw new ProviderError('invalid-address-token');
  const bytes = Buffer.from(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='), 'base64');
  const key = createHash('sha256').update(secret).digest();
  for (let index = 0; index < bytes.length; index++) bytes[index] ^= key[index % key.length];
  if (!bytes.length || bytes.some((byte) => byte < 0x21 || byte > 0x7e))
    throw new ProviderError('address-decryption-failed');
  const decoded =
    address.slice(0, match.index + 1) +
    bytes.toString('ascii') +
    address.slice(match.index + match[1].length + 1);
  let result: URL;
  try {
    result = new URL(decoded);
  } catch {
    throw new ProviderError('address-decryption-failed');
  }
  if (result.protocol !== 'https:' || result.username || result.password)
    throw new ProviderError('address-decryption-failed');
  return result.toString();
}
