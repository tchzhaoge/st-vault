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
  let firstOpen = true;
  await page.route('**/api/subjects/*/live', async (route) => {
    if (firstOpen && route.request().method() === 'POST') {
      firstOpen = false;
      await route.fulfill({ status: 503, json: { error: 'live_unavailable', reason: 'source' } });
    } else await route.continue();
  });
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  await row.locator('.subject-preview').click();
  await page.getByRole('button', { name: '更换 CDN', exact: true }).click();
  const panel = page.locator('.routing-cdn');
  await panel
    .locator('.routing-item[aria-pressed="true"]')
    .filter({ hasText: 'doppiocdn.net' })
    .waitFor();
  await panel.getByRole('button', { name: '重新测速', exact: true }).click();
  await panel
    .getByText(/MB\/s|GB\/s/)
    .first()
    .waitFor();
  await panel.getByRole('button', { name: '重新测速', exact: true }).waitFor();
  await panel
    .locator('.routing-item[aria-pressed="true"]')
    .filter({ hasText: 'doppiocdn.net' })
    .waitFor();
  const retry = page.waitForResponse(
    (response) => response.url().endsWith('/live') && response.request().method() === 'POST',
  );
  await panel.locator('.routing-item').filter({ hasText: 'doppiocdn.org' }).click();
  assert.equal((await retry).status(), 200);
  assert.equal(
    (await (await page.request.get(new URL('/api/network/routes', page.url()).href)).json())
      .preferences.cdnHost,
    'edge-hls.doppiocdn.org',
  );
  console.log(
    '[qa] A manual CDN test leaves the preference unchanged. Selecting a node retries failed playback.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
