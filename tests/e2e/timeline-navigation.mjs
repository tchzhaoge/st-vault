import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser, page;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.live-now-line').waitFor();
  const controlGeometry = await page.locator('.time-range-control').evaluate((node) => {
    const window = node.querySelector('.view-position-window').getBoundingClientRect();
    const buttons = [...node.querySelectorAll('.day-step')].map((button) =>
      button.getBoundingClientRect(),
    );
    const date = node.querySelector('.ruler-date').getBoundingClientRect();
    return {
      height: window.height,
      bottom: window.bottom,
      dateTop: date.top,
      centers: buttons.map((box) =>
        Math.abs(box.y + box.height / 2 - window.y - window.height / 2),
      ),
    };
  });
  assert(controlGeometry.height >= 26 && controlGeometry.bottom <= controlGeometry.dateTop);
  assert(controlGeometry.centers.every((delta) => delta <= 2));
  const verifySpanLabel = async () => {
    const value = await page.locator('.view-position-window').evaluate((node) => {
      const label = node.querySelector('.view-position-span');
      const rail = node.parentElement.getBoundingClientRect(),
        box = node.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      const lane = document.querySelector('.track-lane');
      const grip = node.querySelector('.view-position-grip');
      const maximum = Number(grip.getAttribute('aria-valuemax'));
      const fraction = maximum ? Number(grip.getAttribute('aria-valuenow')) / maximum : 0;
      return {
        label: label.textContent,
        duration: Number(lane.dataset.to) - Number(lane.dataset.from),
        fits:
          label.scrollWidth <= label.clientWidth &&
          text.left >= box.left &&
          text.right <= box.right,
        bounded: box.left >= rail.left - 1 && box.right <= rail.right + 1,
        positioned: Math.abs(box.left - rail.left - (rail.width - box.width) * fraction) <= 1,
      };
    });
    const days = value.duration / 86400000;
    assert.equal(value.label, days < 1 ? `${days * 24}小时` : `${days}天`);
    assert(
      value.fits && value.bounded && value.positioned,
      'The labeled slider stays legible and tracks its available travel',
    );
  };
  await verifySpanLabel();
  const grip = page.getByRole('slider', { name: '平移视窗', exact: true });
  const beforeDrag = Number(await page.locator('.track-lane').first().getAttribute('data-from'));
  const gripBox = await grip.boundingBox();
  const travel = await page
    .locator('.view-position')
    .evaluate(
      (node) =>
        node.clientWidth -
        node.querySelector('.view-position-window').getBoundingClientRect().width,
    );
  const halfDayTravel = (travel * 0.5) / Number(await grip.getAttribute('aria-valuemax'));
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    gripBox.x + gripBox.width / 2 - halfDayTravel,
    gripBox.y + gripBox.height / 2,
  );
  await page.mouse.up();
  await page.waitForFunction(
    (from) => Number(document.querySelector('.track-lane').dataset.from) === from - 43200000,
    beforeDrag,
  );
  await verifySpanLabel();
  await grip.press('ArrowRight');
  await page.waitForFunction(
    (from) => Number(document.querySelector('.track-lane').dataset.from) === from,
    beforeDrag,
  );
  await page.waitForTimeout(400);
  await page.waitForTimeout(300);
  const divisions = await page.locator('.time-ruler-row .timeline-ruler').evaluate((ruler) => {
    const labels = [...ruler.querySelectorAll('.ruler-hour')].map(
      (node) => node.getBoundingClientRect().bottom,
    );
    const lines = [...ruler.querySelectorAll('.ruler-division')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        height: rect.height,
        width: rect.width,
        edge: node.dataset.windowEdge,
        day: node.classList.contains('division-day'),
        left: rect.left,
        right: rect.right,
      };
    });
    const box = ruler.getBoundingClientRect();
    return { lines, labelBottom: Math.max(...labels), left: box.left, right: box.right };
  });
  assert.equal(await page.locator('.ruler-boundary,.timeline-edge').count(), 0);
  assert(
    divisions.lines.every((line) => line.top >= divisions.labelBottom),
    'Calendar strokes start below time labels',
  );
  assert(
    Math.max(...divisions.lines.map((line) => line.height)) -
      Math.min(...divisions.lines.map((line) => line.height)) <
      0.5,
    'All calendar levels share one tick length',
  );
  const edges = divisions.lines.filter((line) => line.edge);
  assert.equal(edges.length, 2);
  assert(
    edges.every(
      (line) =>
        line.left >= divisions.left - 0.5 &&
        line.right <= divisions.right + 0.5 &&
        line.width === (line.day ? 2 : 1),
    ),
    'Calendar edges remain visible with their actual stroke weight',
  );
  await page.evaluate(() => {
    window.__panSamples = [];
    window.__panSampling = true;
    const sample = () => {
      const lane = document.querySelector('.track-lane'),
        ruler = document.querySelector('.time-ruler-row .timeline-scene'),
        now = document.querySelector('.live-now-line');
      if (lane && ruler && now) {
        const from = Number(lane.dataset.from),
          to = Number(lane.dataset.to),
          at = Number(now.dataset.at);
        const expected =
          ruler.getBoundingClientRect().left + ((at - from) / (to - from)) * ruler.clientWidth;
        const nodes = [
          ...document.querySelectorAll(
            '.track-lane > .timeline-scene, .timeline-grid > .timeline-scene, .time-ruler-row .timeline-scene, .selection-timeline > .timeline-scene',
          ),
        ];
        const offsets = nodes.map(
          (node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
        );
        const grid = document.querySelector('.timeline-grid > .timeline-scene');
        window.__panSamples.push({
          rulerLeft: ruler.getBoundingClientRect().left,
          gridLeft: grid.getBoundingClientRect().left,
          rulerWidth: ruler.clientWidth,
          gridWidth: grid.clientWidth,
          at: performance.now(),
          from,
          drift: now.getBoundingClientRect().left - expected,
          spread: Math.max(...offsets) - Math.min(...offsets),
          moving: nodes.some((node) => node.getAnimations().some((a) => a.id === 'timeline-pan')),
        });
      }
      if (window.__panSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const initialFrom = Number(await page.locator('.track-lane').first().getAttribute('data-from'));
  const partialBefore = new Date(initialFrom + 8 * 3600000).getUTCHours() === 12;
  if (partialBefore)
    assert.deepEqual((await page.locator('.ruler-half-label').allTextContents()).sort(), [
      '上午',
      '下午',
    ]);
  const clickedAt = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: '前12小时', exact: true }).click();
  await page.waitForTimeout(80);
  if (!partialBefore)
    assert.deepEqual((await page.locator('.ruler-half-label').allTextContents()).sort(), [
      '上午',
      '下午',
    ]);
  await page.locator('.track-table-scroll').evaluate((node) => {
    node.scrollTop += 5 * 116;
    node.scrollLeft = 30;
  });
  await page.waitForTimeout(80);
  await page.getByRole('button', { name: '后12小时', exact: true }).click();
  await page.waitForTimeout(80);
  await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  await page.waitForTimeout(600);
  await verifySpanLabel();
  await page.getByRole('button', { name: '前12小时', exact: true }).click();
  await page.waitForTimeout(60);
  await page.getByRole('button', { name: '后12小时', exact: true }).click();
  await page.waitForTimeout(60);
  await page.waitForTimeout(600);
  const samples = await page.evaluate(() => {
    window.__panSampling = false;
    return window.__panSamples;
  });
  const firstChange = samples.find((item) => item.from !== initialFrom);
  const report = {
    inputToFirstFrameMs: firstChange ? firstChange.at - clickedAt : null,
    samples,
    maxNowDriftPx: Math.max(...samples.map((item) => Math.abs(item.drift))),
    maxLayerSpreadPx: Math.max(...samples.map((item) => item.spread)),
  };
  await writeFile('.local/qa/timeline-navigation.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      frames: samples.length,
      inputToFirstFrameMs: report.inputToFirstFrameMs,
      maxNowDriftPx: report.maxNowDriftPx,
      maxLayerSpreadPx: report.maxLayerSpreadPx,
    }),
  );
  assert(
    samples.some((item) => item.moving),
    'Expected a real navigation animation',
  );
  assert(firstChange?.moving, 'Navigation must start its motion in the first changed frame');
  assert(!samples.at(-1).moving, 'Navigation must release completed pan effects');
  assert(
    report.maxNowDriftPx < 2,
    'The live-now line must retain its UTC position throughout navigation',
  );
  assert(
    report.maxLayerSpreadPx < 1,
    'Every temporal layer, including newly mounted rows, must share the same phase',
  );
  const visibleReady = () => {
    const root = document.querySelector('.track-table-scroll'),
      box = root.getBoundingClientRect();
    const lanes = [...root.querySelectorAll('.track-lane')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < box.bottom;
    });
    return lanes.length > 0 && lanes.every((node) => node.getAttribute('aria-busy') === 'false');
  };
  await page.waitForFunction(visibleReady);
  const scroller = page.locator('.track-table-scroll');
  const originalTop = await scroller.evaluate((node) => node.scrollTop);
  const coldAt = Date.now();
  await scroller.evaluate((node) => {
    node.scrollTop += 8 * 116;
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForFunction(visibleReady);
  const coldScrollMs = Date.now() - coldAt;
  const warmAt = Date.now();
  await scroller.evaluate((node, top) => {
    node.scrollTop = top;
  }, originalTop);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert(
    await page.evaluate(visibleReady),
    'Returning to cached rows must paint without a metadata round trip',
  );
  console.log(
    JSON.stringify({
      coldScrollMs,
      cachedReturnMs: Date.now() - warmAt,
      cachedRowsImmediatelyReady: true,
    }),
  );
  const [denseId, tinyId] = await page
    .locator('.track-row')
    .evaluateAll((rows) => rows.slice(0, 2).map((row) => row.dataset.subjectId));
  await page.route('**/api/workbench?*', async (route) => {
    const response = await route.fetch();
    const packet = await response.json();
    const bounds = await page
      .locator('.track-lane')
      .first()
      .evaluate((lane) => ({
        from: Number(lane.dataset.from),
        to: Number(lane.dataset.to),
      }));
    for (const row of packet.rows ?? []) {
      if (row.subjectId !== denseId && row.subjectId !== tinyId) continue;
      row.coverage.fromMs = bounds.from;
      row.coverage.toMs = bounds.to;
      row.coverage.buckets =
        row.subjectId === denseId
          ? Array.from({ length: 720 }, (_, index) => {
              const fromMs = bounds.from + ((bounds.to - bounds.from) * index) / 720;
              const toMs = bounds.from + ((bounds.to - bounds.from) * (index + 1)) / 720;
              return { fromMs, toMs, coveredMs: toMs - fromMs, segmentCount: 100 };
            })
          : [
              {
                fromMs: bounds.from,
                toMs: bounds.to,
                coveredMs: 1,
                segmentCount: 1,
                mediaFromMs: bounds.to - 1,
                mediaToMs: bounds.to,
              },
            ];
    }
    await route.fulfill({ response, json: packet });
  });
  await page.getByRole('slider', { name: '视窗起点', exact: true }).press('Home');
  await page.waitForFunction(
    ({ denseId, tinyId }) => {
      const dense = document.querySelector(`[data-subject-id="${denseId}"] .track-lane`);
      const tiny = document.querySelector(`[data-subject-id="${tinyId}"] .track-lane`);
      if (!dense || !tiny || Number(dense.dataset.to) - Number(dense.dataset.from) !== 7 * 86400000)
        return false;
      const marks = dense.querySelectorAll('.recording-line > .track-clip');
      const mark = tiny.querySelector('.recording-line > .track-clip');
      if (marks.length !== 1 || !mark) return false;
      const rect = mark.getBoundingClientRect(),
        lane = tiny.getBoundingClientRect();
      return rect.width >= 0.99 && rect.right <= lane.right + 0.5 && rect.left >= lane.left;
    },
    { denseId, tinyId },
  );
  await page.waitForTimeout(400);
  console.log(
    JSON.stringify(
      await page.evaluate(
        ({ denseId, tinyId }) => ({
          denseBucketCount: 720,
          denseSurfaceCount: document.querySelectorAll(
            `[data-subject-id="${denseId}"] .recording-line > .track-clip`,
          ).length,
          oneMillisecondMarkerPx: document
            .querySelector(`[data-subject-id="${tinyId}"] .recording-line > .track-clip`)
            .getBoundingClientRect().width,
        }),
        { denseId, tinyId },
      ),
    ),
  );
} finally {
  // Route handlers read page geometry; drain them before disposing that page.
  await page?.unrouteAll({ behavior: 'wait' });
  await browser?.close();
  await fixture.close();
}
