import { ProviderError } from './http.js';

export interface Variant {
  url: string;
  bandwidth: number;
  width: number;
  height: number;
}
export interface Master {
  variants: Variant[];
  keys: { name: string; psch: string }[];
}
export interface FullSegment {
  sequence: string;
  address: string;
  initUrl: string | null;
  durationSeconds: number;
  wallStartMs: number | null;
  discontinuity: boolean;
}
export interface Playlist {
  mediaSequence: bigint;
  discontinuitySequence: bigint;
  segments: FullSegment[];
  ended: boolean;
  protectedMode: boolean;
}

function bad(): never {
  throw new ProviderError('invalid-playlist');
}
function linesOf(text: string): string[] {
  if (text.length > 2 * 1024 * 1024) bad();
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== '#EXTM3U' || lines.length > 100000 || lines.some((line) => line.length > 65536))
    bad();
  if (lines.some((line) => line.startsWith('#EXT-X-SKIP:')))
    throw new ProviderError('unsupported-delta-playlist');
  return lines;
}
export function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const matcher = /(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of value.matchAll(matcher))
    result[match[1]] = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2];
  return result;
}
export function parseMaster(text: string, base: string): Master {
  const lines = linesOf(text),
    variants: Variant[] = [],
    keys: Master['keys'] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-MOUFLON:PSCH:')) {
      const fields = line.slice(20).split(':');
      const name = fields.at(-1),
        psch = fields.at(-2);
      if (name && psch && !keys.some((key) => key.name === name && key.psch === psch))
        keys.push({ name, psch });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = attributes(line.slice(18));
      const next = lines.slice(index + 1).find((value) => value && !value.startsWith('#'));
      if (!next) bad();
      const resolution = /^(\d+)x(\d+)$/.exec(attrs.RESOLUTION ?? '');
      const bandwidth = Number(attrs.BANDWIDTH ?? 0);
      if (!Number.isFinite(bandwidth) || bandwidth < 0) bad();
      const width = resolution ? Number(resolution[1]) : 0,
        height = resolution ? Number(resolution[2]) : 0;
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        (resolution && (!width || !height))
      )
        bad();
      variants.push({ url: new URL(next, base).toString(), bandwidth, width, height });
    }
  }
  if (!variants.length) bad();
  return { variants, keys };
}
export function parsePdt(value: string): number {
  const normalized = value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(
    normalized,
  );
  if (!match) bad();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const result = Date.parse(normalized);
  if (
    !Number.isFinite(result) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    bad();
  return result;
}
function protectedAddress(line: string): string {
  const value = line.slice('#EXT-X-MOUFLON:URI'.length);
  if (value.startsWith(':')) {
    const rest = value.slice(1).trim();
    if (rest.startsWith('URI=')) return attributes(rest).URI ?? '';
    return rest.startsWith('"') && rest.endsWith('"') ? rest.slice(1, -1) : rest;
  }
  if (value.startsWith('=')) return attributes(`URI${value}`).URI ?? '';
  if (value.startsWith(',')) return attributes(value.slice(1)).URI ?? '';
  return '';
}
export function parsePlaylist(text: string, base: string): Playlist {
  const lines = linesOf(text);
  const protectedMode = lines.some((line) => line.startsWith('#EXT-X-MOUFLON:URI'));
  let mediaSequence = 0n,
    discontinuitySequence = 0n,
    duration: number | undefined,
    pdt: number | null = null,
    discontinuity = false,
    initUrl: string | null = null;
  const segments: FullSegment[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.slice(22);
      if (!/^\d{1,20}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) bad();
      mediaSequence = BigInt(value);
    } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      const value = line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length);
      if (!/^\d{1,20}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) bad();
      discontinuitySequence = BigInt(value);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uri = attributes(line.slice(11)).URI;
      if (!uri) bad();
      const next = new URL(uri, base).toString();
      if (initUrl && next !== initUrl) discontinuity = true;
      initUrl = next;
    } else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = parsePdt(line.slice(25));
    else if (line.startsWith('#EXTINF:')) {
      const value = line.slice(8).split(',', 1)[0];
      duration = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) bad();
    } else if (line.startsWith('#EXT-X-MOUFLON:URI') || (line && !line.startsWith('#'))) {
      const isProtected = line.startsWith('#EXT-X-MOUFLON:URI');
      if (duration === undefined) continue; // LL-HLS parts/preload hints never create full segments.
      if (protectedMode && !isProtected) {
        duration = undefined;
        pdt = null;
        continue;
      } // Decoy consumes its own EXTINF.
      const address = isProtected ? protectedAddress(line) : line;
      if (!address || /_part\d+\.mp4(?:[?#]|$)/.test(address)) {
        duration = undefined;
        pdt = null;
        continue;
      }
      if (segments.length >= 20000) bad();
      segments.push({
        sequence: (mediaSequence + BigInt(segments.length)).toString(),
        address: new URL(address, base).toString(),
        initUrl,
        durationSeconds: duration,
        wallStartMs: pdt,
        discontinuity,
      });
      duration = undefined;
      pdt = null;
      discontinuity = false; // No absolute-time invention without a per-segment PDT.
    }
  }
  return {
    mediaSequence,
    discontinuitySequence,
    segments,
    ended: lines.includes('#EXT-X-ENDLIST'),
    protectedMode,
  };
}
