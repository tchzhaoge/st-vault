import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { outputRoot } from './support/media.mjs';
let releaseGc;
const gate = new Promise((resolve) => {
  releaseGc = resolve;
});
let paused = true;
const fixture = await startFixture({
  beforeUnlink: async () => {
    if (paused) await gate;
  },
});
let browser, page;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Shanghai',
  });
  const origin = 'http://127.0.0.1:10085';
  const setup = await context.request.post(origin + '/api/login', {
    data: { pin: '012345' },
    headers: { origin },
  });
  assert.equal(setup.status(), 200);
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.goto(origin);
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  await page.locator('.snapshot-cell').first().waitFor();
  await page.locator('.snapshot-cell button[data-unit-index]').first().click();
  await page.locator('.player-mode-badge.is-archive').waitFor();
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.snapshot-cell img')].filter(
        (img) => img.complete && img.naturalWidth > 0,
      ).length >= 2,
  );
  const wake = async () => {
    await page.locator('.snapshot-section').hover({ position: { x: 12, y: 60 } });
    await page
      .locator('.snapshot-section')
      .dispatchEvent('pointermove', { clientX: Date.now() % 10000, clientY: 500 });
  };
  await wake();
  await page.locator('.snapshot-favorite').nth(1).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.snapshot-favorite[aria-pressed="true"]').length === 1 &&
      document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'false',
  );
  await wake();
  await page
    .locator('.snapshot-actions')
    .getByRole('button', { name: '删除所有非喜欢', exact: true })
    .click();
  await page.getByRole('dialog', { name: '删除所有非喜欢', exact: true }).waitFor();
  await page.evaluate(() => {
    const grid = document.querySelector('.snapshot-grid');
    window.__oldVideo = document.querySelector('video[data-media-slot="active"]');
    window.__oldShots = new Map(
      [...grid.querySelectorAll('.snapshot-cell')].map((node) => [
        Number(node.dataset.at),
        { node, url: node.querySelector('img')?.src },
      ]),
    );
    window.__mediaAnimations = [];
    window.__blankFrames = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (options?.id?.startsWith('media-'))
        window.__mediaAnimations.push({ id: options.id, grid: !!this.closest('.snapshot-grid') });
      return animate.call(this, frames, options);
    };
    window.__observeShots = new MutationObserver(() => {
      if (!grid.querySelector('.snapshot-cell')) window.__blankFrames++;
    });
    window.__observeShots.observe(grid, { childList: true, subtree: true });
  });
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/deletion-intents') && response.request().method() === 'POST',
  );
  const continuation = page.waitForRequest(
    (request) => request.url().endsWith('/api/playback') && request.method() === 'POST',
  );
  const deleteStarted = Date.now();
  const stages = [];
  const track = (request) => {
    if (
      request.url().includes('/recording-bounds') ||
      request.url().includes('/api/playback') ||
      request.url().includes('/api/media/')
    )
      stages.push({ path: new URL(request.url()).pathname, ms: Date.now() - deleteStarted });
  };
  page.on('request', track);
  const replies = [];
  const trackReply = (response) => {
    if (response.url().includes('/api/playback') || response.url().includes('/api/media/'))
      replies.push({
        path: new URL(response.url()).pathname,
        ms: Date.now() - deleteStarted,
        status: response.status(),
      });
  };
  page.on('response', trackReply);
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  assert.equal((await accepted).status(), 202);
  const acceptedMs = Date.now() - deleteStarted;
  await continuation;
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video !== window.__oldVideo && video.readyState >= 2;
  });
  const resumedMs = Date.now() - deleteStarted;
  page.off('request', track);
  page.off('response', trackReply);
  const frameInfo = await page.locator('video[data-media-slot="active"]').evaluate((video) => ({
    time: video.currentTime,
    paused: video.paused,
    buffered: Array.from({ length: video.buffered.length }, (_, i) => [
      video.buffered.start(i),
      video.buffered.end(i),
    ]),
  }));
  console.log(
    JSON.stringify({
      event: 'delete_playback_timing',
      acceptedMs,
      resumedMs,
      acceptedToFrameMs: resumedMs - acceptedMs,
      stages,
      replies,
      frameInfo,
    }),
  );
  await page.waitForFunction(() => !document.querySelector('[data-motion-exit]'));
  const continuity = await page.evaluate(() => {
    window.__observeShots.disconnect();
    const kept = [...document.querySelectorAll('.snapshot-cell')].filter((node) =>
      window.__oldShots.has(Number(node.dataset.at)),
    );
    return {
      kept: kept.length,
      sameNodes: kept.every((node) => window.__oldShots.get(Number(node.dataset.at)).node === node),
      samePixels: kept.every(
        (node) =>
          window.__oldShots.get(Number(node.dataset.at)).url === node.querySelector('img')?.src,
      ),
      blanks: window.__blankFrames,
      moves: window.__mediaAnimations.filter((event) => event.id === 'media-layout' && event.grid)
        .length,
    };
  });
  assert(continuity.kept > 0);
  assert(continuity.sameNodes);
  assert(continuity.samePixels);
  assert.equal(continuity.blanks, 0);
  assert(continuity.moves > 0);
  await page.getByRole('button', { name: '状态', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '状态', exact: true });
  const task = panel.locator('.archive-activity');
  await task.waitFor();
  assert.match(await task.innerText(), /00 演示直播/);
  assert.match(await task.innerText(), /已处理.*分片/);
  assert.match(await task.innerText(), /\d+%/);
  assert.equal(
    await task.locator('.overflow-text').evaluate((node) => getComputedStyle(node).whiteSpace),
    'nowrap',
  );
  await panel
    .locator('.panel-section')
    .first()
    .screenshot({ path: path.join(outputRoot, 'media-transition-progress.png') });
  await page.getByRole('button', { name: '状态', exact: true }).click();
  paused = false;
  releaseGc();
  await page.waitForFunction(
    () =>
      document.querySelector('button[aria-label="状态"]')?.getAttribute('aria-busy') === 'false',
  );
  await page.getByRole('button', { name: '状态', exact: true }).click();
  assert.equal(await page.locator('.archive-activity').count(), 0);
  await page.getByRole('button', { name: '状态', exact: true }).click();
  await wake();
  await wake();
  await page.getByRole('button', { name: '取消所有喜欢', exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector('.snapshot-favorite[aria-pressed="true"]') &&
      document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'false',
  );
  await wake();
  await page
    .locator('.snapshot-actions')
    .getByRole('button', { name: '删除所有非喜欢', exact: true })
    .click();
  const allAccepted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/deletion-intents') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  assert.equal((await allAccepted).status(), 202);
  await page.waitForFunction(() => !document.querySelector('.snapshot-cell'));
  const { info } = fixture;
  const remaining = await context.request.get(
    `${origin}/api/subjects/${encodeURIComponent(info.subjectId)}/snapshot-pages?at=${info.archiveStart}&from=${info.archiveStart}&to=${info.archiveEnd}&page=1&limit=30`,
  );
  assert.equal(remaining.status(), 200);
  assert.equal((await remaining.json()).total, 0);
  await page.waitForFunction(() => !document.querySelector('video[data-media-slot="active"]'));
  assert.deepEqual(errors, []);
  const report = {
    synthetic: true,
    continuity,
    progressObserved: true,
    allSelectedFootageGone: true,
    decoderReleased: true,
    errors,
    passed: true,
  };
  await writeFile(
    path.join(outputRoot, 'media-transition-validation.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputRoot, 'media-transition-failure.png') });
  throw error;
} finally {
  paused = false;
  releaseGc();
  await browser?.close();
  await fixture.close();
}
