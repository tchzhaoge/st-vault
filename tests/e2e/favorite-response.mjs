import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
let release;
let arrived;
const nextWrite = () => new Promise((resolve) => (arrived = resolve));
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
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  const heart = page.locator('.snapshot-favorite').first();
  const nextHeart = page.locator('.snapshot-favorite').nth(1);
  await page.waitForFunction(() => {
    const button = document.querySelector('.snapshot-favorite');
    return button && !button.disabled;
  });
  assert.equal(await heart.getAttribute('aria-pressed'), 'false');
  let reads = 0;
  let writes = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/unit-favorites/query')) reads++;
  });
  let reject = false;
  await page.route('**/unit-favorites', async (route) => {
    writes++;
    await new Promise((resolve) => {
      release = resolve;
      arrived();
    });
    if (reject) await route.fulfill({ status: 409, json: { error: 'media_selection_stale' } });
    else await route.continue();
  });
  const waitVisual = (liked, busy) =>
    page.waitForFunction(
      ({ liked, busy }) => {
        const button = document.querySelector('.snapshot-favorite');
        return (
          button?.getAttribute('aria-pressed') === String(liked) &&
          (button.getAttribute('aria-busy') === 'true') === busy &&
          (busy || !button.disabled)
        );
      },
      { liked, busy },
    );
  const noOverlay = async () => assert.equal(await page.locator('.snapshot-feedback').count(), 0);
  const firstWrite = nextWrite();
  await heart.click();
  await waitVisual(true, true);
  await firstWrite;
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'true',
  );
  assert.equal(reads, 0, 'known page facts must skip the preparatory query');
  assert.equal(await nextHeart.isEnabled(), true, 'another heart must remain clickable');
  await nextHeart.click();
  assert.equal(await nextHeart.getAttribute('aria-pressed'), 'true');
  assert.equal(await nextHeart.getAttribute('aria-busy'), 'true');
  assert.equal(writes, 1, 'queued writes must wait for the committed revision');
  await noOverlay();
  const committed = page.waitForResponse(
    (response) => response.url().endsWith('/unit-favorites') && response.ok(),
  );
  const queuedWrite = nextWrite();
  release();
  await committed;
  await waitVisual(true, false);
  await queuedWrite;
  const queuedCommitted = page.waitForResponse(
    (response) => response.url().endsWith('/unit-favorites') && response.ok(),
  );
  release();
  await queuedCommitted;
  await page.waitForFunction(
    () => document.querySelectorAll('.snapshot-favorite')[1]?.getAttribute('aria-busy') !== 'true',
  );
  assert.equal(await nextHeart.getAttribute('aria-pressed'), 'true');

  // A rejected optimistic unlike returns to the persisted heart without replaying a write.
  reject = true;
  const secondWrite = nextWrite();
  await heart.click();
  await waitVisual(false, true);
  await secondWrite;
  release();
  await waitVisual(true, false);
  const notice = page.locator('.snapshot-pages .snapshot-operation-status');
  await notice.waitFor();
  assert.equal(await notice.locator('[title]').count(), 0);
  const [statusBox, gridBox] = await Promise.all([
    notice.boundingBox(),
    page.locator('.snapshot-viewport').boundingBox(),
  ]);
  assert.ok(statusBox.y + statusBox.height <= gridBox.y + 1, 'status belongs above images');
  assert.equal(writes, 3, 'a stale write must not be retried automatically');
  await noOverlay();

  reject = false;
  const thirdWrite = nextWrite();
  await heart.click();
  await waitVisual(false, true);
  await thirdWrite;
  release();
  await waitVisual(false, false);
  assert.equal(await page.locator('.snapshot-operation-status').count(), 0, 'no success notice');
  await page.reload();
  await waitVisual(false, false);
  await noOverlay();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      immediateHeart: true,
      rapidDifferentHearts: true,
      redundantRead: false,
      rollback: true,
      persisted: true,
      overlay: false,
    }),
  );
} finally {
  release?.();
  await browser?.close();
  await fixture.close();
}
