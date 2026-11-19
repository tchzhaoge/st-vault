import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser, releaseSubmit;
const submitGate = new Promise((resolve) => {
  releaseSubmit = resolve;
});
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [],
    recoveryRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  await row.waitFor();
  const lane = await row.locator('.track-lane').boundingBox();
  await page.mouse.move(lane.x + 1, lane.y + 40);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width - 1, lane.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  await page.locator('.snapshot-cell button[data-unit-index]').first().waitFor();
  const bounds = () =>
    page
      .locator('.viewer-focus')
      .evaluate((node) => [Number(node.dataset.from), Number(node.dataset.to)]);
  const selected = await bounds();
  assert.deepEqual(selected, [fixture.info.archiveStart, fixture.info.archiveEnd]);
  // Unrelated surviving footage must never become a fallback for this empty range.
  await fixture.appendSnapshotUnit(fixture.info.archiveStart - 3600000);
  await page
    .locator('.snapshot-actions')
    .getByRole('button', { name: '删除所有非喜欢', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '删除所有非喜欢', exact: true });
  assert(await dialog.getByRole('button', { name: '确认删除', exact: true }).isEnabled());
  assert(await dialog.getByRole('button', { name: '取消', exact: true }).isEnabled());
  await page.route('**/deletion-intents', async (route) => {
    await submitGate;
    await route.continue();
  });
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/deletion-intents') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  // A locally proven empty range closes immediately, independently of task admission.
  await page.waitForFunction(() => !document.querySelector('video'));
  assert.equal(await page.locator('.range-selection[aria-hidden="false"]').count(), 0);
  await page.getByText('点击主播播放直播，或拖选时间段回放', { exact: true }).waitFor();
  page.on('request', (request) => {
    if (/recording-bounds|\/live$/.test(new URL(request.url()).pathname))
      recoveryRequests.push(request.url());
  });
  releaseSubmit();
  assert.equal((await accepted).status(), 202);
  await page.waitForFunction(() => !document.querySelector('video'));
  assert.equal(await page.locator('.range-selection[aria-hidden="false"]').count(), 0);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-clock', { detail: Date.now() + 90000 })),
  );
  assert.equal(await page.locator('.range-selection[aria-hidden="false"]').count(), 0);
  assert.equal(await page.locator('.snapshot-cell').count(), 0);
  assert.deepEqual(recoveryRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      emptyRangeReturnsToInitialState: true,
      noBoundaryFallback: true,
      preparationVisibleImmediately: true,
      submitDoesNotLockInteraction: true,
      decoderReleased: true,
    }),
  );
} catch (error) {
  console.error('Empty-range browser regression failed', error);
  throw error;
} finally {
  releaseSubmit();
  await browser?.close();
  await fixture.close();
}
