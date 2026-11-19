import { expect, it } from 'vitest';
import { connectionGeometry } from './connection-geometry';
it('starts at the viewer corner port and follows the rail to the selected row', () => {
  const value = connectionGeometry(
    { left: 430, top: 60, width: 28, height: 830 },
    { right: 418, top: 72, height: 0 },
    180,
  );
  expect(value.startX).toBe(-12);
  expect(value.y).toBe(12);
  expect(value.endY).toBe(120);
  expect(value.route).toBe('M -12 12 H 14 V 120 H 26');
});
it('routes stacked views around the outer edge instead of through the video', () => {
  const value = connectionGeometry(
    { left: 8, top: 950, width: 374, height: 36 },
    { right: 370, top: 72, height: 0 },
    1080,
  );
  expect(value.y).toBe(-878);
  expect(value.bendX).toBe(362);
  expect(value.endY).toBe(130);
});
