import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '全部主播是否录制', exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  await page.waitForFunction(
    () =>
      document.querySelector('.global-recording-settings button')?.getAttribute('aria-checked') ===
        'true' && !document.querySelector('.global-recording-settings button').disabled,
  );
  const added = await page.evaluate(async () => {
    const response = await fetch('/api/subjects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 10001, handle: 'NewModel' }),
    });
    return response.json();
  });
  assert.equal(added.autoRecord, true);
  await page.evaluate(async () => {
    await fetch('/api/subjects/stripchat%3A10001/policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoRecord: false }),
    });
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects', 'system'] }));
  });
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await toggle.click();
  await page.waitForFunction(
    () =>
      document.querySelector('.global-recording-settings button')?.getAttribute('aria-checked') ===
        'false' && !document.querySelector('.global-recording-settings button').disabled,
  );
  const rows = await page.evaluate(async () => (await fetch('/api/subjects')).json());
  assert.ok(rows.every((row) => !row.autoRecord));
  assert.deepEqual(errors, []);
  console.log(
    '[qa] Global recording default, new membership, individual exception and reload passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
