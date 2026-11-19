import { ProviderError } from './http.js';

/** Convert a supplied header, JSON array or Netscape export into a one-shot header. */
export function parseAccountCookies(text: string, hostname: string, nowMs: number): string {
  if (!text.trim() || text.length > 65536 || text.includes('\0'))
    throw new ProviderError('invalid-cookies');
  const cookies = new Map<string, string>();
  let foreignDomain = false,
    matchingDomain = false;
  const add = (name: string, value: string): void => {
    if (!name || /[\x00-\x20\x7f;=]/.test(name) || /[\x00-\x20\x7f;]/.test(value))
      throw new ProviderError('invalid-cookies');
    cookies.set(name, value);
  };
  const lines = text.split(/\r?\n/);
  if (text.trim().startsWith('[')) {
    let rows: unknown;
    try {
      rows = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError('invalid-cookies');
    }
    if (!Array.isArray(rows) || rows.length > 512) throw new ProviderError('invalid-cookies');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new ProviderError('invalid-cookies');
      const item = row as Record<string, unknown>;
      if (
        typeof item.domain !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.value !== 'string'
      )
        throw new ProviderError('invalid-cookies');
      const domain = item.domain.replace(/^\./, '').toLowerCase();
      if (!(hostname === domain || (item.hostOnly !== true && hostname.endsWith(`.${domain}`)))) {
        foreignDomain = true;
        continue;
      }
      matchingDomain = true;
      if (item.path !== undefined && item.path !== '/') continue;
      if (item.session !== undefined && typeof item.session !== 'boolean')
        throw new ProviderError('invalid-cookies');
      let expired = false;
      for (const key of ['expirationDate', 'expires']) {
        const expiry = item[key];
        if (expiry === undefined) continue;
        if (typeof expiry !== 'number' || !Number.isFinite(expiry))
          throw new ProviderError('invalid-cookies');
        const sessionExpiry =
          (item.session === true && expiry <= 0) ||
          (key === 'expires' && expiry === -1 && item.session !== false);
        if (!sessionExpiry && expiry * 1000 <= nowMs) expired = true;
      }
      if (expired) continue;
      add(item.name, item.value);
    }
  } else if (lines.some((line) => line.includes('\t'))) {
    for (const original of lines) {
      const line = original.startsWith('#HttpOnly_') ? original.slice(10) : original;
      if (!line.trim() || line.startsWith('#')) continue;
      const fields = line.split('\t');
      if (fields.length !== 7) throw new ProviderError('invalid-cookies');
      const [rawDomain, includeSubdomains, path, secure, expires, name, value] = fields;
      const domain = rawDomain.replace(/^\./, '').toLowerCase();
      if (!(
        hostname === domain ||
        (includeSubdomains === 'TRUE' && hostname.endsWith(`.${domain}`))
      )) {
        foreignDomain = true;
        continue;
      }
      matchingDomain = true;
      if (path !== '/' || !['TRUE', 'FALSE'].includes(secure) || !/^\d+$/.test(expires)) continue;
      if (Number(expires) !== 0 && Number(expires) * 1000 <= nowMs) continue;
      add(name, value);
    }
  } else {
    if (/[\r\n]/.test(text.trim())) throw new ProviderError('invalid-cookies');
    for (const part of text
      .trim()
      .replace(/^Cookie:\s*/i, '')
      .split(';')) {
      const field = part.trim(),
        separator = field.indexOf('=');
      if (separator < 1) throw new ProviderError('invalid-cookies');
      add(field.slice(0, separator), field.slice(separator + 1));
    }
  }
  if (!cookies.size)
    throw new ProviderError(
      foreignDomain && !matchingDomain ? 'cookies-domain-mismatch' : 'no-applicable-cookies',
    );
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}
