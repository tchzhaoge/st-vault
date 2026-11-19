import type { ReactElement } from 'react';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { FocusTimeline } from './FocusTimeline';
import { request } from '../../shared/lib/api';
import { useSyncRefresh } from '../../shared/lib/sync';
import { readWorkbench } from '../timeline/use-track-data';
import {
  beginDeletionProjection,
  clearDeletionProjections,
  adoptDeletionProjection,
} from '../../shared/lib/deletion-projection';

const writes = vi.hoisted(() => [] as unknown[]);

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useState: (value: unknown) => [value, (next: unknown) => writes.push(next)],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('../../shared/lib/sync', () => ({ useSyncRefresh: vi.fn(), useDisplayClock: vi.fn() }));
vi.mock('../../shared/lib/api', () => ({ request: vi.fn() }));
vi.mock('../../design/use-layout-motion', () => ({ useLayoutMotion: () => undefined }));
afterEach(() => {
  clearDeletionProjections();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  writes.length = 0;
});

it('adds protection demand only while an unliked deletion awaits publication', async () => {
  vi.mocked(request).mockResolvedValue({ rows: [] });
  const signal = new AbortController().signal;
  await readWorkbench(['stripchat:1', 'stripchat:2'], 0, 100, 20, signal);
  expect(vi.mocked(request).mock.calls.at(-1)![0]).not.toContain('protection=');
  beginDeletionProjection(
    'd',
    'stripchat:2',
    { kind: 'range', mode: 'unliked', fromMs: 0, toMs: 100 },
    [],
    [],
  );
  await readWorkbench(['stripchat:1', 'stripchat:2'], 0, 100, 20, signal);
  expect(vi.mocked(request).mock.calls.at(-1)![0]).toContain('&protection=stripchat%3A2');
  adoptDeletionProjection({
    id: 'd',
    subjectId: 'stripchat:2',
    state: 'running',
    phase: 'delete',
    total: 1,
    processed: 0,
    reclaimedBytes: 0,
    fromMs: 0,
    toMs: 100,
    createdAtMs: 1,
    updatedAtMs: Date.now() + 1,
    error: null,
    deletionRevision: 4,
  });
  await readWorkbench(['stripchat:2'], 0, 100, 20, signal);
  expect(vi.mocked(request).mock.calls.at(-1)![0]).not.toContain('protection=');
});

it('accepts media coverage even when auxiliary run events fail', async () => {
  const coverage = { marker: 'fresh-coverage' };
  vi.mocked(request).mockImplementation((path) => {
    if (path.startsWith('/api/events/runs')) return Promise.reject(Error('RUNS_UNAVAILABLE'));
    return Promise.resolve({ rows: [{ coverage, status: { buckets: [] } }] });
  });
  FocusTimeline({
    subjectId: 'stripchat:1',
    window: { fromMs: 1000, toMs: 2000 },
    timelineStartMs: 0,
    atMs: null,
    onSeek: vi.fn(),
  });
  const refresh = vi
    .mocked(useSyncRefresh)
    .mock.calls.find(([topics]) => topics.includes('timeline'))![1];
  await expect(refresh(new AbortController().signal)).resolves.toBeUndefined();
  expect(writes).toContainEqual({
    id: 'stripchat:1',
    data: { coverage, bands: [] },
  });
});

it('never renders a disconnected playhead even when an old media callback supplies a time', () => {
  const html = renderToStaticMarkup(
    FocusTimeline({
      subjectId: null,
      window: { fromMs: 1000, toMs: 2000 },
      timelineStartMs: 0,
      atMs: 1500,
      onSeek: vi.fn(),
    }),
  );
  expect(html).not.toContain('class="focus-playhead"');
});

