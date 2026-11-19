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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page
    .locator(`.track-row[data-subject-id="${fixture.info.subjectId}"] .subject-preview`)
    .click();
  await page.locator('.range-selection[aria-hidden="false"]').waitFor();
  await page.waitForTimeout(600);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: '前12小时', exact: true }).click();
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => {
    window.__selectionFrames = [];
    window.__selectionSampling = true;
    window.__selectionClock = setInterval(
      () => window.dispatchEvent(new CustomEvent('stv-display-clock', { detail: Date.now() })),
      40,
    );
    const sample = () => {
      const selection = document.querySelector('.range-selection');
      const scene = document.querySelector('.timeline-grid > .timeline-scene');
      const lane = document.querySelector('.track-lane');
      if (selection && scene && lane) {
        const from = Number(lane.dataset.from),
          to = Number(lane.dataset.to),
          at = Number(selection.dataset.from);
        const anchor = scene.getBoundingClientRect();
        const expected = anchor.left + ((at - from) / (to - from)) * scene.clientWidth;
        window.__selectionFrames.push({
          span: to - from,
          drift: selection.getBoundingClientRect().left - expected,
          moving: scene
            .getAnimations()
            .some((a) => a.id === 'timeline-pan' && a.playState === 'running'),
        });
      }
      if (window.__selectionSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: '后12小时', exact: true }).click();
  await page.waitForTimeout(70);
  await page.getByRole('button', { name: '后12小时', exact: true }).click();
  await page.waitForTimeout(850);
  await page.getByRole('button', { name: '前12小时', exact: true }).click();
  await page.waitForTimeout(70);
  await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  await page.waitForTimeout(120);
  await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: '后12小时', exact: true }).click();
  await page.waitForTimeout(650);
  const frames = await page.evaluate(() => {
    window.__selectionSampling = false;
    clearInterval(window.__selectionClock);
    return window.__selectionFrames;
  });
  const maxDrift = Math.max(...frames.map((frame) => Math.abs(frame.drift)));
  console.log(
    JSON.stringify({
      frames: frames.length,
      maxDrift,
      movingFrames: frames.filter((frame) => frame.moving).length,
      spans: [...new Set(frames.map((frame) => frame.span))],
    }),
  );
  assert(
    new Set(frames.map((frame) => frame.span)).size > 1,
    'Exercise a span resize while the navigation animation is running',
  );
  assert(
    frames.some((frame) => frame.moving),
    'View navigation must keep its real pan animation',
  );
  assert(
    maxDrift < 3,
    'Live selection must remain in the timeline coordinate system during returning and interrupted pans',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
