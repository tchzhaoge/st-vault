import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15000);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row').first().waitFor();
  const open = () => page.locator('.account-tool .tool-trigger').click();
  const panel = page.locator('.toolbar-popover');
  const secret = 'session=synthetic-account-panel';
  await open();
  assert.equal(await panel.locator('.account-profile').count(), 0);
  await page.getByLabel('Cookies', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '连接并同步', exact: true }).click();
  await page.getByRole('button', { name: '更换 Cookies', exact: true }).waitFor();
  assert.equal(await panel.locator('textarea').count(), 0);
  await page.getByRole('button', { name: '更换 Cookies', exact: true }).click();
  await page.getByLabel('更新 Cookies', { exact: true }).fill('session=unused-draft');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await panel.locator('textarea').count(), 0);
  // A reload proves disconnect restores committed server credentials, not a cached submission.
  await page.reload();
  await page.locator('.track-row').first().waitFor();
  await open();
  await page.getByRole('button', { name: '断开', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/work/.local/qa/account-confirm.png' });
  assert.match(await dialog.innerText(), /停止所有主播录制/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await panel.count(), 1);
  await page.getByRole('button', { name: '断开', exact: true }).click();
  await dialog.getByRole('button', { name: '确认断开', exact: true }).click();
  const input = page.getByLabel('Cookies', { exact: true });
  await input.waitFor();
  assert.equal(await input.inputValue(), secret);
  const status = await page.evaluate(async () => (await fetch('/api/account-sync')).json());
  assert.equal(status.connected, false);
  assert.ok(!JSON.stringify(status).includes(secret));
  await page.reload();
  await open();
  await input.waitFor();
  assert.equal(await input.inputValue(), secret);
  const rows = await page.evaluate(async () => (await fetch('/api/subjects')).json());
  assert.ok(rows.every((row) => row.archived && !row.autoRecord));
  await panel.locator('.routing-item:not([aria-pressed="true"]):enabled').first().click();
  assert.equal(await input.inputValue(), '');
  await page.reload();
  await open();
  await input.waitFor();
  assert.equal(await input.inputValue(), '');
  await input.fill(secret);
  await input.fill('');
  assert.ok(await page.getByRole('button', { name: '连接并同步', exact: true }).isDisabled());
  await page.reload();
  await open();
  await input.waitFor();
  assert.equal(await input.inputValue(), '');
  await input.fill(secret);
  await page.getByRole('button', { name: '连接并同步', exact: true }).click();
  await page.getByRole('button', { name: '更换 Cookies', exact: true }).waitFor();
  assert.match(
    await page.getByRole('button', { name: '归档', exact: true }).getAttribute('title'),
    /临时网络或状态异常不会直接归档/,
  );
  await page.evaluate(() => localStorage.setItem('stv-language', 'en'));
  await page.reload();
  await page.locator('.track-row').first().waitFor();
  await open();
  await page.getByRole('button', { name: 'Replace cookies', exact: true }).waitFor();
  await page.waitForTimeout(350);
  const controls = await panel.locator('.panel-actions button').evaluateAll((buttons) =>
    buttons.map((button) => ({
      y: button.getBoundingClientRect().y,
      fits: button.scrollWidth <= button.clientWidth,
    })),
  );
  assert.equal(new Set(controls.map((button) => Math.round(button.y))).size, 1);
  assert.ok(controls.every((button) => button.fits));
  await page.screenshot({ path: '/work/.local/qa/account-connected-en.png' });
  console.log(
    '[qa] Account editor disclosure, confirmation/cancel, committed-cookie draft, manual clearing and reconnect passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
