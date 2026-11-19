import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TimeRangeControl } from './TimeRangeControl';
import { DAY_MS } from './range-control';
import { setLanguage } from '../../shared/lib/i18n';

it.each([
  [0.5, '12小时'],
  [1, '1天'],
  [1.5, '1.5天'],
  [7, '7天'],
])('labels a %s-day window on its slider', (days, label) => {
  const fromMs = Date.UTC(2026, 10, 1);
  const html = renderToStaticMarkup(
    <TimeRangeControl
      fromMs={fromMs}
      toMs={fromMs + Number(days) * DAY_MS}
      timelineStartMs={fromMs - 30 * DAY_MS}
      nowMs={fromMs + 10 * DAY_MS}
      onMove={() => undefined}
      onChange={() => undefined}
    />,
  );
  expect(html).toContain(`<span class="view-position-span">${label}</span>`);
});
it('uses compact English units on the same slider', async () => {
  try {
    await setLanguage('en');
    const fromMs = Date.UTC(2026, 10, 1);
    const html = renderToStaticMarkup(
      <TimeRangeControl
        fromMs={fromMs}
        toMs={fromMs + DAY_MS / 2}
        timelineStartMs={fromMs - 30 * DAY_MS}
        nowMs={fromMs + 10 * DAY_MS}
        onMove={() => undefined}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('<span class="view-position-span">12h</span>');
  } finally {
    await setLanguage('zh-CN');
  }
});

it('uses the exact fractional-day rail extent and disables navigation beyond morning noon', () => {
  const today = Date.UTC(2026, 10, 4, 16);
  const html = renderToStaticMarkup(
    <TimeRangeControl
      fromMs={today}
      toMs={today + DAY_MS / 2}
      timelineStartMs={today - DAY_MS}
      nowMs={today + 3600000}
      onMove={() => undefined}
      onChange={() => undefined}
    />,
  );
  expect(html).toContain('aria-label="后12小时" disabled=""');
  expect(html).toContain('33.33333333333333%');
  expect(html.match(/class="view-position-ridges"/g)).toHaveLength(2);
  expect(html).toContain(
    'left:calc((100% - max(var(--view-window-min-width), 33.33333333333333%)) * 1)',
  );
});
