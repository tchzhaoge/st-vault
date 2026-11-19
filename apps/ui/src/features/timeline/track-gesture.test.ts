import { expect, it } from 'vitest';
import { trackGesture, TrackGestureSession } from './track-gesture';
it('waits for clear intent then draws horizontally and scrolls vertically', () => {
  expect(trackGesture(2, 2)).toBeNull();
  expect(trackGesture(10, 1)).toBe('selection');
  expect(trackGesture(-10, 1)).toBe('selection');
  expect(trackGesture(2, 20)).toBe('scroll');
  expect(trackGesture(-2, -20)).toBe('scroll');
});

const start = {
  id: 'subject',
  preview: false,
  x: 100,
  y: 100,
  at: 500,
  width: 100,
  scrollTop: 200,
  window: { fromMs: 0, toMs: 1000 },
  selection: { fromMs: 200, toMs: 800 },
  edge: null,
  timelineStartMs: 50,
};
it('locks vertical intent and compensates row-anchor scroll changes', () => {
  const session = new TrackGestureSession(start);
  expect(session.move(101, 102, 1000)).toEqual({ kind: 'idle' });
  expect(session.move(101, 120, 1000)).toEqual({ kind: 'scroll', top: 180 });
  session.compensateScroll(30);
  expect(session.move(180, 120, 1000)).toEqual({ kind: 'scroll', top: 210 });
  expect(session.finish(180, 1000)).toEqual({ kind: 'none' });
});
it('clamps reversible ranges to deployment, viewport and now', () => {
  const session = new TrackGestureSession(start);
  expect(session.move(0, 100, 900)).toEqual({
    kind: 'selection',
    range: { fromMs: 50, toMs: 500 },
  });
  expect(session.finish(200, 900)).toEqual({
    kind: 'selection',
    range: { fromMs: 500, toMs: 900 },
  });
  const edge = new TrackGestureSession({ ...start, at: 200, edge: 'from' });
  edge.move(110, 100, 1000);
  expect(edge.finish(110, 1000)).toEqual({ kind: 'selection', range: { fromMs: 300, toMs: 800 } });
  const right = new TrackGestureSession({ ...start, at: 800, edge: 'to' });
  right.move(140, 100, 2000);
  expect(right.finish(140, 2000)).toEqual({
    kind: 'selection',
    range: { fromMs: 200, toMs: 1000 },
  });
  const empty = new TrackGestureSession({ ...start, width: 0 });
  expect(empty.move(140, 100, 1000)).toEqual({ kind: 'selection', range: null });
  expect(empty.finish(140, 1000)).toEqual({ kind: 'none' });
});
it('distinguishes preview clicks from drags and never commits a cancelled gesture', () => {
  const click = new TrackGestureSession({ ...start, preview: true });
  expect(click.finish(100, 1000)).toEqual({ kind: 'choose' });
  const drag = new TrackGestureSession({ ...start, preview: true });
  expect(drag.move(120, 100, 1000)).toEqual({ kind: 'idle' });
  expect(drag.finish(120, 1000)).toEqual({ kind: 'none' });
  const cancelled = new TrackGestureSession(start);
  cancelled.move(140, 100, 1000);
  cancelled.cancel();
  expect(cancelled.move(150, 100, 1000)).toEqual({ kind: 'idle' });
  expect(cancelled.finish(140, 1000)).toEqual({ kind: 'none' });
});
