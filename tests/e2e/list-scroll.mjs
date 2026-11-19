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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.route('**/api/workbench?**', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const packet = await response.json();
    for (const { coverage } of packet.rows) {
      const step = (coverage.toMs - coverage.fromMs) / 720;
      coverage.buckets = Array.from({ length: 720 }, (_, index) => ({
        fromMs: coverage.fromMs + index * step,
        toMs: coverage.fromMs + (index + 0.8) * step,
        coveredMs: step * (index % 2 ? 0.3 : 0.7),
        segmentCount: 1,
      }));
    }
    return route.fulfill({ response, json: packet });
  });
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row svg.track-clip path').first().waitFor();
  const scroller = page.locator('.track-table-scroll');
  const target = 1537;
  await scroller.evaluate(async (node, top) => {
    for (let i = 1; i <= 90; i++) {
      node.scrollTop = (top * i) / 90;
      await new Promise(requestAnimationFrame);
    }
  }, target);
  // A later heartbeat/render must not restore an obsolete row-quantized pixel offset.
  await page.waitForTimeout(5500);
  assert.equal(await scroller.evaluate((node) => node.scrollTop), target);
  const rows = await page.locator('.track-row').evaluateAll((nodes) =>
    nodes.map((node) => ({
      height: node.getBoundingClientRect().height,
      surfaces: node.querySelectorAll('svg.track-clip').length,
      paths: node.querySelectorAll('svg.track-clip path').length,
    })),
  );
  assert.ok(rows.length > 0 && rows.length < 25, 'Only the visible neighborhood mounts');
  assert.ok(rows.every((row) => row.height === 116 && row.surfaces <= 1 && row.paths <= 15));
  assert.ok(
    rows.some((row) => row.paths > 0),
    'Scrolling retains loaded coverage',
  );
  await page.reload();
  await page.waitForFunction(
    (top) => document.querySelector('.track-table-scroll')?.scrollTop === top,
    target,
  );
  // An offline broadcaster losing its latest recording moves down the sort,
  // but the viewport must stay with the neighboring rows, not follow that ID.
  let movedId = null;
  await page.route('**/api/subjects', async (route) => {
    const response = await route.fetch();
    const subjects = await response.json();
    return route.fulfill({
      response,
      json: subjects.map((subject, index) => ({
        ...subject,
        providerStatus: 'OFFLINE',
        archived: false,
        lastRecordedAtMs: subject.id === movedId ? null : 1000000 - index,
      })),
    });
  });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
  );
  await page.getByRole('button', { name: '离线', exact: true }).click();
  await scroller.evaluate((node, top) => {
    node.scrollTop = top;
  }, target);
  await page.waitForTimeout(300);
  movedId = await scroller.evaluate((node) => {
    const top = node.getBoundingClientRect().top + 1;
    return [...node.querySelectorAll('.track-row')]
      .find((row) => {
        const box = row.getBoundingClientRect();
        return box.top <= top && box.bottom > top;
      })
      ?.getAttribute('data-subject-id');
  });
  assert.ok(movedId);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
  );
  await page.locator(`.track-row[data-subject-id="${movedId}"]`).waitFor({ state: 'detached' });
  assert.equal(await scroller.evaluate((node) => node.scrollTop), target);
  assert.deepEqual(errors, []);
  await page.unrouteAll({ behavior: 'wait' });
  console.log(
    '[qa] Dense coverage stays bounded; native scroll, heartbeat and reload retain the exact position',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
