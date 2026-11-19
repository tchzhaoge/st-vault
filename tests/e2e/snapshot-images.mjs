import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { unitPacket, unitRequest, unitId } from './support/snapshot-units.mjs';

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver;
    const observers = new Map();
    // Model transient visibility notifications during a grid layout transition.
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        super(callback, options);
        this.notify = callback;
      }
      observe(target) {
        super.observe(target);
        if (target.matches('.minute-image')) observers.set(this, target);
      }
      disconnect() {
        observers.delete(this);
        super.disconnect();
      }
    };
    window.__snapshotVisibility = (isIntersecting) => {
      for (const [observer, target] of observers)
        observer.notify([{ target, isIntersecting }], observer);
    };
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.locator('.snapshot-cell img').first().waitFor();
  const images = () =>
    page
      .locator('.snapshot-cell')
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((node) => [node.dataset.key, node.querySelector('img')?.src ?? null]),
        ),
      );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.snapshot-cell')].every((node) => node.querySelector('img')),
  );
  const before = await images();
  await page.evaluate(() => window.__snapshotVisibility(false));
  await page.waitForTimeout(100);
  assert.deepEqual(
    await images(),
    before,
    'A layout visibility change must not blank mounted decoded screenshots',
  );
  await page.evaluate(() => window.__snapshotVisibility(true));
  await page.waitForTimeout(100);
  assert.deepEqual(
    await images(),
    before,
    'Visibility recovery must not recreate existing image URLs',
  );
  const window = await page.locator('.viewer-focus').evaluate((node) => ({
    from: Number(node.dataset.from),
    to: Number(node.dataset.to),
  }));
  const template = await (
    await page.request.get(
      new URL(
        `/api/subjects/${encodeURIComponent(fixture.info.subjectId)}/snapshot-pages?at=${window.to}&from=${window.from}&to=${window.to}`,
        page.url(),
      ).href,
    )
  ).json();
  const first = template.items[0];
  const existing = template.items;
  const at = existing[0].slotFromMs - 60000;
  const addition = {
    ...first,
    unitId: unitId(999999),
    atMs: at,
    slotFromMs: at,
    slotToMs: at + 60000,
    url: `/api/subjects/${encodeURIComponent(fixture.info.subjectId)}/snapshots/${at}.jpg?to=${at + 86460000}&unit=${unitId(999999)}`,
  };
  const jpeg = Buffer.from(
    await page
      .locator('.snapshot-cell img')
      .first()
      .evaluate(async (img) => [...new Uint8Array(await (await fetch(img.src)).arrayBuffer())]),
  );
  let downloads = 0;
  await page.route(`**/snapshots/${at}.jpg?*`, async (route) => {
    if (++downloads === 1) await route.abort('connectionfailed');
    else await route.fulfill({ contentType: 'image/jpeg', body: jpeg });
  });
  await page.route('**/snapshot-pages?*', (route) => {
    const { range, options } = unitRequest(route);
    return route.fulfill({ json: unitPacket(template, [addition, ...existing], range, options) });
  });
  await page.evaluate(() => {
    window.__lostDecodedImages = 0;
    for (const img of document.querySelectorAll('.snapshot-cell img'))
      img.dataset.retained = 'true';
    window.__imageMutations = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node.nodeName === 'IMG' && node.dataset.retained === 'true')
            window.__lostDecodedImages++;
    });
    window.__imageMutations.observe(document.querySelector('.snapshot-grid'), {
      childList: true,
      subtree: true,
    });
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] }));
  });
  await page.locator(`.snapshot-cell[data-at="${at}"] img`).waitFor({ timeout: 15000 });
  const after = await images();
  for (const [at, url] of Object.entries(before)) assert.equal(after[at], url);
  assert.equal(downloads, 2, 'Only the new image retries after its failed download');
  assert.equal(await page.evaluate(() => window.__lostDecodedImages), 0);
  await page.evaluate(() => window.__imageMutations.disconnect());
  console.log(
    '[qa] Decoded screenshot retention, additions, failed new-image retry and unchanged image URLs passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
