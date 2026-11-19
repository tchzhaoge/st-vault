import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RANGE_STOPS } from '../timeline/range-control';
import { SnapshotGrid } from '../snapshots/SnapshotGrid';
import { TimeRangeControl } from '../timeline/TimeRangeControl';
import { TimelineBands, type TrackData } from '../timeline/TimelineBands';
const noop = (): void => undefined;

it('combines two accessible resize handles and day navigation without separate span buttons', () => {
  const day = Date.UTC(2026, 10, 4, 16);
  for (const duration of RANGE_STOPS) {
    const html = renderToStaticMarkup(
      <TimeRangeControl
        fromMs={day}
        toMs={day + duration}
        timelineStartMs={day + 1234}
        onChange={noop}
        onMove={noop}
      />,
    );
    expect(html).not.toContain('type="range"');
    expect(html.match(/class="time-control-row"/g)).toHaveLength(1);
    expect(html).not.toContain('control-caption');
    expect(html).not.toContain('aria-label="当前视图日期"');
    expect(html).toContain('aria-label="前12小时"');
    expect(html).toContain('aria-label="后12小时"');
    expect(html).not.toContain('day-span-options');
    expect(html).not.toContain('aria-pressed=');
    expect(html.match(/role="slider"/g)).toHaveLength(3);
    expect(html).toContain('view-position-ridges');
    expect(html).toContain('aria-label="视窗起点"');
    expect(html).toContain('aria-label="视窗终点"');
    expect(html).toContain('00:00');
    expect(html).not.toContain('现在');
    expect(html).toMatch(/aria-label="前12小时"[^>]*disabled=""/);
  }
});
it('shows accessible screenshot pagination without empty minute placeholders', () => {
  const html = renderToStaticMarkup(
    <SnapshotGrid
      onDeletion={() => undefined}
      subject={null}
      referenceMs={1920001}
      window={{ fromMs: 120000, toMs: 1920001 }}
      followLive={false}
      navigation={{ id: 0, atMs: null }}
      atMs={null}
      onSeek={noop}
      onSession={noop}
    />,
  );
  expect(html).not.toContain('上一页截图');
  expect(html).not.toContain('下一页截图');
  expect(html).not.toContain('截图页码');
  expect(html).not.toContain('data-unit-index');
  expect(html).not.toContain('minute-empty');
  expect(html).toContain('取消所有喜欢');
  expect(html).toContain('删除所有非喜欢');
  expect(html).not.toContain('snapshot-check');
  expect(html).toContain('snapshot-actions');
});
it('shares status and recording coverage without standalone favorite markers', () => {
  const data: TrackData = {
    coverage: {
      subjectId: 'stripchat:1',
      fromMs: 1000,
      toMs: 2000,
      revision: 1,
      unlocatedCount: 0,
      buckets: [{ fromMs: 1200, toMs: 1600, coveredMs: 400, segmentCount: 1 }],
    },
    bands: [
      {
        fromMs: 1000,
        toMs: 2000,
        status: 'PUBLIC',
        durationsMs: { PUBLIC: 1000, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 0 },
      },
    ],
  };
  const html = renderToStaticMarkup(<TimelineBands data={data} fromMs={1000} toMs={2000} />);
  expect(html).toContain('status-band-public');
  expect(html).toContain('track-clip');
  expect(html).not.toContain('track-watched');
  expect(html).not.toContain('track-favorite-range');
  expect(html).toContain('left:0%');
  expect(html).not.toContain('timeline-filmstrip');
  expect(html).not.toContain('<img');
});
