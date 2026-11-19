import { expect, it } from 'vitest';
import { popoverPlacement } from './popover-placement';

it('keeps the open panel attached to the same edge when refresh logs expand and shrink', () => {
  const anchor = { left: 200, top: 400, bottom: 430 };
  const viewport = { width: 1440, height: 900 };
  const initial = popoverPlacement(anchor, { width: 360, height: 200 }, viewport);
  expect(initial.side).toBe('below');
  const expanded = popoverPlacement(anchor, { width: 360, height: 600 }, viewport, initial.side);
  expect(expanded.side).toBe(initial.side);
  expect(expanded.top).toBe(initial.top);
  expect(expanded.maxHeight).toBe(450);
  expect(popoverPlacement(anchor, { width: 360, height: 100 }, viewport, expanded.side).top).toBe(
    initial.top,
  );
});

it('anchors above near the viewport bottom and bounds growth and horizontal overflow', () => {
  const viewport = { width: 800, height: 600 };
  const anchor = { left: 760, top: 500, bottom: 530 };
  const initial = popoverPlacement(anchor, { width: 360, height: 200 }, viewport);
  const expanded = popoverPlacement(anchor, { width: 360, height: 900 }, viewport, initial.side);
  expect(initial.side).toBe('above');
  expect(expanded.bottom).toBe(initial.bottom);
  expect(expanded.left).toBe(428);
  expect(expanded.maxHeight).toBe(480);
});

it('chooses the larger side when neither side can fit the initial content', () => {
  expect(
    popoverPlacement(
      { left: 0, top: 200, bottom: 230 },
      { width: 360, height: 900 },
      { width: 800, height: 900 },
    ).side,
  ).toBe('below');
});
