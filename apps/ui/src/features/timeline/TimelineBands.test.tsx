import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { TimelineBands, type TrackData } from './TimelineBands';
import { useLayoutMotion } from '../../design/use-layout-motion';
import {
  beginDeletionProjection,
  clearDeletionProjections,
} from '../../shared/lib/deletion-projection';
vi.mock('../../design/use-layout-motion', () => ({ useLayoutMotion: vi.fn() }));

const data = (bands: TrackData['bands']): TrackData => ({
  coverage: {
    subjectId: 'one',
    fromMs: 1000,
    toMs: 3000,
    revision: 1,
    unlocatedCount: 0,
    buckets: [{ fromMs: 2500, toMs: 3000, coveredMs: 500, segmentCount: 1 }],
  },
  bands,
});
afterEach(() => {
  vi.restoreAllMocks();
  clearDeletionProjections();
});
it.each([true, false])(
  'keeps protected seen coverage before and after the demand read (%s)',
  (serverMask) => {
    const input = data([]);
    if (serverMask) input.coverage.protectedSpans = [{ fromMs: 2600, toMs: 2700 }];
    input.coverage.seenSpans = [{ fromMs: 2500, toMs: 3000 }];
    beginDeletionProjection(
      'delete',
      'one',
      { kind: 'range', mode: 'unliked', fromMs: 2500, toMs: 3000 },
      [{ fromMs: 2500, toMs: 3000 }],
      [],
      [{ fromMs: 2600, toMs: 2700 }],
    );
    const html = renderToStaticMarkup(<TimelineBands data={input} fromMs={1000} toMs={3000} />);
    expect(html).toContain('data-seen="true"');
    expect(html).toContain('width:5%');
    expect(html).not.toContain('track-favorite-range');
  },
);
it('omits standalone likes while separating seen from unread coverage', () => {
  const input = data([]);
  Object.assign(input.coverage, { seenSpans: [{ fromMs: 2500, toMs: 2750 }] });
  input.coverage.protectedSpans = [{ fromMs: 2500, toMs: 2750 }];
  const html = renderToStaticMarkup(<TimelineBands data={input} fromMs={1000} toMs={3000} />);
  expect(html).not.toContain('track-favorite-range');
  expect(html).toContain('data-seen="true"');
  expect(html).toContain('data-seen="false"');
  expect(html.match(/class="track-clip"/g)).toHaveLength(2);
});
it('does not restart geometry motion for metadata-only revisions', () => {
  const input = data([]);
  renderToStaticMarkup(<TimelineBands data={input} fromMs={1000} toMs={3000} />);
  const first = vi.mocked(useLayoutMotion).mock.calls.at(-1)![2];
  input.coverage.revision++;
  renderToStaticMarkup(<TimelineBands data={structuredClone(input)} fromMs={1000} toMs={3000} />);
  expect(vi.mocked(useLayoutMotion).mock.calls.at(-1)![2]).toBe(first);
  input.coverage.buckets[0].toMs = 2900;
  renderToStaticMarkup(<TimelineBands data={input} fromMs={1000} toMs={3000} />);
  expect(vi.mocked(useLayoutMotion).mock.calls.at(-1)![2]).not.toBe(first);
});
it('clips live status against the supplied display clock independently of playback progress', () => {
  const input = data([
    {
      fromMs: 1000,
      toMs: 3000,
      status: 'PUBLIC',
      durationsMs: { PUBLIC: 2000, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 0 },
    },
  ]);
  vi.spyOn(Date, 'now').mockReturnValue(10000);
  const early = renderToStaticMarkup(
    <TimelineBands data={input} fromMs={1000} toMs={3000} nowMs={1500} />,
  );
  const later = renderToStaticMarkup(
    <TimelineBands data={input} fromMs={1000} toMs={3000} nowMs={2000} />,
  );
  expect(early).toMatch(/status-band-public[^>]*width:25%/);
  expect(later).toMatch(/status-band-public[^>]*width:50%/);
});
it('draws a dense week as one coverage surface instead of hundreds of animated elements', () => {
  const input = data([]);
  const week = 7 * 86400000;
  input.coverage.fromMs = 0;
  input.coverage.toMs = week;
  input.coverage.buckets = Array.from({ length: 720 }, (_, index) => ({
    fromMs: (index * week) / 720,
    toMs: ((index + 1) * week) / 720,
    coveredMs: week / 720,
    segmentCount: 100,
  }));
  const html = renderToStaticMarkup(<TimelineBands data={input} fromMs={0} toMs={week} />);
  expect(html.match(/class="track-clip"/g)).toHaveLength(1);
});
it('bounds coverage DOM even when every bucket has a different density or a gap', () => {
  const input = data([]);
  input.coverage.buckets = Array.from({ length: 720 }, (_, index) => ({
    fromMs: 1000 + index * 2,
    toMs: 1001 + index * 2,
    coveredMs: index % 2 ? 0.3 : 0.8,
    segmentCount: 1,
  }));
  const html = renderToStaticMarkup(
    <TimelineBands data={input} fromMs={1000} toMs={3000} widthPx={1000} />,
  );
  expect(html.match(/class="track-clip"/g)).toHaveLength(1);
  expect(html.match(/<path /g)).toHaveLength(2);
});
it('keeps a one-millisecond recording at the right edge visible inside the viewport', () => {
  const input = data([]);
  const week = 7 * 86400000;
  input.coverage.fromMs = 0;
  input.coverage.toMs = week;
  input.coverage.buckets = [
    {
      fromMs: 0,
      toMs: week,
      coveredMs: 1,
      segmentCount: 1,
      mediaFromMs: week - 1,
      mediaToMs: week,
    },
  ];
  const html = renderToStaticMarkup(<TimelineBands data={input} fromMs={0} toMs={week} />);
  expect(html).toContain('class="track-clip"');
  expect(html).toContain('calc(100% - 1px)');
  expect(html).toContain('min-width:1px');
});
it('keeps coverage without drawing a separate favorite marker', () => {
  const input = data([]);
  input.coverage.protectedSpans = [{ fromMs: 500, toMs: 1500 }];
  const html = renderToStaticMarkup(<TimelineBands data={input} fromMs={1000} toMs={3000} />);
  expect(html).not.toContain('track-favorite-range');
  expect(html).toContain('track-clip');
  expect(html).not.toContain('播放喜欢时刻');
});
it('leaves future status empty while preserving real media indexes and the full UTC scale', () => {
  vi.spyOn(Date, 'now').mockReturnValue(2000);
  const html = renderToStaticMarkup(
    <TimelineBands
      data={data([
        {
          fromMs: 2000,
          toMs: 3000,
          status: 'UNKNOWN',
          durationsMs: { PUBLIC: 0, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 1000 },
        },
      ])}
      fromMs={1000}
      toMs={3000}
    />,
  );
  expect(html).not.toContain('status-band-');
  expect(html).not.toContain('未知');
  expect(html).toMatch(
    /class="track-clip"[^>]+style="left:min\(75%, calc\(100% - 1px\)\);width:25%/,
  );
});
it('keeps historical unknown stripes and clips a mixed band at now without counting future unknown time', () => {
  vi.spyOn(Date, 'now').mockReturnValue(2000);
  const input = data([
      {
        fromMs: 1000,
        toMs: 1500,
        status: 'UNKNOWN',
        durationsMs: { PUBLIC: 0, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 500 },
      },
      {
        fromMs: 1500,
        toMs: 3000,
        status: 'UNKNOWN',
        durationsMs: { PUBLIC: 500, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 1000 },
      },
    ]),
    original = structuredClone(input);
  const html = renderToStaticMarkup(<TimelineBands data={input} fromMs={1000} toMs={3000} />);
  expect(html).toMatch(/class="status-band status-band-unknown"[^>]+style="left:0%;width:25%/);
  expect(html).toMatch(/class="status-band status-band-public"[^>]+style="left:25%;width:25%/);
  expect(html).toMatch(/status-band-public" aria-label="[^"]+ · 公开直播 1秒" style=/);
  expect(html).not.toContain('title=');
  expect(input).toEqual(original);
});
