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
    const gate = (event) => {
      if (!event.qaSnapshot) event.stopImmediatePropagation();
    };
    window.addEventListener('stv-clock', gate, true);
    window.addEventListener('stv-display-clock', gate, true);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.locator('.snapshot-cell img').first().waitFor();
  const jpeg = Buffer.from(
    await page
      .locator('.snapshot-cell img')
      .first()
      .evaluate(async (image) =>
        Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())),
      ),
  );
  await page.locator('.focus-playhead').waitFor();
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  let at = await page
    .locator('.focus-lane')
    .evaluate((node) => Math.floor(Number(node.getAttribute('aria-valuenow'))));
  if (at % 60000 < 2000) {
    await page.locator('video[data-media-slot="active"]').evaluate((video) => video.play());
    await page.waitForTimeout(2100);
    await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
    at = await page
      .locator('.focus-lane')
      .evaluate((node) => Math.floor(Number(node.getAttribute('aria-valuenow'))));
  }
  const minute = Math.floor(at / 60000) * 60000;
  const response = await page.request.get(
    new URL(
      `/api/subjects/${encodeURIComponent(fixture.info.subjectId)}/snapshot-pages?at=${fixture.info.archiveStart}&from=${fixture.info.archiveStart}&to=${fixture.info.archiveEnd}`,
      page.url(),
    ).href,
  );
  const template = await response.json();
  const original = template.items[0];
  let items = [
    {
      ...original,
      open: true,
      atMs: minute - 60000,
      slotFromMs: minute - 60000,
      slotToMs: minute - 1000,
    },
  ];
  let metadataTo = minute - 1;
  await page.route('**/snapshot-pages?*', async (route) => {
    const { range, options } = unitRequest(route);
    await route.fulfill({
      json: unitPacket(template, items, { ...range, toMs: metadataTo || range.toMs }, options),
    });
  });
  const pulse = async (to = at + 1) => {
    const received = page.waitForResponse((r) => r.url().includes('/snapshot-pages?'));
    await page.evaluate((at) => {
      const event = new CustomEvent('stv-clock', { detail: at });
      event.qaSnapshot = true;
      window.dispatchEvent(event);
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] }));
    }, to);
    await received;
    await page.waitForTimeout(100);
  };
  await pulse();
  await page.locator('.snapshot-gap--pending[aria-current="time"]').waitFor();
  assert.equal(
    await page.locator('.snapshot-gap--pending').getAttribute('data-slot'),
    '1',
    'A rollover before the metadata heartbeat follows the actual preceding unit',
  );
  await page.evaluate(() => {
    window.__pendingTail = document.querySelector('.snapshot-gap--pending');
  });
  await pulse(at + 2);
  assert(
    await page.evaluate(
      () => window.__pendingTail === document.querySelector('.snapshot-gap--pending'),
    ),
    'Advancing the tail watermark must retain its presentation node',
  );
  assert.equal(
    await page.locator('.snapshot-cell button[aria-current="time"]').count(),
    0,
    'Unarchived live time must not falsely select an older image',
  );
  const next = {
    ...original,
    unitId: unitId(900),
    open: true,
    atMs: minute,
    slotFromMs: minute,
    slotToMs: at - 1000,
    url: `${original.url}&qaTail=1`,
  };
  let imageReady = false;
  await page.route('**/*qaTail=1', (route) =>
    imageReady
      ? route.fulfill({ body: jpeg, contentType: 'image/jpeg' })
      : route.fulfill({ status: 202, headers: { 'retry-after': '1' } }),
  );
  metadataTo = 0;
  items = [{ ...items[0], open: false }, next];
  await pulse();
  const current = page.locator(`.snapshot-cell button[data-key="${next.unitId}"]`);
  await page.waitForFunction(
    (key) =>
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === key,
    next.unitId,
  );
  assert.equal(await page.locator('.snapshot-gap--pending').count(), 0);
  assert.equal(
    await current.locator('img').count(),
    0,
    'Highlight transfers before the new JPEG exists',
  );
  assert.equal(await current.locator('..').getAttribute('data-slot'), '1');
  imageReady = true;
  await current.locator('img').waitFor();
  await page.evaluate(() => {
    window.__liveTailImage = document.querySelector('.snapshot-cell button[aria-current="time"]');
    window.__tailFlickers = 0;
    window.__tailObserver = new MutationObserver(() => {
      if (
        document.querySelector('.snapshot-cell button[aria-current="time"]') !==
        window.__liveTailImage
      )
        window.__tailFlickers++;
    });
    window.__tailObserver.observe(document.querySelector('.snapshot-grid'), {
      subtree: true,
      attributes: true,
      childList: true,
    });
  });
  for (const lag of [900, 700, 500]) {
    items = [items[0], { ...next, slotToMs: at - lag }];
    await pulse();
    assert.equal(await current.getAttribute('aria-current'), 'time');
    assert.equal(await page.locator('.snapshot-gap--pending').count(), 0);
  }
  assert.equal(
    await page.evaluate(() => {
      window.__tailObserver.disconnect();
      return window.__tailFlickers;
    }),
    0,
  );
  console.log(
    '[qa] Live pending handoff, growing-unit highlight retention and stable image ownership passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
