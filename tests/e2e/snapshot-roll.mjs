import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { verifySnapshotRoll, installSnapshotClockGate } from './support/snapshot-roll.mjs';
const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await installSnapshotClockGate(page);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.locator('.snapshot-cell img').first().waitFor();
  let x = 0;
  await verifySnapshotRoll(page, fixture.info.subjectId, async () => {
    const box = await page.locator('.snapshot-section').boundingBox();
    await page.mouse.move(box.x + box.width / 2 + ++x, box.y + box.height / 2);
  });
  console.log(
    '[qa] Unit rollover advances metadata immediately, retries the new JPEG independently and reuses survivors',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
