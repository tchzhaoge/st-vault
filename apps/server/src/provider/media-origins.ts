/** Shared media trust boundary; website access points are deliberately separate. */
export const HLS_DOMAINS = [
  'doppiocdn.net',
  'doppiocdn.media',
  'doppiocdn.org',
  'doppiocdn.com',
] as const;
export const HLS_EDGES = [
  'edge-hls.doppiocdn.net',
  'edge-hls.doppiocdn.media',
  'edge-hls.doppiocdn.org',
  'edge-hls.doppiocdn.com',
] as const;
export const DEFAULT_HLS_EDGE = 'edge-hls.doppiocdn.net' satisfies (typeof HLS_EDGES)[number];
export function mediaHost(url: URL, hosts: readonly string[] = HLS_DOMAINS): boolean {
  return hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
