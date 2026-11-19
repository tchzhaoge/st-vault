import { intervalAtIndex } from '../../shared/lib/time';
interface FragmentClock {
  sn: number | string;
  cc: number;
  start: number;
  duration: number;
  programDateTime: number | null;
}
/** Keep clocks for buffered fragments after they leave the sliding playlist. */
export class LiveClock {
  private readonly retained = new Map<string, FragmentClock>();
  observe(fragments: readonly (FragmentClock | null)[], earliestMediaTime: number): void {
    for (const fragment of fragments)
      if (valid(fragment)) {
        const { sn, cc, start, duration, programDateTime } = fragment;
        this.retained.set(`${cc}:${sn}`, { sn, cc, start, duration, programDateTime });
      }
    for (const [key, fragment] of this.retained)
      if (fragment.start + fragment.duration <= earliestMediaTime) this.retained.delete(key);
    // Metadata has the same bounded lifetime as the media buffer; malformed or
    // extremely short playlists cannot grow this cache indefinitely.
    while (this.retained.size > 512) this.retained.delete(this.retained.keys().next().value!);
  }
  toUtc(media: number): number | null {
    return liveMediaToUtc([...this.retained.values()], media);
  }
  toMedia(utc: number): number | null {
    return liveUtcToMedia([...this.retained.values()], utc);
  }
}
function valid(
  fragment: FragmentClock | null,
): fragment is FragmentClock & { programDateTime: number } {
  return (
    fragment !== null &&
    fragment.programDateTime !== null &&
    Number.isFinite(fragment.programDateTime) &&
    Number.isFinite(fragment.start) &&
    Number.isFinite(fragment.duration) &&
    fragment.duration > 0
  );
}
/** The media clock is continuous across discontinuities; wall time need not be. */
export function liveMediaToUtc(
  fragments: readonly (FragmentClock | null)[],
  media: number,
): number | null {
  if (!Number.isFinite(media)) return null;
  const fragment =
    fragments[
      intervalAtIndex(
        fragments,
        media,
        (item) => (valid(item) ? item.start : null),
        (item) => (valid(item) ? item.start + item.duration : null),
      )
    ];
  return fragment && valid(fragment)
    ? fragment.programDateTime + (media - fragment.start) * 1000
    : null;
}
export function liveUtcToMedia(
  fragments: readonly (FragmentClock | null)[],
  utc: number,
): number | null {
  if (!Number.isFinite(utc)) return null;
  const fragment =
    fragments[
      intervalAtIndex(
        fragments,
        utc,
        (item) => (valid(item) ? item.programDateTime : null),
        (item) => (valid(item) ? item.programDateTime + item.duration * 1000 : null),
      )
    ];
  return fragment && valid(fragment)
    ? fragment.start + (utc - fragment.programDateTime) / 1000
    : null;
}
