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
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  const clickChrome = async (name) => {
    const control = page.getByRole('button', { name, exact: true, includeHidden: true });
    // Moving to the picture's center starts the one-second idle deadline.
    // Move to the real control instead: its hover region keeps chrome awake
    // while Playwright waits for the animated control to become actionable.
    const point = await control.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await control.hover();
    await control.click();
  };
  await clickChrome('全屏播放');
  await page.waitForFunction(() => !!document.fullscreenElement);
  const verify = async (expanded) => {
    await page.waitForFunction((expanded) => {
      const root = document.querySelector('.inline-player');
      const picture = root.querySelector('.player-picture').getBoundingClientRect();
      const review = root.querySelector('.media-review').getBoundingClientRect();
      const right = expanded ? review.left : picture.right;
      return [...root.querySelectorAll('.player-chrome')].every(
        (node) => Math.abs(node.getBoundingClientRect().right - right) < 1,
      );
    }, expanded);
    const geometry = await page.evaluate(() => {
      const root = document.querySelector('.inline-player');
      const box = (selector) => root.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        picture: box('.player-picture'),
        heading: box('.player-heading'),
        identity: box('.player-identity'),
        avatar: box('.player-avatar-link'),
        name: box('.player-identity-text'),
        bottom: box('.player-bottom'),
        firstControl: box('.player-control--primary'),
        lastControl: box('.fullscreen-button'),
        shade: parseFloat(getComputedStyle(root.querySelector('.player-picture'), '::after').right),
      };
    });
    assert.equal(geometry.heading.left, geometry.picture.left);
    assert.equal(geometry.bottom.left, geometry.picture.left);
    assert.ok(Math.abs(geometry.heading.width - geometry.bottom.width) < 1);
    assert.ok(
      Math.abs(
        geometry.identity.left +
          geometry.identity.width / 2 -
          (geometry.heading.left + geometry.heading.width / 2),
      ) < 1,
      'identity stays centered',
    );
    assert.ok(
      Math.abs(
        (geometry.avatar.left + geometry.name.right) / 2 -
          (geometry.heading.left + geometry.heading.width / 2),
      ) < 1,
      'avatar and name remain centered as a group',
    );
    assert.ok(geometry.firstControl.left - geometry.bottom.left < 20, 'left controls stay left');
    assert.ok(geometry.bottom.right - geometry.lastControl.right < 20, 'right controls stay right');
    assert.ok(
      Math.abs(geometry.shade - (geometry.picture.right - geometry.heading.right)) < 1,
      'heading shade uses the same available width',
    );
  };
  await verify(true);
  // The fullscreen control remains reachable with the sidebar expanded.
  await page.mouse.move(100, 30);
  await page.getByRole('button', { name: '收起截图面板', exact: true }).click();
  await verify(false);
  await page.getByRole('button', { name: '展开截图面板', exact: true }).click();
  await verify(true);
  await clickChrome('退出全屏');
  await page.waitForFunction(() => !document.fullscreenElement);
  await verify(false);
  console.log(
    'Fullscreen chrome fits beside the sidebar; collapse and normal layout restore full width.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
