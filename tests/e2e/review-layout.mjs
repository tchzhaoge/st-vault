import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { outputRoot } from './support/media.mjs';

const fixture = await startFixture();
let browser;
try {
  const history = await fixture.seedSnapshotHistory();
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const assertHoverHold = async (selector) => {
    await page.mouse.move(20, 180);
    const box = await page.locator(selector).boundingBox();
    assert(box, `${selector}: interaction region must exist`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1300);
    assert.equal(
      await page.locator('.inline-player').getAttribute('data-chrome'),
      'visible',
      `${selector}: stationary interaction must hold player chrome`,
    );
  };
  // Observe creation in the browser task that starts the slide. A later CDP
  // evaluation may run after its 360ms lifetime and cannot prove it never ran.
  await page.addInitScript(() => {
    window.__snapshotSlides = [];
    const animate = Element.prototype.animate;
    let inputAt = 0;
    for (const event of ['wheel', 'click'])
      document.addEventListener(
        event,
        (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('.snapshot-grid,.snapshot-pages')
          )
            inputAt = performance.now();
        },
        true,
      );
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      if (animation.id === 'snapshot-page-enter')
        window.__snapshotSlides.push({
          startedAt: performance.now(),
          inputAt,
          transform: animation.effect.getKeyframes()[0].transform,
        });
      return animation;
    };
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  await row.waitFor();
  const from = await row.locator('.track-lane').evaluate((node) => Number(node.dataset.from));
  // Include the complete history when this fixture straddles midnight.
  if (history.fromMs < from)
    await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  const lane = await row.locator('.track-lane').boundingBox();
  await page.mouse.move(lane.x + 1, lane.y + 40);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width - 1, lane.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  await page.waitForFunction(() =>
    /^1\s*\/\s*[2-9]/.test(document.querySelector('.snapshot-pages output')?.textContent ?? ''),
  );
  const geometry = () =>
    page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const grid = document.querySelector('.snapshot-grid');
      return {
        titlebar: rect('.topbar'),
        picture: rect('.player-picture'),
        video: rect('video[data-media-slot="active"]'),
        review: rect('.media-review'),
        arrangement: rect('.aligned-arrangement'),
        rail: rect('.connection-rail'),
        railDecoration: getComputedStyle(document.querySelector('.connection-rail'), '::before')
          .content,
        focus: rect('.viewer-focus'),
        tools: rect('.snapshot-pages'),
        grid: rect('.snapshot-viewport'),
        heading: rect('.player-heading'),
        controls: rect('.player-bottom'),
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        rows: getComputedStyle(grid).gridTemplateRows.split(' ').length,
        mounted: grid.querySelectorAll('.snapshot-cell,.snapshot-slot-empty,.snapshot-gap').length,
        fit: getComputedStyle(document.querySelector('video[data-media-slot="active"]')).objectFit,
        nestedCorners: [document.querySelector('.snapshot-viewport')].every(
          (node) =>
            parseFloat(getComputedStyle(node).borderTopLeftRadius) +
              parseFloat(getComputedStyle(document.querySelector('.media-review')).paddingLeft) ===
            parseFloat(
              getComputedStyle(document.querySelector('.media-review')).borderTopLeftRadius,
            ),
        ),
        trackCorners: [
          ...document.querySelectorAll('.viewer-focus .status-line, .viewer-focus .recording-line'),
        ].every(
          (node) =>
            parseFloat(getComputedStyle(node).borderTopLeftRadius) > 0 &&
            getComputedStyle(node).overflowX === 'hidden',
        ),
        imageCorners: [
          ...document.querySelectorAll('.snapshot-cell button[data-unit-index] > div'),
        ].every((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius) > 0),
        cursorUnclipped:
          getComputedStyle(document.querySelector('.focus-lane')).overflowX === 'visible',
      };
    });
  const assertStatusEdges = async () => {
    // Hit testing and bounding boxes do not prove that ancestor corner clips
    // preserve paint. Use a solid track temporarily and sample its real pixels.
    const style = await page.addStyleTag({
      content: `
      .viewer-focus .status-line, .viewer-focus .status-band {
        background: #00ff00 !important; box-shadow: none !important;
      }
      .viewer-focus .status-line::after { display: none !important; }
      .viewer-focus .focus-playhead { visibility: hidden !important; }
    `,
    });
    try {
      const png = await page.locator('.viewer-focus .status-line').screenshot();
      const edges = await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const pixels = [2, image.width - 3].map((x) => [...context.getImageData(x, 1, 1, 1).data]);
        image.close();
        return pixels;
      }, png.toString('base64'));
      assert(
        edges.every(([r, g, b]) => r < 30 && g > 220 && b < 30),
        `Both ends of the thin status track must retain paint: ${JSON.stringify(edges)}`,
      );
    } finally {
      await style.evaluate((node) => node.remove());
    }
  };
  const normal = await geometry();
  await assertStatusEdges();
  assert(
    normal.trackCorners && normal.imageCorners && normal.cursorUnclipped && normal.nestedCorners,
  );
  assert.equal(normal.columns, 5);
  assert.equal(normal.rows, 6);
  assert.equal(normal.mounted, 30);
  assert.equal(
    normal.picture.top,
    normal.arrangement.top,
    'Player and list start below the shared title bar',
  );
  assert.equal(normal.titlebar.left, normal.picture.left);
  assert.equal(normal.titlebar.right, normal.arrangement.right, 'Title bar spans the workspace');
  assert.equal(
    normal.picture.top - normal.titlebar.bottom,
    normal.review.top - normal.picture.bottom,
    'Header and player modules use the same gap',
  );
  assert.equal(
    normal.review.bottom,
    normal.arrangement.bottom,
    'Review and list share the bottom edge',
  );
  assert.equal(normal.picture.left, normal.review.left);
  assert.equal(normal.picture.right, normal.review.right);
  assert.equal(
    normal.arrangement.left - normal.picture.right,
    normal.review.top - normal.picture.bottom,
    'All panel gaps share one size',
  );
  assert.equal(normal.railDecoration, 'none');
  assert(Math.abs(normal.picture.width / normal.picture.height - 16 / 9) < 0.01);
  assert(
    normal.picture.bottom < normal.review.top &&
      normal.focus.bottom <= normal.tools.top &&
      normal.tools.bottom <= normal.grid.top + 1,
    JSON.stringify(normal),
  );
  assert.equal(await page.locator('.snapshot-page-button').count(), 2);
  assert.equal(normal.tools.height, 26);
  assert.equal(await page.locator('.player-heading h2 a').count(), 0);
  assert.equal(await page.locator('.player-avatar-link .subject-avatar').count(), 1);
  await page.screenshot({ path: '.local/qa/review-normal.png' });

  const turn = async (direction, expected) => {
    await page.waitForTimeout(240);
    await page.locator('.snapshot-grid').hover();
    const before = await page.evaluate(() => window.__snapshotSlides.length);
    if (expected === 3)
      await page
        .getByRole('button', { name: direction > 0 ? '下一页' : '上一页', exact: true })
        .click();
    else await page.mouse.wheel(0, direction * 120);
    await page.waitForFunction(
      (index) =>
        document.querySelector('.snapshot-pages output')?.textContent?.startsWith(`${index} / `),
      expected,
    );
    const motions = await page.evaluate((before) => window.__snapshotSlides.slice(before), before);
    assert.equal(motions.length, 1, 'One page action starts exactly one slide');
    assert.equal(motions[0].transform, `translateY(${direction * 100}%)`);
    assert(motions[0].startedAt - motions[0].inputAt < 100, JSON.stringify(motions));
    await page.locator('.snapshot-grid[aria-busy="false"] .snapshot-cell').first().waitFor();
  };
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  let delayPage = true;
  await page.route('**/snapshot-pages?*', async (route) => {
    if (delayPage && new URL(route.request().url()).searchParams.get('page') === '2') {
      delayPage = false;
      await pageGate;
    }
    await route.continue();
  });
  await page.locator('.snapshot-cell img').first().waitFor();
  // Capture pixel identity, not a count that can legitimately grow before the
  // wheel is delivered. Every image decoded now must survive the exit surface;
  // other admitted images may independently finish in the meantime.
  const decodedSources = await page
    .locator('.snapshot-cell img')
    .evaluateAll((images) => images.map((image) => image.currentSrc || image.src));
  const slidesBeforePending = await page.evaluate(() => window.__snapshotSlides.length);
  const checkPending = page
    .waitForRequest(
      (request) =>
        new URL(request.url()).pathname.endsWith('/snapshot-pages') &&
        new URL(request.url()).searchParams.get('page') === '2',
    )
    .then(async () => {
      try {
        await page.waitForTimeout(100);
        assert.match(
          await page.locator('.snapshot-pages output').textContent({ timeout: 1000 }),
          /^2 \/ /,
          'Pending pages retain the navigation catalog and immediately show the target page',
        );
        assert.equal(
          await page.locator('.snapshot-cell').count(),
          0,
          'An unloaded destination must not present old images as its own',
        );
        assert.equal(await page.locator('.snapshot-slot-empty.is-loading').count(), 30);
        const exitingSources = await page
          .locator('.snapshot-page-exit img')
          .evaluateAll((images) => images.map((image) => image.currentSrc || image.src));
        assert(decodedSources.length > 0);
        assert(
          decodedSources.every((source) => exitingSources.includes(source)),
          'Every previously decoded image must slide out while the destination loads',
        );
        assert.equal(
          await page
            .locator('.snapshot-page-exit button')
            .first()
            .evaluate((node) => getComputedStyle(node).opacity),
          '1',
        );
        assert(
          await page.evaluate(
            (before) => window.__snapshotSlides.length > before,
            slidesBeforePending,
          ),
          'The slide starts before the request finishes',
        );
        const durations = await page.evaluate(async () => {
          const exits = document
            .getAnimations()
            .filter((animation) => animation.id === 'snapshot-page-exit');
          const durations = exits.map((animation) => Number(animation.effect.getTiming().duration));
          await Promise.all(exits.map((animation) => animation.finished));
          // onfinish cleanup is dispatched with the next render opportunity.
          await new Promise(requestAnimationFrame);
          return durations;
        });
        assert(
          durations.every((duration) => duration <= 400),
          'The outgoing slide retains its short animation duration',
        );
        assert.equal(
          await page.locator('.snapshot-page-exit').count(),
          0,
          'A slow response must not freeze the outgoing page',
        );
        assert.equal(await page.locator('.snapshot-grid').getAttribute('aria-busy'), 'true');
        assert.match(await page.locator('.snapshot-pages output').textContent(), /^2 \/ /);
        assert.equal(
          await page.getByRole('button', { name: '下一页', exact: true }).isEnabled(),
          true,
        );
      } finally {
        releasePage();
      }
    });
  await Promise.all([turn(1, 2), checkPending]);
  assert.equal(
    await page
      .locator('.snapshot-grid')
      .evaluate(
        (node) =>
          node.getAnimations().filter((animation) => animation.id === 'snapshot-page-enter').length,
      ),
    0,
    'Metadata arriving after the slide only fills cells, without starting another slide',
  );
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.play());
  await page.waitForTimeout(1000);
  assert.match(await page.locator('.snapshot-pages output').textContent(), /^2 \/ /);
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  const selectedKey = await page.locator('.snapshot-cell').first().getAttribute('data-key');
  await turn(1, 3);
  await turn(-1, 2);
  await page.locator(`.snapshot-cell[data-key="${selectedKey}"]`).waitFor();
  await page.evaluate(() => {
    window.__reviewBoard = document.querySelector('.media-review');
  });
  await assertHoverHold('.player-heading');
  await assertHoverHold('.player-bottom');
  await page
    .locator('.player-picture')
    .dispatchEvent('pointermove', { clientX: 100, clientY: 100 });
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.mouse.move(10, 100);
  const full = await geometry();
  await assertStatusEdges();
  assert(full.trackCorners && full.imageCorners && full.cursorUnclipped && full.nestedCorners);
  assert.equal(full.columns, 3);
  assert.equal(full.rows, 10);
  assert.equal(full.mounted, 30);
  assert.equal(full.fit, 'contain');
  assert.equal(full.video.width, 1440);
  assert.equal(full.video.height, 900);
  assert.equal(full.review.top, 0);
  assert.equal(full.review.bottom, 900);
  assert.equal(full.review.right, 1440);
  assert(
    await page.locator('.media-review').evaluate((node) => {
      const box = node.getBoundingClientRect();
      // The sidebar must win hit testing even where title and control bars overlap it.
      return [12, innerHeight - 12].every((y) =>
        node.contains(document.elementFromPoint(box.right - 12, y)),
      );
    }),
  );
  assert(
    full.focus.bottom <= full.tools.top && full.tools.bottom <= full.grid.top + 1,
    JSON.stringify(full),
  );
  assert(
    await page.evaluate(() => window.__reviewBoard === document.querySelector('.media-review')),
  );
  await assertHoverHold('.player-heading');
  await assertHoverHold('.player-bottom');
  await page.locator('.media-review').hover();
  await page.waitForFunction(
    () => document.querySelector('.inline-player').dataset.chrome === 'hidden',
  );
  await page.mouse.wheel(0, 0);
  assert.equal(await page.locator('.inline-player').getAttribute('data-chrome'), 'hidden');
  await page.waitForTimeout(1300);
  await page.locator('.media-review').waitFor({ state: 'visible' });
  await page.screenshot({ path: '.local/qa/review-fullscreen.png' });
  await page.getByRole('button', { name: '收起截图面板', exact: true }).click();
  await page.locator('.media-review').waitFor({ state: 'hidden' });
  assert(await page.locator('.media-review').evaluate((node) => node.inert));
  const tab = await page.locator('.review-toggle').boundingBox();
  assert.equal(tab.x + tab.width, 1440);
  assert.equal(await page.locator('.inline-player').getAttribute('data-chrome'), 'hidden');
  await page.getByRole('button', { name: '展开截图面板', exact: true }).click();
  await page.locator('.media-review').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.media-review').evaluate((node) => node.inert), false);
  assert(
    await page.evaluate(() => window.__reviewBoard === document.querySelector('.media-review')),
  );
  await turn(1, 3);
  assert.equal(await page.locator('.snapshot-actions button').count(), 2);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  const restored = await geometry();
  assert.equal(restored.columns, 5);
  assert.equal(restored.rows, 6);
  assert.equal(await page.locator('[data-virtualized],[data-virtual-spacer]').count(), 0);
  await page.locator('.inline-player').evaluate((node) => node.requestFullscreen());
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.getByRole('button', { name: '关闭播放器', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('video'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: '显示停机时段', exact: true }).count(), 0);
  assert.equal(await page.locator('.program-events, .program-gap, .program-marker').count(), 0);
  console.log(
    JSON.stringify({
      passed: true,
      normal,
      full,
      wheelPaging: true,
      pageIdentityRetained: true,
      manualSidebarVisibility: true,
    }),
  );
} finally {
  await browser?.close();
  await fixture.close();
}
