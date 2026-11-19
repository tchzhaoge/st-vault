/** Explicit local address ranges; DNS names are not assumed to be LAN-only. */
export function allowsPlainHttp(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  if (/^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(host)) return true;
  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function allowsCredentialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && allowsPlainHttp(url.hostname));
  } catch {
    return false;
  }
}
