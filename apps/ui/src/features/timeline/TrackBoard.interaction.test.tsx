import type { ReactElement, ReactNode } from 'react';
import type * as React from 'react';
import type { Subject } from '@st-vault/api-schema';
import type { TrackData } from './TimelineBands';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrackBoard } from './TrackBoard';

const { stateUpdates, request, trackPlan } = vi.hoisted(() => ({
  stateUpdates: vi.fn(),
  trackPlan: vi.fn(() => ({ get: (): TrackData | undefined => undefined, failed: () => false })),
  request: vi.fn(() => new Promise(() => undefined)),
}));
// Exercise the pointer handlers without mounting layout/network hooks. Children are
// deliberately left unrendered so board state updates remain observable.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useState: (value: unknown) => [value, stateUpdates],
  useRef: (value: unknown) => ({ current: value }),
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));
vi.mock('../../shared/lib/api', () => ({ request }));
vi.mock('./use-track-data', () => ({
  useTrackData: trackPlan,
}));
vi.mock('../../shared/lib/sync', () => ({
  useSyncRefresh: () => undefined,
  useSyncClock: () => undefined,
}));

interface ElementProps {
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}
function find(
  element: ReactElement<ElementProps>,
  className: string,
): ReactElement<ElementProps> | null {
  if (element.props.className?.split(' ').includes(className)) return element;
  for (const child of [element.props.children].flat(Infinity)) {
    if (child && typeof child === 'object' && 'props' in child) {
      const match = find(child as ReactElement<ElementProps>, className);
      if (match) return match;
    }
  }
  return null;
}
const subject: Subject = {
  id: 'stripchat:1',
  providerId: 1,
  handle: 'one',
  monitorEnabled: true,
  autoRecord: true,
  providerStatus: 'PUBLIC',
  observedAtMs: null,
};
let frame: FrameRequestCallback | null = null;
const cancelFrame = vi.fn();
function flushFrame(): void {
  const callback = frame;
  frame = null;
  callback?.(0);
}
function setup(
  options: { preview?: boolean; timelineStartMs?: number; renderedWidth?: number } = {},
) {
  const choose = vi.fn<Parameters<typeof TrackBoard>[0]['onRangeChoose']>(() =>
    Promise.resolve(null),
  );
  const open = vi.fn(),
    move = vi.fn();
  const tree = TrackBoard({
    subjects: [subject],
    selectedId: null,
    fromMs: 1000,
    toMs: 2000,
    selection: { fromMs: 1200, toMs: 1600 },
    timelineStartMs: options.timelineStartMs ?? 0,
    nowMs: 3000,
    controls: null,
    onChoose: open,
    onRangeChoose: choose,
    onAnchor: vi.fn(),
    onViewChange: vi.fn(),
    onMove: move,
    onRecordingChange: () => Promise.resolve(),
  });
  const scroller = find(tree, 'track-table-scroll');
  // The header ref is owned by TrackBoard. React's mock ref callback is populated
  // directly because this test exercises coordinates rather than browser layout.
  const header = find(tree, 'track-header-viewport');
  const table = find(tree, 'track-table');
  if (!scroller || !header || !table) throw new Error('Missing track viewport');
  (header as unknown as { ref: { current: unknown } }).ref.current = {
    style: { setProperty: vi.fn() },
    querySelector: () => ({
      clientWidth: 100,
      getBoundingClientRect: () => ({ left: 0, width: options.renderedWidth ?? 100 }),
    }),
  };
  const preview = vi.fn();
  const overlay = (table.props.children as ReactElement[])[1];
  (overlay as unknown as { ref: { current: unknown } }).ref.current = {
    update: preview,
  };
  const target = {
    closest: (selector: string) =>
      (selector === '.subject-preview' && options.preview) ||
      (selector === '.track-lane' && !options.preview)
        ? {}
        : selector === '.track-row'
          ? { dataset: { subjectId: subject.id } }
          : null,
  };
  const currentTarget = {
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
    scrollTop: 0,
  };
  const event = (x: number) => ({
    button: 0,
    isPrimary: true,
    pointerId: 1,
    clientX: x,
    clientY: 10,
    target,
    currentTarget,
    preventDefault: vi.fn(),
  });
  const fire = (name: string, x: number, extra = {}): void => {
    (scroller.props[name] as (event: unknown) => void)({
      ...event(x),
      ...extra,
    });
  };
  return { choose, fire, preview, open, move, currentTarget };
}
beforeEach(() => {
  stateUpdates.mockClear();
  request.mockClear();
  cancelFrame.mockClear();
  frame = null;
  vi.stubGlobal('window', {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
    cancelAnimationFrame: cancelFrame,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps native scrolling inside the same visible rows out of React rendering', () => {
  const { fire } = setup();
  fire('onScroll', 0, { currentTarget: { scrollTop: 10, scrollLeft: 0, clientHeight: 500 } });
  const update = stateUpdates.mock.calls.at(-1)?.[0] as (value: {
    top: number;
    height: number;
  }) => { top: number; height: number };
  expect(typeof update).toBe('function');
  const previous = { top: 0, height: 500 };
  expect(update(previous)).toBe(previous);
});

it('commits the release coordinate outside the viewport instead of the last move', () => {
  const { choose, fire } = setup();
  fire('onPointerDown', 20);
  fire('onPointerMove', 40);
  fire('onPointerUp', 150);
  expect(choose).toHaveBeenCalledWith(
    subject,
    { fromMs: 1200, toMs: 2000 },
    expect.any(AbortSignal),
  );
});
it('uses the final coordinate for reverse selection too', () => {
  const { choose, fire } = setup();
  fire('onPointerDown', 80);
  fire('onPointerMove', 60);
  fire('onPointerUp', -50);
  expect(choose).toHaveBeenCalledWith(
    subject,
    { fromMs: 1000, toMs: 1800 },
    expect.any(AbortSignal),
  );
});
it('removes the released draft immediately and leaves no empty selection feedback', async () => {
  const { fire, preview } = setup();
  fire('onPointerDown', 20);
  fire('onPointerMove', 60);
  flushFrame();
  preview.mockClear();
  fire('onPointerUp', 60);
  expect(preview).toHaveBeenLastCalledWith(null);
  await Promise.resolve();
  expect(preview.mock.calls.every(([value]) => value === null)).toBe(true);
});
it('draws the raw range while dragging and snaps loaded edges immediately on release', () => {
  trackPlan.mockReturnValueOnce({
    get: () => ({
      coverage: {
        subjectId: subject.id,
        fromMs: 1000,
        toMs: 2000,
        revision: 1,
        unlocatedCount: 0,
        buckets: [
          {
            fromMs: 1000,
            toMs: 2000,
            coveredMs: 400,
            segmentCount: 1,
            mediaFromMs: 1200,
            mediaToMs: 1600,
          },
        ],
      },
      bands: [],
    }),
    failed: () => false,
  });
  const { fire, preview } = setup();
  fire('onPointerDown', 10);
  fire('onPointerMove', 90);
  flushFrame();
  expect(preview).toHaveBeenLastCalledWith({ id: subject.id, range: { fromMs: 1100, toMs: 1900 } });
  expect(request).not.toHaveBeenCalled();
  fire('onPointerUp', 90);
  expect(preview).toHaveBeenLastCalledWith({ id: subject.id, range: { fromMs: 1200, toMs: 1600 } });
  expect(request).not.toHaveBeenCalled();
});
it('shows an empty drag normally, then clears it immediately while validating fresh archive data', () => {
  trackPlan.mockReturnValueOnce({
    get: () => ({
      coverage: {
        subjectId: subject.id,
        fromMs: 1000,
        toMs: 2000,
        revision: 1,
        unlocatedCount: 0,
        buckets: [],
      },
      bands: [],
    }),
    failed: () => false,
  });
  const { fire, preview, choose, open } = setup();
  fire('onPointerDown', 20);
  fire('onPointerMove', 80);
  flushFrame();
  expect(preview).toHaveBeenLastCalledWith({ id: subject.id, range: { fromMs: 1200, toMs: 1800 } });
  fire('onPointerUp', 80);
  expect(preview).toHaveBeenLastCalledWith(null);
  expect(choose).toHaveBeenCalledExactlyOnceWith(
    subject,
    { fromMs: 1200, toMs: 1800 },
    expect.any(AbortSignal),
  );
  expect(open).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
it('uses the same fractional geometry for pointer origin and release distance', () => {
  const { fire, choose } = setup({ renderedWidth: 100.4 });
  fire('onPointerDown', 10.04);
  fire('onPointerMove', 90.36);
  fire('onPointerUp', 90.36);
  expect(choose).toHaveBeenCalledExactlyOnceWith(
    subject,
    { fromMs: 1100, toMs: 1900 },
    expect.any(AbortSignal),
  );
});
it('does not request approximate whole-window bounds or rerender the board on each move', () => {
  const { fire } = setup();
  fire('onPointerDown', 20);
  fire('onPointerMove', 40);
  flushFrame();
  stateUpdates.mockClear();
  fire('onPointerMove', 50);
  flushFrame();
  fire('onPointerMove', 60);
  flushFrame();
  expect(request).not.toHaveBeenCalled();
  expect(stateUpdates).not.toHaveBeenCalled();
});
it('cancels a selection without committing and clears its scheduled frame', () => {
  const { choose, fire } = setup();
  fire('onPointerDown', 20);
  fire('onPointerMove', 40);
  fire('onPointerCancel', 40);
  expect(choose).not.toHaveBeenCalled();
  expect(cancelFrame).toHaveBeenCalledWith(1);
  fire('onPointerUp', 80);
  expect(choose).not.toHaveBeenCalled();
});
it('coalesces pointer moves into one overlay update using the latest coordinates', () => {
  const { fire, preview } = setup();
  fire('onPointerDown', 20);
  preview.mockClear();
  fire('onPointerMove', 40);
  fire('onPointerMove', 50);
  fire('onPointerMove', 70);
  expect(preview).not.toHaveBeenCalled();
  flushFrame();
  expect(preview).toHaveBeenCalledExactlyOnceWith({
    id: subject.id,
    range: { fromMs: 1200, toMs: 1700 },
  });
});
it('aborts an unfinished commit before the next gesture and ignores its stale result', async () => {
  const { choose, fire, preview } = setup();
  let complete: (range: null) => void = () => {
    throw new Error('Commit did not start');
  };
  choose.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  fire('onPointerDown', 20);
  fire('onPointerMove', 40);
  fire('onPointerUp', 50);
  const signal = choose.mock.calls[0]?.[2] as AbortSignal | undefined;
  fire('onPointerDown', 60);
  fire('onPointerMove', 80);
  flushFrame();
  expect(signal?.aborted).toBe(true);
  preview.mockClear();
  complete(null);
  await Promise.resolve();
  expect(preview).not.toHaveBeenCalled();
});
it('leaves future-only drags empty and clips mixed selections to media time without shifting the view', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1500);
  const { choose, fire, move } = setup();
  fire('onPointerDown', 80);
  fire('onPointerMove', 90);
  fire('onPointerUp', 95);
  expect(choose).not.toHaveBeenCalled();
  fire('onPointerDown', 80);
  fire('onPointerMove', 20);
  fire('onPointerUp', 20);
  expect(choose).toHaveBeenCalledExactlyOnceWith(
    subject,
    { fromMs: 1200, toMs: 1500 },
    expect.any(AbortSignal),
  );
  expect(move).not.toHaveBeenCalled();
});
it('keeps deployment media bounds even though the visible day begins earlier', () => {
  const { choose, fire } = setup({ timelineStartMs: 1250 });
  fire('onPointerDown', 10);
  fire('onPointerMove', 80);
  fire('onPointerUp', 80);
  expect(choose).toHaveBeenCalledExactlyOnceWith(
    subject,
    { fromMs: 1250, toMs: 1800 },
    expect.any(AbortSignal),
  );
});
it('keeps primary horizontal selection with Alt and ignores middle-button drags', () => {
  const { choose, fire, move } = setup();
  fire('onPointerDown', 20, { button: 1 });
  fire('onPointerMove', 80);
  fire('onPointerUp', 80);
  expect(choose).not.toHaveBeenCalled();
  fire('onPointerDown', 20, { altKey: true });
  fire('onPointerMove', 80, { altKey: true });
  fire('onPointerUp', 80, { altKey: true });
  expect(choose).toHaveBeenCalledExactlyOnceWith(
    subject,
    { fromMs: 1200, toMs: 1800 },
    expect.any(AbortSignal),
  );
  expect(move).not.toHaveBeenCalled();
});
it('retains vertical row dragging and opens a clicked broadcaster directly', () => {
  const rows = setup();
  rows.fire('onPointerDown', 20);
  rows.fire('onPointerMove', 22, { clientY: -30 });
  rows.fire('onPointerUp', 22, { clientY: -30 });
  expect(rows.currentTarget.scrollTop).toBe(40);
  expect(rows.choose).not.toHaveBeenCalled();
  expect(rows.move).not.toHaveBeenCalled();
  const preview = setup({ preview: true });
  preview.fire('onPointerDown', 20);
  preview.fire('onPointerUp', 20);
  expect(preview.open).toHaveBeenCalledExactlyOnceWith(subject);
});

it('queries the complete calendar window when viewing the upcoming half of today', () => {
  const day = 86400000,
    start = Date.UTC(2026, 10, 7, 16);
  TrackBoard({
    subjects: [subject],
    selectedId: null,
    fromMs: start + day / 2,
    toMs: start + day,
    selection: { fromMs: start, toMs: start + 1800000 },
    timelineStartMs: start - day,
    nowMs: start + 4 * 3600000,
    controls: null,
    onChoose: vi.fn(),
    onRangeChoose: () => Promise.resolve(null),
    onAnchor: vi.fn(),
    onViewChange: vi.fn(),
    onMove: vi.fn(),
    onRecordingChange: () => Promise.resolve(),
  });
  expect(trackPlan).toHaveBeenLastCalledWith(
    expect.objectContaining({ fromMs: start + day / 2, toMs: start + day }),
  );
});
