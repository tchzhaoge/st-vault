import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
try {
  const history = await fixture.seedSnapshotHistory();
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const freeze = (event) => {
      if (!event.qaSnapshot) event.stopImmediatePropagation();
    };
    window.addEventListener('stv-clock', freeze, true);
    window.addEventListener('stv-display-clock', freeze, true);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.route('**/snapshot-pages?*', async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const packet = await response.json();
    if (packet.items.length > 1)
      packet.items[0].slotToMs = Math.max(packet.items[0].slotToMs, packet.items[1].atMs + 19);
    await route.fulfill({ response, json: packet });
  });
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row').first().waitFor();
  const clock = (at) =>
    page.evaluate((at) => {
      const event = new CustomEvent('stv-clock', { detail: at });
      event.qaSnapshot = true;
      window.dispatchEvent(event);
    }, at);
  await clock(fixture.info.archiveStart + 1000);
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.locator('.snapshot-cell button[data-unit-index]').first().waitFor();
  assert.equal(await page.locator('.snapshot-pages output,.snapshot-page-button').count(), 0);
  for (const offset of [10 * 60000, 0]) {
    const updated = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith('/snapshot-pages') &&
        Number(url.searchParams.get('to')) === fixture.info.archiveStart + 1000 + offset
      );
    });
    await clock(fixture.info.archiveStart + 1000 + offset);
    const packet = await (await updated).json();
    assert.equal(packet.pages, 1);
    await page.waitForFunction(
      (ids) =>
        JSON.stringify(
          [...document.querySelectorAll('.snapshot-cell')].map((node) => node.dataset.key),
        ) === JSON.stringify(ids),
      packet.items.map((item) => item.unitId),
    );
  }
  // Production PDT boundaries can overlap by milliseconds. Clicking the next
  // unit's sample must never highlight its predecessor while media is prepared.
  const button = page.locator('.snapshot-cell button[data-unit-index]').nth(1);
  const key = await button.getAttribute('data-key');
  const traceSeek = (key) =>
    page.evaluate((key) => {
      window.__oldSeekVideo = document.querySelector('video[data-media-slot="active"]');
      window.__seekFeedback = {
        key,
        clickedAt: 0,
        firstAt: null,
        samples: [],
        misses: [],
        stop: false,
        layoutChanges: [],
      };
      const cards = () => [...document.querySelectorAll('.snapshot-cell')];
      const layout = () => cards().map((node) => [node.dataset.key, node.dataset.slot]);
      const initialLayout = JSON.stringify(layout());
      window.__seekFeedback.initialLayout = {
        count: cards().length,
        first: layout()[0],
        last: layout().at(-1),
      };
      const initialNodes = new Map(cards().map((node) => [node.dataset.key, node]));
      document
        .querySelector(`.snapshot-cell button[data-key="${CSS.escape(key)}"]`)
        .addEventListener(
          'click',
          () => {
            window.__seekFeedback.clickedAt = performance.now();
          },
          { once: true, capture: true },
        );
      const sample = () => {
        const trace = window.__seekFeedback;
        if (
          trace.clickedAt &&
          trace.layoutChanges.length < 3 &&
          (JSON.stringify(layout()) !== initialLayout ||
            cards().some((node) => initialNodes.get(node.dataset.key) !== node))
        )
          trace.layoutChanges.push({
            count: cards().length,
            first: layout()[0],
            last: layout().at(-1),
            replaced: cards().filter((node) => initialNodes.get(node.dataset.key) !== node).length,
            window: { ...document.querySelector('.viewer-focus').dataset },
          });
        const keys = [
          ...document.querySelectorAll('.snapshot-cell button[aria-current="time"]'),
        ].map((node) => node.dataset.key);
        if (trace.firstAt === null && keys.includes(trace.key)) trace.firstAt = performance.now();
        if (trace.clickedAt) trace.samples.push(keys);
        if (trace.firstAt !== null && document.querySelector('.snapshot-ghost button.selected'))
          trace.samples.push(['stale-exit-highlight']);
        if (trace.firstAt !== null && !keys.includes(trace.key) && trace.misses.length < 3)
          trace.misses.push({
            cursor: document.querySelector('.focus-lane')?.getAttribute('aria-valuenow'),
            page: document.querySelector('.snapshot-pages output')?.textContent,
            units: [...document.querySelectorAll('.snapshot-cell button[data-unit-index]')].map(
              (node) => [node.dataset.key, node.dataset.at],
            ),
            media: document.querySelector('video[data-media-slot="active"]')?.currentTime,
          });
        if (!trace.stop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, key);
  await traceSeek(key);
  await page.route('**/api/playback', async (route) => {
    await gate;
    await route.continue();
  });
  await page.route('**/snapshot-pages?*', async (route) => {
    await gate;
    await route.fallback();
  });
  const requested = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/playback',
  );
  await button.click();
  await requested;
  await page.waitForFunction(
    (key) =>
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === key,
    key,
    { timeout: 500 },
  );
  await page.waitForTimeout(250);
  assert.equal(
    await button.getAttribute('aria-current'),
    'time',
    'The clicked card must remain highlighted while both APIs are held',
  );
  release();
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video !== window.__oldSeekVideo && video.readyState >= 2 && !video.paused;
  });
  await page.waitForTimeout(150);
  const result = await page.evaluate(() => {
    window.__seekFeedback.stop = true;
    return window.__seekFeedback;
  });
  assert(result.samples.length > 3);
  if (result.layoutChanges.length) console.log('[qa] Layout trace', JSON.stringify(result));
  assert.deepEqual(
    result.layoutChanges,
    [],
    'Live-to-replay preserves card count, slots and mounted image owners',
  );
  assert(
    result.samples.every((keys) => keys.length === 1 && keys[0] === result.key),
    JSON.stringify(result),
  );
  console.log(
    JSON.stringify({
      feedbackMs: Math.round(result.firstAt - result.clickedAt),
      sampledFrames: result.samples.length,
      wrongHighlights: 0,
      cachedPageRetained: true,
    }),
  );
  // Explicit replay selections retain pagination independently of the bounded live window.
  const viewFrom = await page
    .locator('.track-lane')
    .first()
    .evaluate((node) => Number(node.dataset.from));
  if (history.fromMs < viewFrom)
    await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  const lane = await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .track-lane`)
    .boundingBox();
  const previousVideo = await page.locator('video[data-media-slot="active"]').elementHandle();
  await page.mouse.move(lane.x + 2, lane.y + 40);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width - 2, lane.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video !== previous && video.readyState >= 2;
  }, previousVideo);
  // Progress may cross a page while the user is browsing elsewhere. It must
  // not take navigation ownership back from an explicit page-button click.
  await page.locator('video[data-media-slot="active"]').evaluate((video) => {
    video.pause();
    video.currentTime = 0.2;
  });
  await page.waitForFunction(() =>
    /^1\s*\/\s*[2-9]/.test(document.querySelector('.snapshot-pages output')?.textContent ?? ''),
  );
  await page.locator('.snapshot-grid').hover();
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() =>
    /^2\s*\/\s*[2-9]/.test(document.querySelector('.snapshot-pages output')?.textContent ?? ''),
  );
  await page.locator('video[data-media-slot="active"]').evaluate(async (video) => {
    video.currentTime = video.duration - 0.4;
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    video.currentTime = 0.2;
  });
  await page.waitForTimeout(400);
  assert.match(
    await page.locator('.snapshot-pages output').textContent(),
    /^2\s*\/\s*[2-9]/,
    'Playback progress must not override a manually chosen page',
  );
  const browseTarget = page.locator('.snapshot-cell button[data-unit-index]').first();
  const browseKey = await browseTarget.getAttribute('data-key');
  await browseTarget.click();
  await page.waitForFunction(
    (key) =>
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === key,
    browseKey,
  );
  // Selection feedback precedes decoder handover. Drive progress only after
  // the requested slot owns playback, rather than seeking the outgoing frame.
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return (
      document.querySelectorAll('video').length === 1 && video?.readyState >= 2 && !video.paused
    );
  });
  // Each manifest starts at its requested segment, not at the selection's
  // beginning. Cross its real end into page 3 instead of treating media 0 as UTC page 1.
  await page.locator('video[data-media-slot="active"]').evaluate(async (video) => {
    video.currentTime = Math.max(0, video.duration - 0.15);
    await video.play();
  });
  await page.waitForFunction(() =>
    /^3\s*\/\s*[3-9]/.test(document.querySelector('.snapshot-pages output')?.textContent ?? ''),
  );
  console.log(JSON.stringify({ manualBrowsingRetained: true, screenshotResumesFollowing: true }));

  // Reconnecting restores the latest single live page, independent of prior browsing.
  await page.locator('.connection-close').click();
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.locator('.inline-player[aria-label="直播播放器"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('.snapshot-pages output'));
  await page.locator('.snapshot-grid[aria-busy="false"] button[data-unit-index]').first().waitFor();
  const oldest = page.locator('.snapshot-cell button[data-unit-index]').first();
  const oldestKey = await oldest.getAttribute('data-key');
  await traceSeek(oldestKey);
  await oldest.click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video !== window.__oldSeekVideo && video.readyState >= 2 && !video.paused;
  });
  // Observe actual rendered frames, rather than assuming a busy CI browser
  // produces at least three frames within an arbitrary 100ms wall-clock wait.
  await page.waitForFunction(() => window.__seekFeedback.samples.length > 2);
  const oldestTrace = await page.evaluate(() => {
    window.__seekFeedback.stop = true;
    return window.__seekFeedback;
  });
  assert(oldestTrace.samples.length > 2, JSON.stringify(oldestTrace));
  assert.deepEqual(
    oldestTrace.layoutChanges,
    [],
    'Reconnected live pages retain their unit layout when seeking',
  );
  assert(
    oldestTrace.samples.every((keys) => keys.length === 1 && keys[0] === oldestKey),
    JSON.stringify(oldestTrace),
  );
  console.log(JSON.stringify({ oldestLivePage: true, wrongHighlights: 0 }));
} finally {
  release();
  await browser?.close();
  await fixture.close();
}
