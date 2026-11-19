import assert from 'node:assert/strict';
import { holdPlayerControls } from './support/player-chrome.mjs';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  const history = await fixture.seedSnapshotHistory();
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const protectionReads = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/workbench' && url.searchParams.has('protection'))
      protectionReads.push(url.searchParams.get('protection'));
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  await row.waitFor();
  if (
    history.fromMs <
    (await row.locator('.track-lane').evaluate((node) => Number(node.dataset.from)))
  )
    await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  const lane = await row.locator('.track-lane').boundingBox();
  await page.mouse.move(lane.x + 1, lane.y + 40);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width - 1, lane.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const heart = document.querySelector('.snapshot-favorite');
    return (
      heart &&
      !heart.disabled &&
      Number(document.querySelector('.snapshot-total').textContent.match(/\d+/)?.[0]) > 30
    );
  });
  // Clear favorites across pages without entering a selection mode.
  assert.equal(await page.locator('.snapshot-actions button').count(), 2);
  await page.locator('.snapshot-favorite').first().click();
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'false',
  );
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.snapshot-pages output')?.textContent === '2 / 3' &&
      !document.querySelector('.snapshot-favorite')?.disabled,
  );
  await page.locator('.snapshot-favorite').first().click();
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'false',
  );
  await page.getByRole('button', { name: '取消所有喜欢', exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector('.snapshot-favorite[aria-pressed="true"]') &&
      document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'false',
  );
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.snapshot-pages output')?.textContent === '1 / 3' &&
      !document.querySelector('.snapshot-favorite')?.disabled,
  );
  assert.equal(await page.locator('.snapshot-favorite[aria-pressed="true"]').count(), 0);
  // Preserve a favorite while deleting the entire unliked range across pages.
  await page.locator('.snapshot-favorite').first().click();
  await page.waitForFunction(() => {
    const heart = document.querySelector('.snapshot-favorite');
    return heart?.getAttribute('aria-pressed') === 'true' && !heart.disabled;
  });
  const favoriteId = await page.locator('.snapshot-cell').first().getAttribute('data-key');
  const remove = page
    .locator('.snapshot-actions')
    .getByRole('button', { name: '删除所有非喜欢', exact: true });
  assert(await remove.isEnabled(), 'selection preparation must not hold deletion');
  await remove.click();
  const dialog = page.getByRole('dialog', { name: '删除所有非喜欢', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('ul,[aria-busy]').count(), 0, 'no statistics gate');
  assert.equal(await dialog.evaluate((node) => node.matches(':modal')), false);
  const geometry = await page.evaluate(() => {
    const review = document.querySelector('.media-review').getBoundingClientRect();
    const layer = document.querySelector('.media-delete-layer').getBoundingClientRect();
    const picture = document.querySelector('.player-picture');
    const box = picture.getBoundingClientRect();
    return {
      local:
        Math.abs(layer.left - review.left) < 1 &&
        Math.abs(layer.right - review.right) < 1 &&
        Math.abs(layer.top - review.top) < 1 &&
        Math.abs(layer.bottom - review.bottom) < 1,
      playerUsable: picture.contains(
        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      ),
    };
  });
  assert.deepEqual(geometry, { local: true, playerUsable: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.snapshot-cell').count(), 30);
  await remove.click();
  await dialog.waitFor();
  await holdPlayerControls(page);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  assert.equal(
    await page.locator('.media-delete-layer').evaluate((node) => {
      const review = node.closest('.media-review').getBoundingClientRect();
      const layer = node.getBoundingClientRect();
      const dialog = node.querySelector('dialog').getBoundingClientRect();
      return (
        Math.abs(layer.left - review.left) < 1 &&
        Math.abs(layer.right - review.right) < 1 &&
        dialog.left >= review.left &&
        dialog.right <= review.right
      );
    }),
    true,
    'confirmation follows the fullscreen sidebar',
  );
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/deletion-intents') && response.request().method() === 'POST',
  );
  assert.equal(
    protectionReads.length,
    0,
    'ordinary browsing and opening confirmation never request protection masks',
  );
  // An unavailable optional display mask must not block admission or real favorite protection.
  await page.route('**/api/workbench?*', (route) =>
    new URL(route.request().url()).searchParams.has('protection')
      ? route.abort()
      : route.continue(),
  );
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const receipt = await accepted;
  assert.equal(receipt.status(), 202);
  assert(
    ['range', 'selection'].includes(receipt.request().postDataJSON().target.kind),
    'whole-range commands do not collapse to the visible page',
  );
  await page.waitForFunction((id) => {
    const cells = [...document.querySelectorAll('.snapshot-grid .snapshot-cell')];
    return cells.length === 1 && cells[0].dataset.key === id;
  }, favoriteId);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directRangeActions: true,
      unlikeAcrossPages: true,
      confirmBeforePreparation: true,
      localMask: true,
      fullscreenMask: true,
      cancelPreservesMedia: true,
      entireRange: true,
      favoriteProtected: true,
    }),
  );
} finally {
  await browser?.close();
  await fixture.close();
}
