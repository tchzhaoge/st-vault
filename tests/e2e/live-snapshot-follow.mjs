import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser, release, releaseOld;
try {
  await fixture.seedSnapshotHistory();
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
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row').first().waitFor();
  const base = fixture.info.archiveStart + 1000;
  const clock = (at) =>
    page.evaluate((at) => {
      const event = new CustomEvent('stv-clock', { detail: at });
      event.qaSnapshot = true;
      window.dispatchEvent(event);
    }, at);
  await clock(base);
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.locator('.snapshot-cell img').first().waitFor();
  // Selecting a subject resets the calendar view. Include pre-midnight fixtures afterwards.
  const viewFrom = await page
    .locator('.track-lane')
    .first()
    .evaluate((node) => Number(node.dataset.from));
  if (base < viewFrom)
    await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  const sharedWindow = async () => {
    const values = await page.evaluate(() =>
      ['.range-selection', '.viewer-focus', '.snapshot-section'].map((selector) => {
        const node = document.querySelector(selector);
        return { from: node.dataset.from, to: node.dataset.to };
      }),
    );
    assert.deepEqual(values[0], values[1]);
    assert.deepEqual(values[0], values[2]);
  };
  await sharedWindow();
  assert.equal(
    await page.locator('.range-selection').getAttribute('aria-hidden'),
    'false',
    await page.locator('.range-selection').evaluate((node) =>
      JSON.stringify({
        html: node.outerHTML,
        lane: document.querySelector('.track-lane')?.outerHTML.slice(0, 300),
      }),
    ),
  );
  await page.evaluate(() => {
    window.__cards = new Map(
      [...document.querySelectorAll('.snapshot-cell')].map((node) => [
        node.dataset.key,
        { node, slot: node.dataset.slot, image: node.querySelector('img')?.src },
      ]),
    );
    window.__liveVideo = document.querySelector('video[data-media-slot="active"]');
  });
  const first = page.locator('.snapshot-cell button[data-unit-index]').first();
  const key = await first.getAttribute('data-key');
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/playback', async (route) => {
    await gate;
    await route.continue();
  });
  const requested = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/playback',
  );
  await first.click();
  const body = (await requested).postDataJSON();
  assert(
    !('fromMs' in body) && !('toMs' in body),
    'A rolling seek must not turn the presentation window into playback bounds',
  );
  await page.waitForFunction(
    (key) =>
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === key,
    key,
  );
  await page.waitForTimeout(250);
  const sameCards = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.snapshot-cell')].every((node) => {
        const old = window.__cards.get(node.dataset.key);
        return (
          !old ||
          (old.node === node && (!old.image || node.querySelector('img')?.src === old.image))
        );
      }),
    );
  assert(await sameCards());
  release();
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video !== window.__liveVideo && video.readyState >= 2 && !video.paused;
  });
  await page.locator('video[data-media-slot="active"]').evaluate((video) => {
    video.pause();
    window.__archiveVideo = video;
  });
  assert(await sameCards());
  const pulse = async (at) => {
    const response = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname.endsWith('/snapshot-pages') &&
          url.searchParams.get('follow') === '1' &&
          Number(url.searchParams.get('to')) === at
        );
      },
      { timeout: 5000 },
    );
    await clock(at);
    const packet = await (await response).json();
    await page.waitForFunction(
      (ids) =>
        JSON.stringify(
          [...document.querySelectorAll('.snapshot-cell')].map((node) => node.dataset.key),
        ) === JSON.stringify(ids),
      packet.items.map((item) => item.unitId),
    );
    assert.equal(packet.pages, 1);
    assert(packet.slotCount <= 30);
    await sharedWindow();
    return packet;
  };
  const beforeTo = await page.locator('.viewer-focus').evaluate((node) => Number(node.dataset.to));
  await pulse(base + 1000);
  assert(await sameCards(), 'Heartbeat retains decoded image owners');
  assert(
    (await page.locator('.viewer-focus').evaluate((node) => Number(node.dataset.to))) > beforeTo,
  );
  await pulse(base + 61000);
  assert(await sameCards(), 'Surviving cards retain their DOM and URLs when the grid rolls');
  const newAt = base + 31 * 60000;
  await fixture.appendSnapshotUnit(newAt);
  const appended = await pulse(newAt + 1000);
  assert(!appended.items.some((item) => item.unitId === key));
  assert.equal(
    await page.locator('.snapshot-cell button[aria-current="time"]').count(),
    0,
    'An offscreen playing unit must not highlight a neighbor',
  );
  assert(
    await page
      .locator('video[data-media-slot="active"]')
      .evaluate((video) => video === window.__archiveVideo && video.paused),
  );
  await fixture.appendSnapshotUnit(newAt + 60000);
  const latest = await pulse(newAt + 61000);
  assert.equal(latest.items.length, 2);
  const [older, newer] = latest.items;
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  await page.unroute('**/api/playback');
  await page.route('**/api/playback', async (route) => {
    if (route.request().postDataJSON().targetUtcMs === older.atMs) await oldGate;
    await route.continue();
  });
  await page.locator(`.snapshot-cell button[data-key="${older.unitId}"][data-unit-index]`).click();
  await page.waitForFunction(
    (key) =>
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === key,
    older.unitId,
  );
  await page.locator(`.snapshot-cell button[data-key="${newer.unitId}"][data-unit-index]`).click();
  await page.waitForFunction(
    (key) =>
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === key,
    newer.unitId,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('video[data-media-slot="active"]') !== window.__archiveVideo &&
      document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  releaseOld();
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('.snapshot-cell button[aria-current="time"]').getAttribute('data-key'),
    newer.unitId,
  );
  await pulse(newAt + 62000);
  // Deleting playing media rebuilds its source without freezing the live view;
  // the neighboring liked unit survives and keeps its image owner.
  await page.locator('video[data-media-slot="active"]').evaluate((video) => {
    window.__beforeDelete = video;
  });
  await page.locator(`.snapshot-cell button[data-key="${older.unitId}"][data-unit-index]`).click();
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video !== window.__beforeDelete && video.readyState >= 2 && !video.paused;
  });
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  const likedNeighbor = page.locator(
    `.snapshot-cell[data-key="${newer.unitId}"] .snapshot-favorite`,
  );
  await likedNeighbor.click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`.snapshot-cell[data-key="${id}"] .snapshot-favorite`)
        ?.getAttribute('aria-pressed') === 'true',
    newer.unitId,
  );
  await page.evaluate((id) => {
    window.__neighborCard = document.querySelector(`.snapshot-cell[data-key="${id}"]`);
  }, newer.unitId);
  await page
    .locator('.snapshot-actions')
    .getByRole('button', { name: '删除所有非喜欢', exact: true })
    .click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(
    ({ older, newer }) =>
      !document.querySelector(`.snapshot-cell[data-key="${older}"]`) &&
      document.querySelector('.snapshot-cell button[aria-current="time"]')?.dataset.key === newer,
    { older: older.unitId, newer: newer.unitId },
  );
  assert(
    await page.evaluate(
      (id) => window.__neighborCard === document.querySelector(`.snapshot-cell[data-key="${id}"]`),
      newer.unitId,
    ),
  );
  const afterDelete = await pulse(newAt + 63000);
  assert.deepEqual(
    afterDelete.items.map((item) => item.unitId),
    [newer.unitId],
  );
  if ((await likedNeighbor.getAttribute('aria-pressed')) !== 'true')
    console.error(
      '[qa] Surviving favorite state',
      await page.evaluate(
        async ({ subjectId, unitId }) => {
          const response = await fetch(
            `/api/subjects/${encodeURIComponent(subjectId)}/unit-favorites/query`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ unitIds: [unitId] }),
            },
          );
          return {
            status: response.status,
            body: await response.text(),
            html: document.querySelector(`.snapshot-cell[data-key="${unitId}"]`)?.outerHTML,
          };
        },
        { subjectId: fixture.info.subjectId, unitId: newer.unitId },
      ),
    );
  assert.equal(await likedNeighbor.getAttribute('aria-pressed'), 'true');
  // Reload restores media position and the independent rolling presentation.
  const restored = page.waitForResponse(
    (response) =>
      response.url().includes('/snapshot-pages?') &&
      new URL(response.url()).searchParams.get('follow') === '1',
  );
  await page.reload();
  assert.equal((await restored).status(), 200);
  await page
    .locator('.inline-player[aria-label="录像播放器"] video[data-media-slot="active"]')
    .waitFor();
  // Reload resets the synthetic clock; keep appended fixture units in the observable past.
  await pulse(newAt + 120000);
  // The restored rolling frame animates to its new position. Start on the lane,
  // not on a moving resize handle passing through the intended pointer point.
  await page.waitForFunction(() =>
    document
      .querySelector('.selection-timeline')
      .getAnimations({ subtree: true })
      .every((animation) => ['finished', 'idle'].includes(animation.playState)),
  );
  // Only a drag changes presentation mode.
  const lane = await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .track-lane`)
    .boundingBox();
  const fixed = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/playback' &&
      'fromMs' in request.postDataJSON(),
  );
  await page.mouse.move(lane.x + 2, lane.y + 40);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width - 2, lane.y + 40, { steps: 8 });
  await page.mouse.up();
  assert((await fixed).postDataJSON().toMs > 0);
  const fixedWindow = await page.locator('.viewer-focus').evaluate((node) => ({ ...node.dataset }));
  await clock(newAt + 120000);
  await page.waitForTimeout(250);
  const after = await page.locator('.viewer-focus').evaluate((node) => ({ ...node.dataset }));
  assert.equal(after.from, fixedWindow.from);
  assert.equal(after.to, fixedWindow.to);
  await sharedWindow();
  const fixedReload = page.waitForResponse(
    (response) =>
      response.url().includes('/snapshot-pages?') &&
      !new URL(response.url()).searchParams.has('follow'),
  );
  await page.reload();
  assert.equal((await fixedReload).status(), 200);
  await page.waitForFunction((range) => {
    const node = document.querySelector('.viewer-focus');
    return node?.dataset.from === range.from && node?.dataset.to === range.to;
  }, fixedWindow);
  // Offline selection has the same rolling window, even without a recording session.
  await page.locator('.subject-filters').getByRole('button', { name: '离线', exact: true }).click();
  await page.locator('.track-row[data-subject-id="stripchat:3"] .subject-preview').click();
  await page
    .locator('.snapshot-status strong')
    .filter({ hasText: '最近这段时间暂无截图' })
    .waitFor();
  assert.match(await page.locator('.snapshot-status').innerText(), /演示主播 003 当前离线/);
  assert.match(
    await page.locator('.snapshot-status').innerText(),
    /\d{2}:\d{2} — (?:\S+ )?\d{2}:\d{2}/,
  );
  assert.equal(await page.locator('.range-selection').getAttribute('aria-hidden'), 'false');
  await sharedWindow();
  console.log(
    JSON.stringify({
      rollingAfterSeek: true,
      survivingImagesRetained: true,
      evictedHighlightCleared: true,
      lastSeekWins: true,
      rollingAfterDeletion: true,
      rollingRestored: true,
      fixedRestored: true,
      dragAloneFixesBounds: true,
    }),
  );
} finally {
  release?.();
  releaseOld?.();
  await browser?.close();
  await fixture.close();
}
