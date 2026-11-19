import type { CoverageBucket, MediaTimeRange } from '@st-vault/api-schema';

export interface CoverageBand {
  key: number;
  fromMs: number;
  toMs: number;
  coveredMs: number;
  level: number;
}

/** Two sorted lists, linear intersection. Seen spans never paint empty coverage. */
export function splitSeenCoverage(bands: CoverageBand[], seen: MediaTimeRange[]) {
  const read: CoverageBand[] = [],
    unread: CoverageBand[] = [];
  let index = 0;
  for (const band of bands) {
    let cursor = band.fromMs;
    while (index < seen.length && seen[index].toMs <= cursor) index++;
    const add = (list: CoverageBand[], fromMs: number, toMs: number) => {
      if (toMs > fromMs)
        list.push({
          ...band,
          fromMs,
          toMs,
          key: fromMs,
          coveredMs: (band.coveredMs * (toMs - fromMs)) / (band.toMs - band.fromMs),
        });
    };
    for (let i = index; i < seen.length && seen[i].fromMs < band.toMs; i++) {
      const lo = Math.max(cursor, seen[i].fromMs),
        hi = Math.min(band.toMs, seen[i].toMs);
      add(unread, cursor, lo);
      add(read, lo, hi);
      cursor = Math.max(cursor, hi);
    }
    add(unread, cursor, band.toMs);
  }
  return [
    { seen: true, bands: read },
    { seen: false, bands: unread },
  ];
}

/** Coalesce visually adjacent surfaces; precise gaps remain in the original buckets. */
export function coverageBands(
  buckets: CoverageBucket[],
  from: number,
  to: number,
  pixelMs = 0,
): CoverageBand[] {
  const bands: CoverageBand[] = [];
  for (const bucket of buckets) {
    if (bucket.coveredMs <= 0 || bucket.toMs <= bucket.fromMs) continue;
    const lo = bucket.mediaFromMs ?? bucket.fromMs,
      hi = bucket.mediaToMs ?? bucket.toMs;
    if (hi <= lo || lo >= to || hi <= from) continue;
    // Sixteen visual levels including empty; small nonzero coverage never becomes empty.
    const level = Math.max(
      1,
      Math.min(15, Math.round((15 * bucket.coveredMs) / (bucket.toMs - bucket.fromMs))),
    );
    const previous = bands.at(-1);
    const gap = previous ? lo - previous.toMs : Infinity;
    if (previous?.level === level && (gap === 0 || (gap > 0 && gap < pixelMs))) {
      previous.toMs = hi;
      previous.coveredMs += bucket.coveredMs;
    } else
      bands.push({ key: bucket.fromMs, fromMs: lo, toMs: hi, coveredMs: bucket.coveredMs, level });
  }
  return bands;
}

/** Expand only the displayed marker; stored timestamps and seek bounds remain untouched. */
export function coverageGeometry(band: CoverageBand, from: number, to: number) {
  const duration = Math.max(1, to - from);
  const left = `${(100 * (band.fromMs - from)) / duration}%`;
  const visible = band.fromMs < to && band.toMs > from;
  return {
    left: visible && band.fromMs >= from ? `min(${left}, calc(100% - 1px))` : left,
    width: `${(100 * (band.toMs - band.fromMs)) / duration}%`,
    minWidth: !visible
      ? '0px'
      : band.fromMs < from
        ? `calc(1px + ${(100 * (from - band.fromMs)) / duration}%)`
        : '1px',
  };
}

/** One SVG surface, at most fifteen paths. Fragment count never becomes DOM count.
 * Keep gaps in the path and expand only visible subpixel fragments, not stored time. */
export function coverageSurface(bands: CoverageBand[], from: number, to: number, widthPx: number) {
  if (!bands.length) return null;
  const first = bands[0];
  const extent = {
    ...first,
    toMs: Math.max(...bands.map((band) => band.toMs)),
    coveredMs: bands.reduce((sum, band) => sum + band.coveredMs, 0),
  };
  const duration = Math.max(1, to - from);
  const span = Math.max(1, extent.toMs - extent.fromMs);
  const pixels = Math.max(1, (Math.max(1, widthPx) * span) / duration);
  const minimum = 1000 / pixels;
  const groups = new Map<number, string[]>();
  for (const band of bands) {
    let left = (1000 * (band.fromMs - extent.fromMs)) / span;
    let width = (1000 * (band.toMs - band.fromMs)) / span;
    if (band.fromMs < to && band.toMs > from) {
      width = Math.max(width, minimum);
      if (band.fromMs >= from)
        left = Math.min(left, (1000 * (to - extent.fromMs)) / span - minimum);
      else width = Math.max(width, (1000 * (from - band.fromMs)) / span + minimum);
    }
    // The outer surface itself supplies the minimum pixel for a tiny entire range.
    left = Math.max(0, left);
    width = Math.min(1000 - left, width);
    const path = `M${left} 0h${width}v100h${-width}Z`;
    const group = groups.get(band.level) ?? [];
    group.push(path);
    groups.set(band.level, group);
  }
  return {
    extent,
    paths: [...groups].map(([level, paths]) => ({ level, d: paths.join('') })),
  };
}
