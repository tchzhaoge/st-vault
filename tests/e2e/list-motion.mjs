import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  let order;
  let removed = new Set();
  await page.route('**/api/workbench?**', async (route) => {
    const response = await route.fetch();
    const packet = await response.json();
    for (const { coverage } of packet.rows)
      coverage.buckets = [
        {
          fromMs: coverage.fromMs,
          toMs: coverage.toMs,
          coveredMs: coverage.toMs - coverage.fromMs,
          segmentCount: 1,
        },
      ];
    await route.fulfill({ response, json: packet });
  });
  await page.route('**/api/subjects', async (route) => {
    const response = await route.fetch();
    const records = await response.json();
    order ??= records.map((record) => record.id);
    await route.fulfill({
      response,
      json: records.map((record) => ({
        ...record,
        providerStatus: 'OFFLINE',
        archived: removed.has(record.id),
        lastRecordedAtMs: 1000000000 - order.indexOf(record.id),
      })),
    });
  });
  const refresh = () =>
    page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
    );
  const freeze = () =>
    page.waitForFunction(() => {
      if (!document.querySelector('[data-row-motion="true"]')) return false;
      for (const animation of document.getAnimations())
        if (animation.id.startsWith('directory-')) animation.pause();
      return true;
    });
  const finish = async () => {
    await page.evaluate(() => {
      for (const animation of document.getAnimations())
        if (animation.id.startsWith('directory-')) animation.finish();
    });
    await page.waitForFunction(() => !document.querySelector('[data-row-motion="true"]'));
  };
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.getByRole('button', { name: '离线', exact: true }).click();
  await page.locator('.track-row').first().waitFor();
  await page.locator('.track-row svg.track-clip').first().waitFor();
  await page.locator('.track-row .subject-preview').first().click();
  await page.waitForTimeout(450);
  const scroller = page.locator('.track-table-scroll');
  const first = order.shift();
  order.splice(25, 0, first);
  await refresh();
  await freeze();
  const motion = await page.evaluate(() => ({
    ghosts: document.querySelectorAll('.track-row-motion-ghost').length,
    mounted: document.querySelectorAll('.track-row').length,
    height: document.querySelector('.track-table-scroll').clientHeight,
    flights: document
      .getAnimations()
      .filter((a) => a.id === 'directory-row')
      .map((a) => ({
        frames: a.effect.getKeyframes().map((f) => f.translate),
      })),
  }));
  assert.equal(motion.ghosts, 1);
  assert.ok(motion.mounted < 25);
  assert.ok(motion.flights.length <= Math.ceil(motion.height / 116) + 2);
  assert.equal(await page.locator(`.track-row[data-subject-id="${first}"]`).count(), 0);
  assert.equal(await scroller.evaluate((node) => node.scrollTop), 0);
  await page.evaluate(() => {
    for (const a of document.getAnimations())
      if (a.id.startsWith('directory-')) a.currentTime = 120;
  });
  await page.screenshot({ path: '.local/qa/list-motion.png' });
  await finish();
  assert.equal(await page.locator('.track-row').first().getAttribute('data-subject-id'), order[0]);
  assert.equal(await page.locator('.track-row-motion-ghost').count(), 0);

  // A second reorder starts from the moving pixels, not an obsolete row index.
  order.splice(25, 1);
  order.splice(2, 0, first);
  await refresh();
  await freeze();
  assert.ok(
    await page.evaluate(() => {
      const ids = [...document.querySelectorAll('linearGradient[id]')].map((node) => node.id);
      return new Set(ids).size === ids.length;
    }),
  );
  await page.evaluate(() => {
    for (const a of document.getAnimations())
      if (a.id.startsWith('directory-')) a.currentTime = 120;
  });
  assert.ok(
    await page.evaluate(() => {
      const row = document.querySelector('.track-row.selected')?.getBoundingClientRect();
      const selection = document.querySelector('.range-selection')?.getBoundingClientRect();
      return !row || Math.abs(row.top - selection.top) < 1;
    }),
  );
  order.splice(2, 1);
  order.splice(25, 0, first);
  await refresh();
  await page.waitForFunction(
    (id) => !document.querySelector(`.track-row[data-subject-id="${id}"]`),
    first,
  );
  assert.ok((await page.locator('.track-row-motion-ghost').count()) <= 2);
  // User input immediately takes ownership; scrolling never creates new flights.
  await scroller.hover();
  await page.mouse.wheel(0, 460);
  await page.waitForFunction(() => document.querySelector('.track-table-scroll').scrollTop > 300);
  await page.waitForFunction(() => !document.querySelector('[data-row-motion="true"]'));
  assert.equal(await page.locator('.track-row-motion-ghost').count(), 0);
  await page.waitForTimeout(250);
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  removed = new Set(order.slice(0, 2));
  await refresh();
  await freeze();
  assert.ok((await page.locator('.track-row-motion-ghost').count()) >= 1);
  await finish();
  assert.deepEqual(errors, []);
  console.log(
    '[qa] Viewport-only reorder, bounded exits, gap filling, interruption and scroll ownership passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
