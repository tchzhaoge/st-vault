import { afterEach, expect, it, vi } from 'vitest';
import {
  surfaceKeyframes,
  animateSurface,
  interruptSurface,
  indicateRow,
  panTimeline,
  joinTimelinePan,
} from './motion';
afterEach(() => vi.unstubAllGlobals());
it('uses the existing layer as the shared origin when navigation and row mounting coincide', () => {
  vi.stubGlobal('document', { timeline: { currentTime: 80 } });
  const existing = { animate: vi.fn(() => ({}) as Animation) } as unknown as HTMLElement;
  const incoming = { animate: vi.fn(() => ({}) as Animation) } as unknown as HTMLElement;
  vi.stubGlobal('getComputedStyle', (node: HTMLElement) => ({
    transform: node === existing ? 'old' : 'none',
  }));
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m41: number;
      constructor(value: string) {
        this.m41 = value === 'old' ? 25 : 0;
      }
    },
  );
  const previous = { effect: { target: existing }, cancel: vi.fn() } as unknown as Animation;
  panTimeline([existing, incoming], 80, [previous]);
  for (const node of [existing, incoming])
    expect(node.animate).toHaveBeenCalledWith(
      [{ transform: 'translateX(105px)' }, { transform: 'translateX(0)' }],
      expect.any(Object),
    );
});
it('cancels a pan without layout reads when the view changes scale', () => {
  const cancel = vi.fn(),
    animate = vi.fn();
  expect(
    panTimeline([{ animate } as unknown as HTMLElement], 0, [{ cancel } as unknown as Animation]),
  ).toEqual([]);
  expect(cancel).toHaveBeenCalledOnce();
  expect(animate).not.toHaveBeenCalled();
});
it('joins newly mounted rows at the original pan start time without restarting it', () => {
  const frames = [
    { transform: 'translateX(300px)', offset: 0 },
    { transform: 'translateX(0)', offset: 1 },
  ];
  const existing = { isConnected: true } as HTMLElement;
  const anchor = {
    playState: 'running',
    startTime: 10,
    cancel: vi.fn(),
    effect: {
      target: existing,
      getKeyframes: () => frames,
      getTiming: () => ({ duration: 420, easing: 'linear' }),
    },
  } as unknown as Animation;
  const created = {} as Animation;
  const animate = vi.fn(() => created);
  const incoming = { animate } as unknown as HTMLElement;
  expect(joinTimelinePan([existing, incoming], [anchor])).toEqual([anchor, created]);
  expect(animate).toHaveBeenCalledWith(frames, {
    id: 'timeline-pan',
    duration: 420,
    easing: 'linear',
  });
  expect(created.startTime).toBe(10);
  expect(anchor.cancel).not.toHaveBeenCalled();
});
it('drops detached or completed pan effects instead of retaining virtual rows', () => {
  const cancel = vi.fn();
  const stale = {
    playState: 'finished',
    cancel,
    effect: { target: { isConnected: false } },
  } as unknown as Animation;
  expect(joinTimelinePan([], [stale])).toEqual([]);
  expect(cancel).toHaveBeenCalledOnce();
});
it('pans every layer on one clock and retains its presented offset on repeated navigation', () => {
  vi.stubGlobal('document', { timeline: { currentTime: 100 } });
  vi.stubGlobal('getComputedStyle', () => ({ transform: 'none' }));
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m41 = 25;
    },
  );
  const created: Animation[] = [];
  const node = {
    animate: vi.fn(() => {
      const value = {} as Animation;
      created.push(value);
      return value;
    }),
  } as unknown as HTMLElement;
  const cancel = vi.fn();
  const result = panTimeline([node, node], 80, [
    { cancel, effect: { target: node } } as unknown as Animation,
  ]);
  expect(cancel).toHaveBeenCalledOnce();
  expect(result).toHaveLength(2);
  expect(result.every((item) => item.startTime === 100)).toBe(true);
  expect(node.animate).toHaveBeenCalledWith(
    [{ transform: 'translateX(105px)' }, { transform: 'translateX(0)' }],
    expect.objectContaining({ id: 'timeline-pan', duration: 420 }),
  );
});
it('restarts only the row locator overlay without changing geometry or underlying styles', () => {
  const cancel = vi.fn(),
    unrelated = vi.fn(),
    animate = vi.fn<(frames: Keyframe[], options: KeyframeAnimationOptions) => Animation>();
  const node = {
    getAnimations: () => [
      { id: 'row-reveal', cancel },
      { id: 'other', cancel: unrelated },
    ],
    animate,
  } as unknown as HTMLElement;
  indicateRow(node);
  expect(cancel).toHaveBeenCalledOnce();
  expect(unrelated).not.toHaveBeenCalled();
  const [frames, options] = animate.mock.calls[0];
  expect(options).toMatchObject({
    id: 'row-reveal',
    duration: 2600,
    fill: 'none',
    pseudoElement: '::after',
  });
  expect(frames[0].opacity).toBe(0);
  expect(frames[1].opacity).toBe(1);
  expect(frames.at(-1)?.opacity).toBe(0);
  for (const frame of frames) {
    expect(frame.transform).toBeUndefined();
    expect(frame.outlineColor).toBeUndefined();
    expect(frame.backgroundColor).toBeUndefined();
  }
});
it('anchors expansion and contraction at the same trigger with bounded travel', () => {
  const panel = { left: 20, top: 100, width: 400, height: 300 };
  const trigger = { left: 40, top: 60, width: 32, height: 32 };
  const opening = surfaceKeyframes(panel, trigger, false);
  expect(opening.origin).toBe('36px 0px');
  expect(opening.frames.at(-1)?.transform).toBe('none');
  expect(opening.frames[1].transform).toBe('scale(1.012, 1.01)');
  expect(surfaceKeyframes(panel, trigger, true).frames).toEqual(
    [...opening.frames].reverse().map((frame) => ({ ...frame, offset: 1 - Number(frame.offset) })),
  );
  expect(surfaceKeyframes(panel, { ...trigger, top: -10000 }, false).frames[0].transform).toContain(
    '-24px',
  );
});
it('handles browsers without Web Animations support', () => {
  const node = {} as HTMLElement;
  expect(animateSurface(node, node, false)).toBeNull();
  expect(node.animate).toBeUndefined();
});
it('keeps expansion and contraction ordered and finite even for empty layout rectangles', () => {
  const rect = { left: 0, top: 0, width: 0, height: 0 };
  for (const closing of [false, true]) {
    const { frames, origin } = surfaceKeyframes(rect, rect, closing);
    expect(origin).toBe('0px 0px');
    expect(frames[0].offset).toBe(0);
    expect(frames.at(-1)?.offset).toBe(1);
    for (let index = 1; index < frames.length; index++)
      expect(Number(frames[index].offset)).toBeGreaterThan(Number(frames[index - 1].offset));
    expect(JSON.stringify(frames)).not.toMatch(/NaN|Infinity/);
  }
});
it.each([
  ['280ms', 168],
  ['.32s', 192],
])('uses the CSS time unit %s for a bounded reverse transition', (token, expected) => {
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => token }));
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  const node = {
    style: {},
    animate,
    getBoundingClientRect: () => ({ left: 0, top: 100, width: 400, height: 300 }),
  } as unknown as HTMLElement;
  expect(animateSurface(node, node, true)).not.toBeNull();
  expect(animate.mock.calls[0]).toEqual([
    expect.any(Array),
    expect.objectContaining({ duration: expected, fill: 'forwards' }),
  ]);
});
it('preserves an interrupted presentation so rapid toggles do not jump to full size', () => {
  vi.stubGlobal('getComputedStyle', () => ({
    opacity: '.4',
    transform: 'matrix(.9, 0, 0, .85, 0, -10)',
    borderRadius: '30px',
  }));
  const cancel = vi.fn();
  const animation = { playState: 'running', cancel } as unknown as Animation;
  expect(interruptSurface(animation, {} as HTMLElement)).toEqual({
    opacity: '.4',
    transform: 'matrix(.9, 0, 0, .85, 0, -10)',
    borderRadius: '30px',
  });
  expect(cancel).toHaveBeenCalledOnce();
});
