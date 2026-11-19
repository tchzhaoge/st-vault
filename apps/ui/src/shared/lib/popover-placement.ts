export type PopoverSide = 'above' | 'below';
export function popoverPlacement(
  anchor: { left: number; top: number; bottom: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  preferredSide?: PopoverSide,
): { side: PopoverSide; left: number; top?: number; bottom?: number; maxHeight: number } {
  const below = Math.max(12, Math.min(anchor.bottom + 8, viewport.height - 12));
  const above = Math.max(12, Math.min(anchor.top - 8, viewport.height - 12));
  const spaceBelow = viewport.height - 12 - below;
  const spaceAbove = above - 12;
  const side =
    preferredSide ?? (panel.height <= spaceBelow || spaceBelow >= spaceAbove ? 'below' : 'above');
  return {
    side,
    left: Math.max(12, Math.min(anchor.left, viewport.width - panel.width - 12)),
    ...(side === 'below' ? { top: below } : { bottom: viewport.height - above }),
    maxHeight: Math.max(0, side === 'below' ? viewport.height - 12 - below : above - 12),
  };
}
