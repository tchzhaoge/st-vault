import type { IncomingHttpHeaders } from 'node:http';
import { allowsCredentialUrl } from '@st-vault/api-schema';

/** Origin is the browser-facing URL even when a gateway rewrites Host.
 * This is a transport policy, not a substitute for the independent CSRF gate. */
export function credentialTransport(
  headers: IncomingHttpHeaders,
  protocol: string,
  secureProxy = false,
): { allowed: boolean; secureCookie: boolean } {
  const url = headers.origin ?? `${secureProxy ? 'https' : protocol}://${headers.host ?? ''}`;
  return { allowed: allowsCredentialUrl(url), secureCookie: url.startsWith('https://') };
}
