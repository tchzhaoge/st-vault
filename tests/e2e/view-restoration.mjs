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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row').first().waitFor();
  const readView = () =>
    page
      .locator('.track-lane')
      .first()
      .evaluate((node) => ({
        fromMs: Number(node.dataset.from),
        toMs: Number(node.dataset.to),
      }));
  const initial = await readView();
  await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowRight');
  const afternoon = { fromMs: initial.fromMs + 12 * 3600000, toMs: initial.toMs };
  assert.deepEqual(await readView(), afternoon);
  await page.waitForFunction(({ fromMs, toMs }) => {
    const key = Object.keys(localStorage).find((key) => key.endsWith(':view'));
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    return saved?.durationMs === toMs - fromMs && saved?.viewToMs === toMs;
  }, afternoon);
  await page.reload();
  await page.locator('.track-row').first().waitFor();
  assert.deepEqual(
    await readView(),
    afternoon,
    'Reload must retain today PM instead of using the default day span',
  );
  await page.waitForTimeout(350);
  assert.deepEqual(
    await readView(),
    afternoon,
    'The display clock must not overwrite the restored view',
  );
  // Change both span and position, then reload before the debounced save.
  await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  await page.getByRole('button', { name: '前12小时', exact: true }).click();
  const historical = await readView();
  assert.equal(historical.toMs - historical.fromMs, 36 * 3600000);
  await page.reload();
  await page.locator('.track-row').first().waitFor();
  assert.deepEqual(
    await readView(),
    historical,
    'Pagehide must preserve half-day position and odd half-day spans',
  );
  console.log(
    '[qa] Afternoon restoration, display-clock stability and immediate historical reload passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
