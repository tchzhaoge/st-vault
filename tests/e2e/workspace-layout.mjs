import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const styles = await Promise.all(
  [
    'apps/ui/src/design/tokens.css',
    'apps/ui/src/style.css',
    'apps/ui/src/features/player/player-controls.css',
    'apps/ui/src/features/timeline/timeline.css',
    'apps/ui/src/design/liquid-glass.css',
    'apps/ui/src/design/panels.css',
    'apps/ui/src/design/player-overlays.css',
  ].map((file) => readFile(file, 'utf8')),
);
const browser = await chromium.launch({
  executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
  headless: true,
});
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({ hasTouch: touch });
    const page = await context.newPage();
    for (const [width, height] of [
      [1440, 900],
      [1280, 720],
      [1920, 1080],
      [900, 900],
      [768, 1024],
      [1024, 768],
      [800, 600],
    ])
      for (const english of [false, true]) {
        await page.setViewportSize({ width, height });
        await page.setContent(
          `<style>${styles.join('\n')}</style><main class="app-shell studio-shell"><header class="topbar"><div class="brand"><img alt="ST" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><span>ST Vault</span></div><nav class="header-tools">${(english ? ['Settings', 'Status', 'History'] : ['设置', '状态', '历史']).map((label) => `<div class="header-tool"><button class="tool-trigger" aria-label="${label}"><svg class="ui-icon"></svg><span class="tool-label">${label}</span></button></div>`).join('')}<button class="logout-button" aria-label="Exit"><svg class="ui-icon"></svg><span>${english ? 'Logout' : '退出'}</span></button></nav></header><div class="studio-workspace"><aside class="studio-viewer"><section class="inline-player"><div class="player-stage"><div class="player-picture"></div></div><div class="media-review"></div></section></aside><section class="aligned-arrangement"></section><div class="connection-rail"></div></div></main>`,
        );
        const boxes = await page.evaluate(() => {
          const rect = (selector) => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
            };
          };
          return {
            header: rect('.topbar'),
            viewer: rect('.studio-viewer'),
            list: rect('.aligned-arrangement'),
            picture: rect('.player-picture'),
            review: rect('.media-review'),
            tools: rect('.header-tools'),
            visibleLabels: [
              ...document.querySelectorAll('.tool-label, .logout-button > span'),
            ].filter((label) => label.getBoundingClientRect().width > 0).length,
            gap: parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue('--workspace-gap'),
            ),
            radii: ['.topbar', '.player-stage', '.media-review', '.aligned-arrangement'].map(
              (selector) => getComputedStyle(document.querySelector(selector)).borderTopLeftRadius,
            ),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        const near = (a, b, label) =>
          assert(
            Math.abs(a - b) < 1,
            JSON.stringify({ width, height, english, label, a, b, boxes }),
          );
        near(boxes.header.left, boxes.viewer.left, 'header/player left');
        near(boxes.header.right, boxes.list.right, 'header/timeline right');
        assert.equal(boxes.visibleLabels, 4, 'Toolbar labels remain visible');
        assert(
          boxes.tools.right <= boxes.header.right + 1,
          JSON.stringify({ width, height, english, boxes }),
        );
        assert(!boxes.overflow, JSON.stringify({ width, height, english, boxes }));
        assert.equal(new Set(boxes.radii).size, 1, 'Main module corners share one radius');
        near(boxes.list.top, boxes.viewer.top, 'top alignment');
        near(boxes.list.bottom, boxes.viewer.bottom, 'bottom alignment');
        near(boxes.viewer.top - boxes.header.bottom, boxes.gap, 'header gap');
        near(boxes.list.left - boxes.viewer.right, boxes.gap, 'column gap');
        near(boxes.review.top - boxes.picture.bottom, boxes.gap, 'player/review gap');
        console.log(
          JSON.stringify({
            touch,
            width,
            height,
            english,
            headerWidth: boxes.header.width,
            listHeight: boxes.list.height,
          }),
        );
      }
    await context.close();
  }
} finally {
  await browser.close();
}
