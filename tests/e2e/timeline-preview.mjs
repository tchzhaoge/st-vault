import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
let releaseMetadata;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const reads = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/(?:snapshot-point|snapshots)$/.test(url.pathname)) reads.push(url.pathname);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  const lane = row.locator('.track-lane');
  await lane.locator('.track-clip').first().waitFor();
  const dimensions = await lane.evaluate((node) => ({
    height: node.querySelector('.timeline-content').getBoundingClientRect().height,
    status: node.querySelector('.status-line').getBoundingClientRect().height,
    recording: node.querySelector('.recording-line').getBoundingClientRect().height,
  }));
  assert(
    Math.abs(dimensions.status / dimensions.height - 1 / 6) < 0.001,
    JSON.stringify(dimensions),
  );
  assert(dimensions.recording > dimensions.status * 4, JSON.stringify(dimensions));
  const clip = await lane.locator('.track-clip').first().boundingBox();
  const x = clip.x + clip.width / 2,
    y = clip.y + clip.height / 2;
  const metadataGate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  await page.route('**/snapshot-point?*', async (route) => {
    await metadataGate;
    await route.continue();
  });
  // A stationary pointer must request immediately, even while browser timers are paused.
  await page.clock.pauseAt(new Date());
  const metadataRequest = page.waitForRequest(
    (request) => request.url().includes('/snapshot-point?'),
    { timeout: 2000 },
  );
  await page.mouse.move(x, y);
  const preview = page.locator('.timeline-hover-preview');
  await Promise.all([preview.waitFor({ timeout: 2000 }), metadataRequest]);
  assert.equal(await preview.getAttribute('aria-busy'), 'true');
  assert.equal(
    await preview.locator('img').count(),
    0,
    'The placeholder precedes metadata and pixels',
  );
  releaseMetadata();
  await page.clock.resume();
  await preview.locator('img').waitFor({ timeout: 30000 });
  assert.equal(await preview.getAttribute('aria-busy'), 'false');
  assert(reads.some((path) => path.endsWith('/snapshot-point')));
  assert(
    !reads.some((path) => path.endsWith('/snapshots')),
    'Hover reads one canonical unit, never a window catalog',
  );
  assert.equal(await preview.getAttribute('data-subject-id'), fixture.info.subjectId);
  assert.equal(await preview.locator('strong,time,.timeline-hover-caption').count(), 0);
  assert.equal((await preview.textContent()).trim(), '');
  const first = await preview.boundingBox();
  assert(
    Math.abs(first.height - (first.width * 9) / 16) < 2,
    'Only the image occupies the preview',
  );
  const recordingBounds = await lane.locator('.recording-line').boundingBox();
  assert(first.y >= recordingBounds.y - 0.5);
  assert(first.y + first.height <= recordingBounds.y + recordingBounds.height + 0.5);
  assert(first.x >= x + 11 || first.x + first.width <= x - 11, 'Preview stays beside the pointer');
  await page.mouse.move(x, y + 10);
  const next = await preview.boundingBox();
  assert(next.y >= recordingBounds.y - 0.5);
  assert(next.y + next.height <= recordingBounds.y + recordingBounds.height + 0.5);
  assert(next.x >= 0 && next.x + next.width <= 1440);
  assert(next.y >= 0 && next.y + next.height <= 900);
  await page.mouse.down();
  await preview.waitFor({ state: 'detached' });
  await page.mouse.up();
  await page.mouse.move(x, y);
  await preview.waitFor();
  await page.locator('.track-table-scroll').evaluate((node) => {
    node.scrollTop += 116;
  });
  await preview.waitFor({ state: 'detached' });
  await page.mouse.move(20, 20);
  assert.equal(await preview.count(), 0);
  console.log(
    '[qa] Timeline 1/6 status height, screenshot hover, pointer tracking and gesture cleanup passed',
  );
} finally {
  releaseMetadata?.();
  await browser?.close();
  await fixture.close();
}
