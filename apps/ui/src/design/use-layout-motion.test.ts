import { afterEach, expect, it, vi } from 'vitest';
import { useLayoutMotion } from './use-layout-motion';

const hooks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  update: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock('./layout-motion', () => ({
  LayoutMotion: class {
    update = hooks.update;
    clear = hooks.clear;
  },
}));
afterEach(() => {
  hooks.effects = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it('recaptures resized CSS layouts without projecting stale media geometry and releases observation', () => {
  let resize!: () => void;
  const disconnect = vi.fn(),
    observe = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const node = {} as HTMLElement;
  useLayoutMotion({ current: node }, 'subject', 'packet');
  const cleanups = hooks.effects.map((effect) => effect());
  expect(observe).toHaveBeenCalledWith(node);
  resize();
  expect(hooks.update).toHaveBeenLastCalledWith(node, 'subject', undefined, false);
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(hooks.clear).toHaveBeenCalledOnce();
});
