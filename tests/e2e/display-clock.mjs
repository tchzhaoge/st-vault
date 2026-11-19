import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    const NativeSource = window.EventSource;
    const base = Math.floor(Date.now() / 60000) * 60000 + 10000,
      start = performance.now();
    window.__clockCounts = { display: 0, data: 0 };
    window.addEventListener('stv-display-clock', () => window.__clockCounts.display++);
    window.addEventListener('stv-clock', () => window.__clockCounts.data++);
    window.EventSource = class extends EventTarget {
      constructor(url) {
        super();
        if (url !== '/api/sync') return new NativeSource(url);
        queueMicrotask(() => {
          this.onopen?.();
          this.dispatchEvent(
            new MessageEvent('clock', {
              data: JSON.stringify({ atMs: base + performance.now() - start, intervalMs: 30000 }),
            }),
          );
        });
      }
      close() {}
    };
  });
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row').first().waitFor();
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  await page.locator('.selection-summary time').first().waitFor({ state: 'attached' });
  await page.waitForTimeout(1200);
  let queries = 0;
  const reads = [];
  const count = (request) => {
    if (/\/api\/(workbench|events\/runs|me\/favorites)|\/snapshot-pages\?/.test(request.url())) {
      queries++;
      reads.push(request.url());
    }
  };
  page.on('request', count);
  const read = () =>
    page.evaluate(() => ({
      now: Number(document.querySelector('.live-now-line').dataset.at),
      end: Date.parse(document.querySelector('.selection-summary time:last-child').dateTime),
      windows: ['.range-selection', '.viewer-focus', '.snapshot-section'].map((selector) => {
        const node = document.querySelector(selector);
        return { from: Number(node.dataset.from), to: Number(node.dataset.to) };
      }),
      counts: { ...window.__clockCounts },
    }));
  const before = await read();
  await page.waitForTimeout(3200);
  const after = await read();
  assert(after.now - before.now >= 2000);
  assert.deepEqual(after.windows[0], after.windows[1]);
  assert.deepEqual(after.windows[0], after.windows[2]);
  assert.equal(after.windows[0].to, after.now);
  assert.equal(
    after.now,
    after.end,
    'Timeline and player endpoints must share one display timestamp',
  );
  assert(after.counts.display - before.counts.display >= 3);
  assert.equal(
    after.counts.data,
    before.counts.data,
    'Display ticks must not publish data heartbeats',
  );
  console.log(JSON.stringify({ reads }));
  assert.equal(
    queries,
    0,
    'Display seconds must not trigger timeline, snapshot or favorite requests',
  );
  page.off('request', count);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await read();
  await page.waitForTimeout(1200);
  assert.equal((await read()).counts.display, hidden.counts.display);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(
    (at) => Number(document.querySelector('.live-now-line').dataset.at) > at + 1000,
    hidden.now,
  );
  console.log(
    JSON.stringify({
      elapsedMs: after.now - before.now,
      displayTicks: after.counts.display - before.counts.display,
      extraDataQueries: queries,
      resumesImmediately: true,
    }),
  );
} finally {
  await browser?.close();
  await fixture.close();
}
