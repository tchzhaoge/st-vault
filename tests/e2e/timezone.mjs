import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

// Server and browser deliberately disagree; the deployment calendar must win.
process.env.TZ = 'America/New_York';
const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Tokyo',
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  assert.equal(
    (await (await page.request.get('http://127.0.0.1:10085/api/session')).json()).timeZone,
    'America/New_York',
  );
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row').first().waitFor();
  const readView = () =>
    page
      .locator('.track-lane')
      .first()
      .evaluate((node) => [Number(node.dataset.from), Number(node.dataset.to)]);
  const initial = await readView();
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const boundary of initial) assert.ok(['00:00', '12:00'].includes(clock.format(boundary)));
  await page.getByRole('button', { name: '前12小时', exact: true }).click();
  const moved = await readView();
  assert.ok(moved[0] < initial[0]);
  await page.reload();
  await page.locator('.track-row').first().waitFor();
  assert.deepEqual(await readView(), moved);
  console.log(
    '[qa] Deployment timezone overrides browser timezone; navigation and reload retain local calendar boundaries',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
