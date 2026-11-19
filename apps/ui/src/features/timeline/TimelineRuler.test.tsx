import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { TimelineRuler } from './TimelineRuler';
import { DAY_MS } from './range-control';
import { setLanguage } from '../../shared/lib/i18n';
afterEach(async () => {
  await setLanguage('zh-CN');
});
it('labels half-day ends of a multi-day view without labelling the complete middle day', () => {
  const day = Date.UTC(2026, 10, 4, 16);
  const html = renderToStaticMarkup(
    <TimelineRuler fromMs={day + DAY_MS / 2} toMs={day + 2.5 * DAY_MS} nowMs={day + DAY_MS} />,
  );
  expect(html).toContain('昨天 下午');
  expect(html).toContain('2026-11-07 上午');
  expect(html).not.toContain('今天 上午');
  expect(html).not.toContain('今天 下午');
});
it.each(['am', 'pm'] as const)('labels a twelve-hour %s view in English', async (half) => {
  await setLanguage('en');
  const day = Date.UTC(2026, 10, 4, 16),
    from = day + (half === 'pm' ? DAY_MS / 2 : 0);
  const html = renderToStaticMarkup(
    <TimelineRuler fromMs={from} toMs={from + DAY_MS / 2} nowMs={day} />,
  );
  expect(html).toContain(half === 'am' ? 'Today AM' : 'Today PM');
});
it('renders centered date captions separately from time labels and division lines', () => {
  const from = Date.UTC(2026, 10, 4, 16);
  const html = renderToStaticMarkup(
    <TimelineRuler fromMs={from} toMs={from + 2 * DAY_MS} nowMs={from + DAY_MS} />,
  );
  expect(html).toMatch(/class="ruler-date"[^>]*style="left:25%;max-width:50%"/);
  expect(html).toMatch(/class="ruler-date"[^>]*style="left:75%;max-width:50%"/);
  expect(html).toContain('昨天');
  expect(html).toContain('今天');
  for (const level of ['day', 'half-day', 'hour'])
    expect(html).toContain(`ruler-division division-${level}`);
  expect(html).toContain('class="ruler-hour"');
});

it.each([
  ['day', 'half-day', 0],
  ['half-day', 'day', DAY_MS / 2],
] as const)(
  'uses actual %s / %s calendar divisions at viewport ends without fixed borders',
  (start, end, offset) => {
    const from = Date.UTC(2026, 10, 4, 16) + offset;
    const html = renderToStaticMarkup(<TimelineRuler fromMs={from} toMs={from + DAY_MS / 2} />);
    expect(html).not.toContain('ruler-boundary');
    expect(html).toContain(`class="ruler-division division-${start}" data-window-edge="start"`);
    expect(html).toContain(`class="ruler-division division-${end}" data-window-edge="end"`);
  },
);
