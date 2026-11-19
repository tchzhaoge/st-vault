import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SelectionSummary } from './SelectionSummary';
it('shows the selected wall-clock interval including recording gaps', () => {
  const html = renderToStaticMarkup(<SelectionSummary range={{ fromMs: 1000, toMs: 3692000 }} />);
  expect(html).toContain('1小时1分钟31秒');
  expect(html).toContain('所选跨度');
  expect(html).toContain('selection-bridge');
});
it.each([
  [1800, '30分钟'],
  [3600, '1小时'],
  [3660, '1小时1分钟'],
  [3601, '1小时1秒'],
  [61, '1分钟1秒'],
  [45, '45秒'],
  [60.1, '1分钟'],
  [60.9, '1分钟1秒'],
])('formats a %i second span without zero units', (seconds, text) => {
  const html = renderToStaticMarkup(
    <SelectionSummary range={{ fromMs: 1000, toMs: 1000 + seconds * 1000 }} />,
  );
  expect(html).toContain(`>${text}</output>`);
});
it('shows seconds without milliseconds at both ends, including cross-day ranges', () => {
  const fromMs = Date.UTC(2026, 10, 5, 15, 59, 58, 123),
    toMs = Date.UTC(2026, 10, 5, 16, 1, 1, 456);
  const html = renderToStaticMarkup(<SelectionSummary range={{ fromMs, toMs }} />);
  expect(html).toContain('23:59:58');
  expect(html).toContain('00:01:01');
  expect(html).not.toContain('23:59:58.123');
  expect(html).not.toContain('00:01:01.456');
  expect(html).toContain('selection-date');
});
it('reserves its slot without idle text and keeps subsecond selections visible', () => {
  expect(renderToStaticMarkup(<SelectionSummary range={null} />)).toContain('aria-hidden="true"');
  expect(renderToStaticMarkup(<SelectionSummary range={{ fromMs: 1000, toMs: 1100 }} />)).toContain(
    '1秒',
  );
});
