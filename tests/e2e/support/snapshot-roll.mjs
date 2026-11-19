import assert from 'node:assert/strict';
import { unitPacket, unitRequest, unitId } from './snapshot-units.mjs';

export async function installSnapshotClockGate(page) {
  await page.addInitScript(() => {
    // Window is the event target: a later capture listener cannot preempt
    // application listeners already registered on that same target.
    const gate = (event) => window.__qaSnapshotClockGate?.(event);
    window.addEventListener('stv-clock', gate, true);
    window.addEventListener('stv-display-clock', gate, true);
  });
}

/** Synthetic media only: hold a rolling response and fail the new JPEG once. */
export async function verifySnapshotRoll(page, subjectId, wake) {
  await page.mouse.move(1430, 10);
  assert.equal(await page.locator('.snapshot-pages').isVisible(), true);
  await wake();
  assert.equal(await page.locator('.snapshot-pages').isVisible(), true);
  // Dedicated inter-pane tools stay available without covering the gallery.
  await page.locator('.snapshot-cell img').first().waitFor();
  const jpeg = Buffer.from(
    await page
      .locator('.snapshot-cell img')
      .first()
      .evaluate(async (img) => [...new Uint8Array(await (await fetch(img.src)).arrayBuffer())]),
  );
  const window = await page
    .locator('.viewer-focus')
    .evaluate((node) => ({ fromMs: Number(node.dataset.from), toMs: Number(node.dataset.to) }));
  const response = await page.request.get(
    new URL(
      `/api/subjects/${encodeURIComponent(subjectId)}/snapshot-pages?at=${window.toMs}&from=${window.fromMs}&to=${window.toMs}`,
      page.url(),
    ).href,
  );
  let template = await response.json();
  assert(template.items.length);
  window.fromMs = window.toMs - 1800000;
  template = await (
    await page.request.get(
      new URL(
        `/api/subjects/${encodeURIComponent(subjectId)}/snapshot-pages?at=${window.toMs}&from=${window.fromMs}&to=${window.toMs}`,
        page.url(),
      ).href,
    )
  ).json();
  await page.evaluate((to) => {
    window.__qaSnapshotClocks = [];
    window.__qaSnapshotClockGate = (event) => {
      window.__qaSnapshotClocks.push({
        type: event.type,
        at: event.detail,
        qa: !!event.qaSnapshot,
      });
      window.__qaSnapshotClocks = window.__qaSnapshotClocks.slice(-10);
      if (!event.qaSnapshot) event.stopImmediatePropagation();
    };
    const event = new CustomEvent('stv-clock', { detail: to });
    event.qaSnapshot = true;
    window.dispatchEvent(event);
  }, window.toMs);
  let phase = -1,
    unavailable = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let releaseImage;
  const imageGate = new Promise((resolve) => {
    releaseImage = resolve;
  });
  const counts = new Map();
  const queries = [];
  const items = Array.from({ length: 31 }, (_, index) => {
    const at = window.fromMs + index * 60000;
    return {
      ...template.items[0],
      unitId: unitId(index),
      atMs: at,
      slotFromMs: at,
      slotToMs: at + 60000,
      url: `/api/subjects/${encodeURIComponent(subjectId)}/snapshots/${at}.jpg?to=${at + 86460000}&unit=${unitId(index)}`,
    };
  });
  let unavailableStatus = 429;
  const pages = async (route) => {
    if (unavailable) {
      await route.fulfill({
        status: unavailableStatus,
        json: { error: unavailableStatus === 429 ? 'preview_busy' : 'preview_not_found' },
      });
      return;
    }
    const turn = phase;
    queries.push({ turn, url: route.request().url() });
    if (turn === 1) await gate;
    const shown =
      turn === -2
        ? items.slice(25, 30)
        : turn < 0
          ? []
          : turn === 0
            ? items.slice(0, 30)
            : items.slice(1);
    const { range, options } = unitRequest(route);
    await route.fulfill({
      json: unitPacket(
        { ...template, session: template.session ? { ...template.session, ended: false } : null },
        shown,
        range,
        options,
      ),
    });
  };
  const images = async (route) => {
    const url = new URL(route.request().url()),
      key = url.pathname;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (key.endsWith(`/${items[30].atMs}.jpg`) && count === 1)
      await route.abort('connectionfailed');
    else {
      if (key.endsWith(`/${items[30].atMs}.jpg`)) await imageGate;
      await route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    }
  };
  const sync = () =>
    page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] })),
    );
  const anchors = () =>
    page
      .locator('.snapshot-cell')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.at)));
  try {
    await page.route('**/snapshot-pages?*', pages);
    await page.route('**/snapshots/*.jpg?*', images);
    await sync();
    await page.getByText('最近这段时间暂无截图', { exact: true }).waitFor();
    phase = -2;
    await sync();
    await page.waitForFunction(() => document.querySelectorAll('.snapshot-cell').length === 5);
    const occupiedSlots = await page
      .locator('.snapshot-grid')
      .evaluate((grid) =>
        [...grid.children]
          .map((node, index) => (node.classList.contains('snapshot-cell') ? index : null))
          .filter((index) => index !== null),
      );
    assert.deepEqual(
      occupiedSlots,
      [0, 1, 2, 3, 4],
      'Partial live coverage starts at the first slot and leaves unused capacity at the end',
    );
    assert.equal(
      await page.locator('.snapshot-gap').count(),
      0,
      'The effective live left boundary starts at its first complete unit, without leading gaps',
    );
    assert.equal(await page.locator('.snapshot-slot-empty').count(), 25);
    await page.screenshot({ path: '.local/qa/snapshot-time-slots.png' });
    phase = 0;
    await sync();
    await page.waitForFunction(() => document.querySelectorAll('.snapshot-cell img').length === 30);
    unavailable = true;
    await sync();
    await page
      .locator('.snapshot-status--compact')
      .getByText('截图服务正在忙', { exact: true })
      .waitFor();
    assert.equal(await page.locator('.snapshot-cell').count(), 30);
    await page.screenshot({ path: '.local/qa/snapshot-refresh-busy.png' });
    // A transient busy state stays passive even after the old expansion deadline.
    await page.waitForTimeout(4200);
    assert.equal(await page.locator('.snapshot-status.playback-status--brief').count(), 1);
    assert.equal(await page.locator('.snapshot-status p, .snapshot-status button').count(), 0);
    // An actual missing-index error stays actionable; only routine waits are brief.
    unavailableStatus = 404;
    await sync();
    const retry = page
      .locator('.snapshot-status')
      .getByRole('button', { name: '重新读取', exact: true });
    await retry.waitFor();
    assert.equal(await page.locator('.snapshot-status.playback-status--brief').count(), 0);
    unavailable = false;
    await retry.click();
    await page.waitForFunction(() => !document.querySelector('.snapshot-status'));
    const before = await page
      .locator('.snapshot-cell')
      .evaluateAll((nodes) =>
        Object.fromEntries(nodes.map((node) => [node.dataset.at, node.querySelector('img').src])),
      );
    phase = 1;
    const pending = page.waitForRequest(
      (request) =>
        request.url().includes('/snapshot-pages?') &&
        Number(new URL(request.url()).searchParams.get('to')) === window.toMs + 60000,
    );
    await page.evaluate((to) => {
      const event = new CustomEvent('stv-clock', { detail: to });
      event.qaSnapshot = true;
      window.dispatchEvent(event);
    }, window.toMs + 60000);
    await pending;
    assert.deepEqual(
      await anchors(),
      items.slice(1, 30).map((item) => item.atMs),
      'The display clock reserves the final waiting slot before metadata arrives; survivors stay mounted',
    );
    assert.equal(await page.locator('.snapshot-gap--pending').getAttribute('data-slot'), '29');
    await page.waitForFunction(
      (from) =>
        Number(document.querySelector('.viewer-focus').dataset.from) === from &&
        Number(document.querySelector('.snapshot-section').dataset.from) === from,
      items[1].slotFromMs,
    );
    const pendingImage = page.waitForRequest((request) =>
      request.url().includes(`/snapshots/${items[30].atMs}.jpg`),
    );
    release();
    await pendingImage;
    await page.waitForTimeout(200);
    assert.deepEqual(
      await anchors(),
      items.slice(1).map((item) => item.atMs),
      'Unit positions advance with metadata; only the new image waits for decode',
    );
    assert.equal(await page.locator('.snapshot-cell img').count(), 29);
    releaseImage();
    await page.waitForFunction(
      (at) => Number(document.querySelector('.snapshot-cell').dataset.at) === at,
      items[1].atMs,
    );
    assert.deepEqual(
      await anchors(),
      items.slice(1).map((item) => item.atMs),
      JSON.stringify({
        window,
        session: template.session,
        clocks: await page.evaluate(() => window.__qaSnapshotClocks),
        queries: queries.slice(-8),
        grid: await page
          .locator('.snapshot-cell')
          .evaluateAll((nodes) =>
            nodes.map((node) => ({ at: node.dataset.at, slot: node.dataset.slot })),
          ),
        focus: await page.locator('.viewer-focus').evaluate((node) => ({ ...node.dataset })),
      }),
    );
    await page.waitForFunction(() => document.querySelectorAll('.snapshot-cell img').length === 30);
    const after = await page
      .locator('.snapshot-cell')
      .evaluateAll((nodes) =>
        Object.fromEntries(nodes.map((node) => [node.dataset.at, node.querySelector('img').src])),
      );
    for (const item of items.slice(1, 30)) {
      assert.equal(after[item.atMs], before[item.atMs]);
      // A unit sample may already be warm from the real archive before
      // the synthetic route was installed. Never download a survivor twice.
      assert((counts.get(new URL(item.url, page.url()).pathname) ?? 0) <= 1);
    }
    assert.equal(counts.get(new URL(items[30].url, page.url()).pathname), 2);
  } finally {
    release();
    releaseImage();
    await page.unroute('**/snapshot-pages?*', pages);
    await page.unroute('**/snapshots/*.jpg?*', images);
    await page.evaluate(() => {
      delete window.__qaSnapshotClockGate;
      delete window.__qaSnapshotClocks;
      window.dispatchEvent(new CustomEvent('stv-clock', { detail: Date.now() }));
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.snapshot-cell').length < 30);
  }
}
