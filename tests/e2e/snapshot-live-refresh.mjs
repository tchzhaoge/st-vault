import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

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
  await page.locator('.track-row').first().waitFor();
  const clock = async (at) =>
    page.evaluate((at) => {
      const event = new CustomEvent('stv-clock', { detail: at });
      event.qaSnapshot = true;
      window.dispatchEvent(event);
    }, at);
  const base = Math.ceil(fixture.info.archiveEnd / 60000) * 60000 + 10000;
  await clock(base);
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.locator('.snapshot-cell img').first().waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.snapshot-cell')].every((node) => node.querySelector('img')),
  );
  const before = await page
    .locator('.snapshot-cell')
    .evaluateAll((nodes) =>
      Object.fromEntries(nodes.map((node) => [node.dataset.at, node.querySelector('img').src])),
    );
  const starts = [];
  for (const offset of [5000, 10000, 15000, 55000]) {
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith('/snapshot-pages') &&
        Number(url.searchParams.get('to')) === base + offset
      );
    });
    await clock(base + offset);
    const packet = await response;
    starts.push(Number(new URL(packet.url()).searchParams.get('from')));
    const json = await packet.json();
    assert.deepEqual(
      json.items.map((item) => String(item.atMs)),
      Object.keys(before),
      'Heartbeat must not change a persisted recording unit sample',
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const after = await page
      .locator('.snapshot-cell')
      .evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((node) => [node.dataset.at, node.querySelector('img')?.src ?? null]),
        ),
      );
    assert.deepEqual(
      after,
      before,
      'Existing images and object URLs must survive real live refreshes',
    );
  }
  assert.equal(starts[1] - starts[0], 5000);
  assert.equal(starts[2] - starts[1], 5000);
  assert.equal(
    starts[3] - starts[2],
    40000,
    'Live request window follows now independently of recorded end',
  );
  await page.locator('.inline-player').evaluate((node) => node.requestFullscreen());
  await page.locator('.inline-player:fullscreen .media-review').waitFor();
  const fullscreenResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith('/snapshot-pages') &&
      Number(url.searchParams.get('to')) === base + 60000
    );
  });
  await clock(base + 60000);
  const fullPacket = await (await fullscreenResponse).json();
  assert.deepEqual(
    fullPacket.items.map((item) => String(item.atMs)),
    Object.keys(before),
  );
  const [first, neighbor] = fullPacket.items;
  assert(first && neighbor, 'fixture needs two recording units for cross-mode favorites');
  const api = (path, body) =>
    page.evaluate(
      async ({ path, body }) => {
        const response = await fetch(
          path,
          body === undefined
            ? undefined
            : {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
        );
        return { status: response.status, value: await response.json() };
      },
      { path, body },
    );
  const favoritesPath = `/api/subjects/${encodeURIComponent(fixture.info.subjectId)}/unit-favorites`;
  const known = await api(`${favoritesPath}/query`, { unitIds: [first.unitId, neighbor.unitId] });
  assert.equal(known.status, 200);
  const liked = await api(favoritesPath, {
    unitIds: [first.unitId, neighbor.unitId],
    liked: true,
    revision: known.value.revision,
  });
  assert.equal(liked.status, 200);
  const favoriteState = (at, pressed) =>
    page.waitForFunction(
      ({ at, pressed }) =>
        document
          .querySelector(`.snapshot-cell[data-at="${at}"] .snapshot-favorite`)
          ?.getAttribute('aria-pressed') === String(pressed),
      { at, pressed },
    );
  await favoriteState(first.atMs, true);
  await page.locator('.inline-player').dispatchEvent('pointermove', { pointerType: 'mouse' });
  await page.locator('.snapshot-cell button[data-unit-index]').first().click();
  await page.locator('.inline-player[aria-label="录像播放器"]').waitFor();
  await favoriteState(first.atMs, true);
  const clipped = await api(
    `/api/subjects/${encodeURIComponent(fixture.info.subjectId)}/snapshot-pages?at=${first.atMs}&from=${first.atMs + 1}&to=${Math.min(first.slotToMs, first.atMs + 500)}`,
  );
  assert.equal(clipped.status, 200);
  const partial = clipped.value.items[0];
  assert.deepEqual([partial.slotFromMs, partial.slotToMs], [first.slotFromMs, first.slotToMs]);
  assert.equal(partial.atMs, first.atMs, 'Partial replay retains its unit sample');
  assert.equal(partial.unitId, first.unitId);
  const removed = await api(favoritesPath, {
    unitIds: [partial.unitId],
    liked: false,
    revision: liked.value.revision,
  });
  assert.equal(removed.status, 200);
  await favoriteState(first.atMs, false);
  await favoriteState(neighbor.atMs, true);
  assert.equal(
    await page
      .locator('.viewer-focus')
      .evaluate((node) => Number(node.dataset.to) - Number(node.dataset.from)),
    fullPacket.displayWindow.toMs - fullPacket.displayWindow.fromMs,
    'Clicking a live thumbnail preserves its effective displayed window',
  );
  console.log(
    '[qa] Live image retention, continuous clock window, whole-unit favorite identity and neighbor protection passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
