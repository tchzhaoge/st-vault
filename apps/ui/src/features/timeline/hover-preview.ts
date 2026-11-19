import type { CoverageBucket } from '@st-vault/api-schema';

export interface ResolvedPreviewUnit {
  id: string;
  revision: number;
  fromMs: number;
  toMs: number;
}
/** A pointer coordinate is not a media identity. Reuse only authoritative unit bounds. */
export function samePreviewUnit(
  unit: ResolvedPreviewUnit | null,
  point: { id: string; revision: number; at: number },
): boolean {
  return (
    !!unit &&
    unit.id === point.id &&
    unit.revision === point.revision &&
    point.at >= unit.fromMs &&
    point.at < unit.toMs
  );
}

/** Match the visible one-pixel minimum without widening the stored media bounds. */
export function hoverMediaTime(
  buckets: CoverageBucket[],
  at: number,
  pixelMs: number,
): number | null {
  for (const bucket of buckets) {
    if (bucket.coveredMs <= 0) continue;
    const from = bucket.mediaFromMs ?? bucket.fromMs,
      to = bucket.mediaToMs ?? bucket.toMs;
    if (to > from && at >= from && at < Math.max(to, from + pixelMs))
      return Math.max(from, Math.min(to - 1, Math.round(at)));
  }
  return null;
}

export interface PreviewBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The visible recording lane owns the image size; the pointer only chooses its side. */
export function previewPosition(x: number, y: number, bounds: PreviewBounds) {
  const gap = 12;
  const availableRight = Math.max(0, bounds.right - x - gap);
  const availableLeft = Math.max(0, x - bounds.left - gap);
  const laneHeight = Math.max(0, bounds.bottom - bounds.top);
  const desiredWidth = Math.min(240, (laneHeight * 16) / 9);
  const right = availableRight >= desiredWidth || availableRight >= availableLeft;
  const width = Math.min(desiredWidth, right ? availableRight : availableLeft);
  if (width <= 0) return null;
  const height = (width * 9) / 16;
  return {
    left: right ? x + gap : x - gap - width,
    top: Math.max(bounds.top, Math.min(bounds.bottom - height, y - height / 2)),
    width,
    height,
  };
}
