import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  RoutingOptions,
  routeMeasurement,
  routeTone,
  sortRoutes,
  routeSelectable,
  routeProbeLabel,
} from './RoutingOptions';
it('shows explicit current-round progress for manual measurements', () => {
  expect(routeProbeLabel({ completed: 0, total: 4 })).toBe('测速中… 0/4');
  expect(routeProbeLabel({ completed: 2, total: 34 })).toBe('测速中… 2/34');
});

it('grades HTTP latency at exact boundaries while keeping slow routes selectable', () => {
  const item = { checkedAtMs: 1, latencyMs: 1000 };
  expect(routeTone(item)).toBe('good');
  expect(routeTone({ ...item, latencyMs: 1001 })).toBe('fair');
  expect(routeTone({ ...item, latencyMs: 2500 })).toBe('fair');
  expect(routeTone({ ...item, latencyMs: 2501 })).toBe('poor');
  expect(routeSelectable({ ...item, latencyMs: 3000 })).toBe(true);
  expect(routeSelectable({ ...item, error: 'timeout' })).toBe(false);
  expect(routeTone({ ...item, testing: true })).toBe('pending');
  expect(routeTone({ ...item, error: 'timeout' })).toBe('unavailable');
});
it('sorts measured routes progressively with stable ties and failures last without mutating input', () => {
  const input = [
    { key: 'z', checkedAtMs: 1, latencyMs: 500 },
    { key: 'unknown', checkedAtMs: 0, latencyMs: null },
    { key: 'failed', checkedAtMs: 1, latencyMs: 10, error: 'timeout' },
    { key: 'a', checkedAtMs: 1, latencyMs: 500 },
    { key: 'fast', checkedAtMs: 1, latencyMs: 200 },
  ];
  expect(sortRoutes(input).map((item) => item.key)).toEqual([
    'fast',
    'a',
    'z',
    'unknown',
    'failed',
  ]);
  expect(input[0].key).toBe('z');
  expect(
    sortRoutes(
      input.map((item) =>
        item.key === 'unknown' ? { ...item, checkedAtMs: 2, latencyMs: 100 } : item,
      ),
    )[0].key,
  ).toBe('unknown');
});

it('keeps unknown, failed and in-flight measurements distinct from valid latency', () => {
  const item = { checkedAtMs: 0, latencyMs: null };
  expect(routeMeasurement(item)).toBe('未测速');
  expect(routeMeasurement({ ...item, testing: true })).toBe('测速中…');
  expect(routeMeasurement({ ...item, error: 'timeout' })).toBe('不可用');
  expect(routeMeasurement({ latencyMs: 152 })).toBe('152 ms');
});
it('grades CDN samples in relation to video bitrate and ranks actual download speed', () => {
  const route = { bytesPerSecond: 200_000, bitrate: 800_000 };
  expect(routeTone(route)).toBe('good');
  expect(routeTone({ ...route, bytesPerSecond: 100_000 })).toBe('fair');
  expect(routeTone({ ...route, bytesPerSecond: 99_999 })).toBe('poor');
  expect(routeMeasurement(route)).toBe('0.20 MB/s');
  expect(
    sortRoutes([
      { key: 'a', ...route },
      { key: 'b', ...route, bytesPerSecond: 300_000 },
    ])[0].key,
  ).toBe('b');
});
it('provides manual measurements and selection for both panels', () => {
  const site = renderToStaticMarkup(<RoutingOptions kind="sites" />);
  const cdn = renderToStaticMarkup(<RoutingOptions kind="cdn" />);
  expect(site).not.toContain('选择模式');
  expect(site).toContain('接入点清单');
  expect(cdn).toContain('HLS CDN 清单');
  expect(cdn).toContain('重新测速');
  expect(cdn).not.toContain('选择模式');
  expect(cdn).not.toContain('选中在线主播后可测试视频链路。');
  expect(site).not.toContain('routing-current');
  expect(cdn).not.toContain('routing-current');
});
