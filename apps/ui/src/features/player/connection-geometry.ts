interface Rail {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Port {
  right: number;
  top: number;
  height: number;
}
export function connectionGeometry(rail: Rail, port: Port, targetY: number) {
  const stacked = rail.width > 80;
  const startX = port.right - rail.left;
  const relative = (y: number): number =>
    stacked ? y - rail.top : Math.max(12, Math.min(rail.height - 12, y - rail.top));
  const y = relative(port.top + port.height / 2),
    endY = relative(targetY);
  const bendX = stacked ? rail.width - 12 : rail.width / 2,
    endX = rail.width - 2;
  return { startX, y, endY, bendX, endX, route: `M ${startX} ${y} H ${bendX} V ${endY} H ${endX}` };
}
