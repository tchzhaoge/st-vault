import type { Variant } from './hls.js';

/** Short edge identifies a quality tier for landscape and portrait broadcasts alike. */
const size = (variant: Variant): number => Math.min(variant.width, variant.height);
export function rankedVariants(variants: Variant[]): Variant[] {
  return [...variants].sort(
    (a, b) =>
      size(b) - size(a) || b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth,
  );
}
