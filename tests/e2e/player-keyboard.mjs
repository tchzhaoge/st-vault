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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  await page.locator('.snapshot-cell button[data-unit-index]').first().click();
  await page.locator('.player-mode-badge.is-archive').waitFor();
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  const lane = page.locator('.focus-lane');
  const at = async () => Number(await lane.getAttribute('aria-valuenow'));
  const pauseAt = async (seconds = 15) => {
    await page.evaluate((seconds) => {
      const video = document.querySelector('video[data-media-slot="active"]');
      video.pause();
      video.currentTime = seconds;
    }, seconds);
    await page.waitForFunction(() => {
      const video = document.querySelector('video[data-media-slot="active"]');
      return !video.seeking && video.paused;
    });
    return at();
  };
  const seek = async (key, delta) => {
    const before = await at();
    await page.keyboard.press(key);
    await page.waitForFunction(
      ({ before, delta }) =>
        Math.abs(
          Number(document.querySelector('.focus-lane').getAttribute('aria-valuenow')) -
            before -
            delta,
        ) < 500,
      { before, delta },
    );
  };
  await pauseAt();
  // Ordinary focus outside the player no longer disables navigation.
  await page.locator('.subject-preview').first().focus();
  await seek('ArrowRight', 5000);
  await seek('ArrowLeft', -5000);
  // The native progress slider owns its key, but uses exactly the same step.
  await lane.focus();
  await seek('ArrowRight', 5000);
  const before = await at();
  await page.keyboard.press('Control+ArrowLeft');
  assert.equal(await at(), before);
  // Open popovers block global shortcuts, including when focus escapes the panel.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.toolbar-popover[data-state="open"]').waitFor();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await at(), before);
  await page.keyboard.press('Escape');
  // Real input focus retains caret navigation.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'qa-keyboard-input';
    input.value = 'text';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('ArrowLeft');
  assert.equal(await at(), before);
  await page.locator('#qa-keyboard-input').evaluate((input) => input.remove());
  // Fullscreen reuses the document dispatcher; focus on an ordinary control works.
  await page.locator('.player-picture').hover();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.locator('.inline-player').focus();
  await seek('ArrowLeft', -5000);
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  await page.waitForFunction(
    (target) =>
      Math.abs(
        Number(document.querySelector('.focus-lane').getAttribute('aria-valuenow')) - target,
      ) < 500,
    before + 5000,
  );
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      externalFocus: true,
      sliderStepSeconds: 5,
      inputAndDialogProtected: true,
      repeatedSeek: true,
      fullscreen: true,
    }),
  );
} finally {
  await browser?.close();
  await fixture.close();
}
