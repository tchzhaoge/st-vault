import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  const at = fixture.info.archiveStart - 60000;
  await fixture.appendSnapshotUnit(at, 'duplicate-pdt-first');
  // Epoch changes alone intentionally preserve a minute unit. A real PDT
  // rollback after progress creates another unit with the same canonical UTC.
  await fixture.appendSnapshotUnit(at + 1000, 'duplicate-pdt-progress');
  await fixture.appendSnapshotUnit(at, 'duplicate-pdt-second');
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    document.addEventListener(
      'playing',
      (event) => {
        if (event.target instanceof HTMLVideoElement) event.target.pause();
      },
      true,
    );
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  const cards = page.locator(`.snapshot-cell button[data-at="${at}"]`);
  await cards.nth(1).waitFor();
  assert.equal(await cards.count(), 2, 'Two recording units may share their canonical UTC');
  const identities = await cards.evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
  assert.notEqual(identities[0], identities[1]);
  let loaded;
  for (const unitId of identities) {
    await page.evaluate(() => {
      window.__oldIdentityVideo = document.querySelector('video[data-media-slot="active"]');
    });
    const reusing = loaded?.segments.some((segment) => segment.recordingUnitId === unitId);
    const response = reusing
      ? null
      : page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/playback',
        );
    await page.locator(`.snapshot-cell button[data-key="${unitId}"]`).click();
    if (response) {
      const resolved = await response;
      assert.equal(resolved.request().postDataJSON().unitId, unitId);
      assert.equal(resolved.status(), 200);
      loaded = await resolved.json();
    }
    assert(loaded.segments.some((segment) => segment.recordingUnitId === unitId));
    await page.waitForFunction(
      ({ unitId, segments, reusing }) => {
        const video = document.querySelector('video[data-media-slot="active"]');
        let cursor = 0;
        const actual = segments.find((segment) => {
          const start = cursor;
          cursor += segment.durationSeconds;
          return video && video.currentTime >= start && video.currentTime < cursor;
        });
        return (
          (reusing || video !== window.__oldIdentityVideo) &&
          video?.readyState >= 2 &&
          actual?.recordingUnitId === unitId &&
          document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key ===
            unitId
        );
      },
      { unitId, segments: loaded.segments, reusing: !!reusing },
    );
    await page.locator('video[data-media-slot="active"]').evaluate((video) => {
      video.currentTime += 0.5;
      video.dispatchEvent(new Event('seeked'));
      video.dispatchEvent(new Event('timeupdate'));
    });
    await page.waitForTimeout(150);
    assert.equal(
      await page.locator('.snapshot-cell button[aria-current="time"]').getAttribute('data-key'),
      unitId,
    );
  }
  const unitId = identities.at(-1);
  const restored = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/playback',
  );
  await page.reload();
  assert.equal(
    (await restored).postDataJSON().unitId,
    unitId,
    'Reload preserves explicit recording identity',
  );
  await page.waitForFunction(
    (unitId) =>
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === unitId,
    unitId,
  );
  console.log(
    JSON.stringify({
      duplicatePdtUnits: 2,
      exactSeek: true,
      actualProgressIdentity: true,
      restoredIdentity: true,
    }),
  );
} finally {
  await browser?.close();
  await fixture.close();
}