function setup() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const onSeek = vi.fn();
  const timeline = FocusTimeline({
    subjectId: 'stripchat:1',
    window: { fromMs: 1000, toMs: 2000 },
    timelineStartMs: 0,
    atMs: null,
    onSeek,
  }) as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>;
  const lane = [timeline.props.children]
    .flat()
    .find((child) => child.props.className === 'focus-lane')!;
  const currentTarget = {
    focus: vi.fn(),
    getBoundingClientRect: () => ({ left: 10, width: 100 }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
  const fire = (name: string, clientX: number, elapsed = 100): void => {
    clock += elapsed;
    (lane.props[name] as (event: unknown) => void)({
      button: 0,
      pointerId: 1,
      clientX,
      currentTarget,
      preventDefault: vi.fn(),
    });
  };
  return { fire, onSeek };
}
it('delegates playback slider keys to the player dispatcher instead of owning a second seek target', () => {
  const onSeek = vi.fn();
  const tree = FocusTimeline({
    subjectId: 'stripchat:1',
    window: { fromMs: 1000, toMs: 61000 },
    timelineStartMs: 0,
    atMs: 11000,
    onSeek,
  }) as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>;
  const lane = [tree.props.children]
    .flat()
    .find((child) => child.props.className === 'focus-lane')!;
  expect(lane.props['data-player-seek']).toBe('true');
  expect(lane.props.onKeyDown).toBeUndefined();
});
it('renders the playback lane without reserving a date or ruler row', () => {
  const html = renderToStaticMarkup(
    FocusTimeline({
      subjectId: null,
      window: { fromMs: 1000, toMs: 2000 },
      timelineStartMs: 0,
      atMs: null,
      onSeek: vi.fn(),
    }),
  );
  expect(html).toContain('class="focus-lane"');
  expect(html).not.toContain('timeline-ruler');
  expect(html).not.toContain('<time');
  expect(html).toContain('aria-disabled="true"');
});
it.each([1000, 1500, 2000])('keeps the playback marker inside the lane at %i', (atMs) => {
  const html = renderToStaticMarkup(
    FocusTimeline({
      subjectId: 'stripchat:1',
      window: { fromMs: 1000, toMs: 2000 },
      timelineStartMs: 0,
      atMs,
      onSeek: vi.fn(),
    }),
  );
  expect(html).toContain('aria-disabled="false"');
  expect(html).toContain(`left:clamp(1.5px, ${(atMs - 1000) / 10}%, calc(100% - 1.5px))`);
});
it('submits the latest fast pointer move while held and cancels pending seeks on capture loss', () => {
  vi.useFakeTimers();
  const { fire, onSeek } = setup();
  fire('onPointerDown', 30);
  fire('onPointerMove', 60, 10);
  expect(onSeek).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(80);
  expect(onSeek).toHaveBeenLastCalledWith(1500);
  fire('onPointerMove', 90, 10);
  fire('onLostPointerCapture', 90, 0);
  vi.advanceTimersByTime(80);
  expect(onSeek).toHaveBeenCalledTimes(2);
});

it.each([
  [30, 50, 80, 1700],
  [90, 70, 40, 1300],
])(
  'seeks from the release coordinate after drawing from %i through %i to %i',
  (down, move, up, expected) => {
    const { fire, onSeek } = setup();
    fire('onPointerDown', down);
    expect(onSeek).toHaveBeenCalledTimes(1);
    fire('onPointerMove', move);
    expect(onSeek).toHaveBeenCalledTimes(2);
    fire('onPointerUp', up);
    expect(onSeek).toHaveBeenCalledTimes(3);
    expect(onSeek).toHaveBeenLastCalledWith(expected);
  },
);

it('keeps cancellation from committing a later pointer release', () => {
  const { fire, onSeek } = setup();
  fire('onPointerDown', 30);
  fire('onPointerMove', 50);
  expect(onSeek).toHaveBeenCalledTimes(2);
  onSeek.mockClear();
  fire('onPointerCancel', 50);
  fire('onPointerUp', 80);
  expect(onSeek).not.toHaveBeenCalled();
});

it('does not seek on release without an active gesture', () => {
  const { fire, onSeek } = setup();
  fire('onPointerUp', 80);
  expect(onSeek).not.toHaveBeenCalled();
});

it.each([
  [-100, 1000],
  [1000, 1999],
])('keeps a released seek inside the exclusive playback interval at %i', (up, expected) => {
  const { fire, onSeek } = setup();
  fire('onPointerDown', 30);
  fire('onPointerUp', up);
  expect(onSeek).toHaveBeenCalledTimes(2);
  expect(onSeek).toHaveBeenLastCalledWith(expected);
});
