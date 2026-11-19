/** CDN URLs contain their content version (snapshot timestamp or preview hash). */
export function coverSource(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return !url.username &&
      !url.password &&
      [
        'https://static-proxy.strpst.com',
        'https://static-cdn.strpst.com',
        'https://img.doppiocdn.net',
        'https://img.doppiocdn.org',
      ].includes(url.origin)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function broadcastCover(providerId: number, item: Record<string, unknown>): string | null {
  const value = item.snapshotTimestamp;
  const stamp = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return item.isLive !== false &&
    typeof stamp === 'number' &&
    Number.isSafeInteger(stamp) &&
    stamp > 0
    ? `https://img.doppiocdn.org/snapshot/${providerId}/${stamp}`
    : null;
}
