import { expect, it, vi } from 'vitest';
import { LayoutMotion, layoutDelta, exitWithinViewport } from './layout-motion';

it('measures all destination geometry before starting any layout animation', () => {
  const events: string[] = [];
  let left = 0;
  const rect = () => ({ left, top: 0, width: 100, height: 60, bottom: 60, right: left + 100 });
  const nodes = ['a', 'b'].map((key) => ({
    dataset: { motionKey: key },
    closest: () => null,
    getBoundingClientRect: () => {
      events.push('read');
      return rect();
    },
    animate: () => {
      events.push('write');
      return { cancel: vi.fn(), playState: 'finished' };
    },
  }));
  const root = {
    animate: vi.fn(),
    getBoundingClientRect: rect,
    querySelectorAll: () => nodes,
    classList: { contains: () => false },
    scrollLeft: 0,
    scrollTop: 0,
    dataset: {},
  };
  vi.stubGlobal('window', { innerHeight: 900, innerWidth: 1400 });
  vi.stubGlobal('document', { timeline: { currentTime: 0 } });
  vi.stubGlobal('getComputedStyle', () => ({ opacity: '1', translate: 'none', scale: 'none' }));
  try {
    const motion = new LayoutMotion();
    motion.update(root as unknown as HTMLElement, 'scope');
    events.length = 0;
    left = 20;
    root.getBoundingClientRect = () => ({ ...rect(), left: 0 });
    motion.update(root as unknown as HTMLElement, 'scope');
    expect(events).toEqual(['read', 'read', 'write', 'write']);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('animates data removal inside the viewport while skipping scroll eviction', () => {
  expect(exitWithinViewport(9, 10, 20)).toBe(false);
  expect(exitWithinViewport(20, 10, 20)).toBe(false);
  expect(exitWithinViewport(15, 10, 20)).toBe(true);
  expect(exitWithinViewport(15)).toBe(true);
});
it('captures every interrupted animation before cancellation and measures after all cancellations', () => {
  const events: string[] = [];
  let left = 0;
  const rect = (offset = left) => ({
    left: offset,
    top: 0,
    width: 100,
    height: 60,
    bottom: 60,
    right: offset + 100,
  });
  const nodes = ['a', 'b'].map((key) => ({
    dataset: { motionKey: key },
    closest: () => null,
    getBoundingClientRect: () => {
      events.push('rect');
      return rect();
    },
    animate: () => ({
      cancel: () => {
        events.push('cancel');
      },
      playState: 'running',
    }),
  }));
  const root = {
    animate: vi.fn(),
    getBoundingClientRect: () => rect(0),
    querySelectorAll: () => nodes,
    classList: { contains: () => false },
    scrollLeft: 0,
    scrollTop: 0,
    dataset: {},
  };
  vi.stubGlobal('window', { innerHeight: 900, innerWidth: 1400 });
  vi.stubGlobal('document', { timeline: { currentTime: 0 } });
  vi.stubGlobal('getComputedStyle', () => {
    events.push('style');
    return { opacity: '1', translate: '0px 0px', scale: '1 1' };
  });
  try {
    const motion = new LayoutMotion();
    motion.update(root as unknown as HTMLElement, 'scope');
    left = 20;
    motion.update(root as unknown as HTMLElement, 'scope');
    events.length = 0;
    left = 40;
    motion.update(root as unknown as HTMLElement, 'scope');
    expect(events).toEqual([
      'style',
      'style',
      'cancel',
      'cancel',
      'rect',
      'style',
      'rect',
      'style',
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
it('maps shared media centers and sizes without animating layout width', () => {
  expect(
    layoutDelta(
      { left: 0, top: 0, width: 100, height: 60 },
      { left: 100, top: 60, width: 50, height: 30 },
    ),
  ).toEqual({ translate: '-75px -45px', scale: '2 2' });
});
it('does not create animations for clock noise, unchanged cells or zero-sized hidden nodes', () => {
  const box = { left: 0, top: 0, width: 100, height: 60 };
  expect(layoutDelta(box, { ...box, left: 0.1 })).toBeNull();
  expect(layoutDelta(box, { ...box, width: 0 })).toBeNull();
});
