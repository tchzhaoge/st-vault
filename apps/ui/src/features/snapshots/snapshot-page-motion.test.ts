import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotPageMotion } from './snapshot-page-motion';

afterEach(() => vi.unstubAllGlobals());
it('slides forward up and backward down, preserves pixels and ignores refreshes', () => {
  const layers: {
    append: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    animate: ReturnType<typeof vi.fn>;
  }[] = [];
  const animation = (frames?: unknown, options?: unknown) => ({
    cancel: vi.fn(),
    onfinish: null,
    frames,
    options,
  });
  vi.stubGlobal('document', {
    createElement: () => {
      const layer = {
        append: vi.fn(),
        remove: vi.fn(),
        animate: vi.fn(animation),
        setAttribute: vi.fn(),
      };
      layers.push(layer);
      return layer;
    },
  });
  const previous = {
    isConnected: false,
    classList: { contains: () => false },
    getAnimations: () => [],
    querySelectorAll: () => [],
    removeAttribute: vi.fn(),
  };
  const root = {
    children: [previous],
    parentElement: { append: vi.fn() },
    animate: vi.fn(animation),
  };
  const motion = new SnapshotPageMotion();
  const update = (scope: string, page: number) =>
    motion.update(root as unknown as HTMLElement, scope, page);
  update('recording', 1);
  expect(root.animate).not.toHaveBeenCalled();
  update('recording', 2);
  expect(root.animate.mock.calls[0][0]).toEqual([
    { transform: 'translateY(100%)' },
    { transform: 'translateY(0%)' },
  ]);
  expect(layers[0].animate.mock.calls[0][0]).toEqual([
    { transform: 'translateY(0%)' },
    { transform: 'translateY(-100%)' },
  ]);
  expect(layers[0].append).toHaveBeenCalledWith(previous);
  update('recording', 2);
  root.children = [{ ...previous }];
  update('recording', 2);
  expect(root.animate).toHaveBeenCalledTimes(1);
  update('recording', 1);
  expect(layers[0].remove).toHaveBeenCalledOnce();
  expect(root.animate.mock.calls[1][0]).toEqual([
    { transform: 'translateY(-100%)' },
    { transform: 'translateY(0%)' },
  ]);
  update('another-recording', 3);
  expect(root.animate).toHaveBeenCalledTimes(2);
  expect(layers[1].remove).toHaveBeenCalledOnce();
  motion.clear();
});
