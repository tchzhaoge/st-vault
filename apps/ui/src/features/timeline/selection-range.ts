import type { ViewWindow } from './range-control';
import type { CoverageResponse } from '@st-vault/api-schema';
/** Use already-rendered metadata; never put an RPC or a layout animation on the drag path. */
export function snapCoverageRange(
  range: ViewWindow,
  coverage?: CoverageResponse,
): ViewWindow | null {
  if (!coverage || coverage.fromMs > range.fromMs || coverage.toMs < range.toMs) return range;
  let fromMs = Infinity,
    toMs = -Infinity;
  for (const bucket of coverage.buckets) {
    if (bucket.coveredMs <= 0) continue;
    const lo = Math.max(range.fromMs, bucket.mediaFromMs ?? bucket.fromMs);
    const hi = Math.min(range.toMs, bucket.mediaToMs ?? bucket.toMs);
    if (hi <= lo) continue;
    fromMs = Math.min(fromMs, lo);
    toMs = Math.max(toMs, hi);
  }
  return toMs > fromMs ? { fromMs, toMs } : null;
}
export function dragRange(anchor: number, cursor: number, limits: ViewWindow): ViewWindow | null {
  const fromMs = Math.max(limits.fromMs, Math.round(Math.min(anchor, cursor))),
    toMs = Math.min(limits.toMs, Math.round(Math.max(anchor, cursor)));
  return toMs > fromMs ? { fromMs, toMs } : null;
}
export function snapRange(range: ViewWindow, bounds: ViewWindow | null): ViewWindow | null {
  if (!bounds) return null;
  const fromMs = Math.max(range.fromMs, bounds.fromMs),
    toMs = Math.min(range.toMs, bounds.toMs);
  return toMs > fromMs ? { fromMs, toMs } : null;
}
