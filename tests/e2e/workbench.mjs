import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { outputRoot } from './support/media.mjs';
import { startFixture } from './support/fixture.mjs';
import { verifySnapshotRoll, installSnapshotClockGate } from './support/snapshot-roll.mjs';
import { verifyRoutingPresentation } from './support/routing-presentation.mjs';

const origin = 'http://127.0.0.1:10085';
const report = {
  synthetic: true,
  productionCredentialsRead: false,
  checks: {},
  passed: false,
};
const errors = [],
  serverErrors = [],
  externalRequests = [];
const retiredRequests = [];
let fixture, browser, context, page;
let interrupted;
const interrupt = (signal) => {
  interrupted = signal;
  // Closing the owned browser releases an active Playwright wait into teardown.
  if (browser)
    void browser.close().catch((error) => {
      console.error(`[qa] Browser interruption cleanup failed: ${error.message}`);
    });
};
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
await mkdir(outputRoot, { recursive: true });
try {
  fixture = await startFixture();
  if (interrupted) throw new Error(`QA interrupted by ${interrupted}`);
  const { info } = fixture;
  assert.equal(info.synthetic, true);
  assert.equal(info.productionCredentialsRead, false);
  assert.equal(info.subjectCount, 300);
  const launch = { headless: true };
  if (process.env.STV_QA_BROWSER_EXECUTABLE)
    launch.executablePath = process.env.STV_QA_BROWSER_EXECUTABLE;
  else if (process.env.STV_QA_BROWSER_CHANNEL) launch.channel = process.env.STV_QA_BROWSER_CHANNEL;
  try {
    browser = await chromium.launch(launch);
    if (interrupted) throw new Error(`QA interrupted by ${interrupted}`);
  } catch (error) {
    throw new Error(
      `Browser launch failed. Install cached Chromium with: node node_modules/playwright-core/cli.js install chromium; or set STV_QA_BROWSER_CHANNEL=chrome / STV_QA_BROWSER_EXECUTABLE. ${error.message}`,
      { cause: error },
    );
  }
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Shanghai',
  });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  page = await context.newPage();
  await installSnapshotClockGate(page);
  await context.route('**/api/account-sync', (route) =>
    route.fulfill({
      json: {
        connected: true,
        running: false,
        needsReconnect: false,
        lastAttemptMs: Date.now(),
        lastSuccessMs: Date.now(),
        nextAttemptMs: null,
        lastImportedCount: 299,
        error: null,
        profile: { username: 'qa_user', followingCount: 299, avatarUrl: null },
      },
    }),
  );
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/me/watch-'))
      retiredRequests.push(request.url());
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 500)
      serverErrors.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  await context.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    window.__qaInterruptedPlay = 0;
    window.__qaPanAnimations = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (args[1]?.id === 'timeline-pan') window.__qaPanAnimations++;
      return animate.apply(this, args);
    };
    HTMLMediaElement.prototype.play = function (...args) {
      const pending = play.apply(this, args);
      if (!window.__qaInterruptedPlay && this.dataset.mediaSlot === 'active') {
        window.__qaInterruptedPlay++;
        // Keep the simulated continuation in the returned promise so source
        // teardown cannot leave an unowned native play() rejection in the test.
        return pending
          .then(() => play.call(this))
          .then(() => {
            throw new DOMException('Synthetic superseded play request', 'AbortError');
          });
      }
      return pending;
    };
  });
  const lane = () => page.locator(`[data-subject-id="${info.subjectId}"] .track-lane`);
  const view = () =>
    lane().evaluate((element) => ({
      from: Number(element.dataset.from),
      to: Number(element.dataset.to),
    }));
  const revealInterval = async (range) => {
    const domain = await view();
    await page.locator('.track-table-scroll').evaluate(
      (node, fraction) => {
        const plot = node.querySelector('.track-lane'),
          label = node.querySelector('.track-label');
        node.scrollLeft =
          fraction * plot.getBoundingClientRect().width -
          (node.clientWidth - label.getBoundingClientRect().width) / 2;
        node.dispatchEvent(new Event('scroll'));
      },
      ((range.fromMs + range.toMs) / 2 - domain.from) / (domain.to - domain.from),
    );
    await page.waitForFunction(
      () =>
        Math.abs(
          parseFloat(
            document
              .querySelector('.track-header-viewport')
              ?.style.getPropertyValue('--track-scroll-left') || '0',
          ) - document.querySelector('.track-table-scroll')?.scrollLeft,
        ) < 0.5,
    );
  };
  const active = () => page.locator('video[data-media-slot="active"]');
  const wakeSnapshots = async () => {
    if (await page.evaluate(() => !!document.fullscreenElement)) {
      await page
        .locator('.inline-player')
        .dispatchEvent('pointermove', { clientX: 100, clientY: 100 });
    }
    await page.locator('.snapshot-pages').waitFor({ state: 'visible' });
  };
  const turnSnapshots = async (direction) => {
    await wakeSnapshots();
    await page.waitForTimeout(240);
    await page.locator('.snapshot-grid').hover();
    await page.mouse.wheel(0, direction * 120);
  };
  const wakeChrome = async () => {
    const box = await page.locator('.player-picture').boundingBox();
    assert(box, 'Player picture must exist before waking controls');
    // Move inside the picture body, outside hover-held overlay regions.
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.move(box.x + 21, box.y + box.height / 2);
    await page.waitForFunction(() => {
      const heading = document.querySelector('.player-heading');
      const bottom = document.querySelector('.player-bottom');
      return (
        document.querySelector('.player-picture').dataset.chrome === 'visible' &&
        bottom &&
        getComputedStyle(bottom).opacity === '1' &&
        getComputedStyle(bottom).transform === 'none' &&
        (!heading ||
          (getComputedStyle(heading).opacity === '1' &&
            getComputedStyle(heading).transform === 'none'))
      );
    });
  };
  const verifyPanel = async () => {
    const openPanel = '.toolbar-popover[data-state="open"]';
    // Resize handling and portal placement settle on a browser frame.
    await page.waitForFunction((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return (
        box?.width &&
        box.left >= 0 &&
        box.right <= innerWidth &&
        box.top >= 0 &&
        box.bottom <= innerHeight
      );
    }, openPanel);
    const result = await page.locator(openPanel).evaluate((panel) => {
      const title = panel.querySelector(':scope > header h2');
      const body = panel.querySelector(':scope > .panel-content');
      const bounds = panel.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const closeBox = panel.querySelector(':scope > header button').getBoundingClientRect();
      return {
        titleSize: parseFloat(getComputedStyle(title).fontSize),
        sectionsBelowTitle: [...panel.querySelectorAll('.panel-section h3')].every(
          (node) =>
            parseFloat(getComputedStyle(node).fontSize) <
            parseFloat(getComputedStyle(title).fontSize),
        ),
        fits:
          bounds.left >= 0 &&
          bounds.right <= innerWidth &&
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight,
        noHorizontalOverflow: body.scrollWidth <= body.clientWidth + 1,
        headerAligned:
          Math.abs(titleBox.top + titleBox.height / 2 - closeBox.top - closeBox.height / 2) < 1 &&
          closeBox.left > titleBox.right,
      };
    });
    assert.equal(result.titleSize, 16);
    assert(
      result.sectionsBelowTitle &&
        result.fits &&
        result.noHorizontalOverflow &&
        result.headerAligned,
      JSON.stringify(result),
    );
  };
  const day = 86400000,
    dayStart = (at) => Math.floor((at + 8 * 3600000) / day) * day - 8 * 3600000;
  const currentHalfDayEnd = (at) => dayStart(at) + (at - dayStart(at) < day / 2 ? day / 2 : day);
  await page.goto(origin);
  await page.locator('.auth-card').waitFor();
  assert.equal(await page.locator('.auth-card select, .auth-card .language-setting').count(), 0);
  await page.getByRole('button', { name: '中文 / English', exact: true }).click();
  await page.getByLabel('6-digit PIN', { exact: true }).waitFor();
  await page.getByRole('button', { name: '中文 / English', exact: true }).click();
  await page.getByLabel('6 位 PIN', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputRoot, 'auth-setup.png') });
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await lane().waitFor();
  await page.locator('.account-trigger-info strong').filter({ hasText: 'qa_user' }).waitFor();
  assert.match(await page.locator('.account-trigger-info').innerText(), /关注 299 位/);
  assert.equal(await page.locator('.subject-filters button').count(), 3);
  await page.locator('.subject-filters').getByRole('button', { name: '归档', exact: true }).click();
  await page.waitForSelector('[data-subject-id="stripchat:300"]');
  assert.equal(await page.locator('.track-row').count(), 1);
  assert.equal(await page.locator('.track-row').getByRole('switch').count(), 0);
  await page.locator('.subject-filters').getByRole('button', { name: '在线', exact: true }).click();
  await lane().waitFor();
  await page
    .locator('.directory')
    .screenshot({ path: path.join(outputRoot, 'account-filters.png') });
  report.checks.accountFilters = {
    username: true,
    followingCount: true,
    archivedMembership: true,
    threeGroups: true,
  };
  const playerSpacing = () =>
    page.evaluate(
      () =>
        document.querySelector('.viewer-focus').getBoundingClientRect().top -
        document.querySelector('.player-picture').getBoundingClientRect().bottom,
    );
  assert(
    (await playerSpacing()) <= 16,
    'empty favorites and range placeholders must not reserve vertical space',
  );
  report.checks.playerLayout = { idleGap: await playerSpacing(), brandIsDisplayOnly: true };
  const surfaceColors = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return ['--page', '--panel', '--panel-raised', '--input', '--glass-fill', '--glass-clear'].map(
      (name) => css.getPropertyValue(name).trim(),
    );
  });
  for (const color of surfaceColors) {
    const rgb = color
      .slice(1, 7)
      .match(/../g)
      .map((value) => parseInt(value, 16));
    assert(Math.max(...rgb) - Math.min(...rgb) <= 1, `surface has a color cast: ${color}`);
  }
  report.checks.neutralSurfaces = true;
  const controlBackground = await page.locator('.player-bottom').evaluate((bottom) => {
    const actions = getComputedStyle(bottom.querySelector('.player-actions'));
    return {
      gradient: getComputedStyle(bottom).backgroundImage.includes('linear-gradient'),
      plainActions:
        actions.backgroundImage === 'none' &&
        actions.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        actions.boxShadow === 'none' &&
        actions.borderRadius === '0px' &&
        actions.borderBottomWidth === '0px',
    };
  });
  assert.deepEqual(controlBackground, { gradient: true, plainActions: true });
  assert.equal(await page.locator('.viewer-focus .timeline-ruler').count(), 0);
  assert.equal(
    await page.locator('.viewer-focus').evaluate((node) => node.getBoundingClientRect().height),
    32,
  );
  assert.equal(await page.getByLabel('所选跨度', { exact: true }).count(), 0);
  await page.mouse.move(1430, 10);
  assert.equal(await page.locator('.player-heading').count(), 0);
  await wakeChrome();
  assert.equal(await page.locator('.player-heading').count(), 0);
  for (const text of await page.locator('.selection-summary time strong').allTextContents())
    assert.match(text, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(await page.locator('a.brand').count(), 0);
  await page.getByLabel('播放器待机').waitFor({ state: 'visible' });
  assert.match(
    await page.locator('.player-picture .playback-status-content').textContent(),
    /点击主播/,
  );
  let current = await view();
  assert.equal(current.from, currentHalfDayEnd(Date.now()) - day);
  assert.equal(current.to - current.from, day);
  const initial = current;
  await page.waitForTimeout(1100);
  assert.deepEqual(await view(), initial);
  assert.equal(await page.locator('.time-range-control input[type="range"]').count(), 0);
  assert.equal(await page.locator('.time-control-row').count(), 1);
  assert.equal(await page.locator('.control-caption').count(), 0);
  assert.equal(await page.locator('.header-tools [aria-label="账户"]').count(), 0);
  assert.equal(await page.locator('.header-tools [aria-label="密钥"]').count(), 0);
  assert.equal(await page.locator('.directory [aria-label="账户"] svg').count(), 1);
  assert.equal(await page.locator('.player-actions [aria-label="密钥"]').count(), 1);
  const glassStyle = await page.locator('.topbar').evaluate((node) => {
    const style = getComputedStyle(node),
      root = getComputedStyle(document.documentElement);
    // Neutral colors can be minified to names such as `silver`; parse browser
    // colors rather than assuming every token stays in hexadecimal notation.
    const color = (key) => {
      const probe = document.createElement('span');
      probe.style.color = root.getPropertyValue(key).trim();
      node.append(probe);
      const values = getComputedStyle(probe)
        .color.match(/[\d.]+/g)
        .map(Number);
      probe.remove();
      return [...values.slice(0, 3).map((value) => value / 255), values[3] ?? 1];
    };
    const rgb = (key) => color(key).slice(0, 3);
    const luminance = (values) =>
      values
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) =>
      (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    return {
      blur: style.backdropFilter,
      radius: style.borderRadius,
      textContrast: ratio(rgb('--muted'), rgb('--glass-solid')),
      brightBackdropContrast: ratio(
        rgb('--muted'),
        rgb('--glass-fill').map((value) => {
          const alpha = color('--glass-fill')[3];
          return (value * alpha + 1 - alpha) * (1 - 22 / 255) + 22 / 255;
        }),
      ),
      primaryContrast: ratio([1, 1, 1], rgb('--accent')),
      subtleTextContrast: ratio(
        rgb('--subtle'),
        rgb('--glass-fill').map((value) => {
          const alpha = color('--glass-fill')[3];
          return (value * alpha + 1 - alpha) * (1 - 22 / 255) + 22 / 255;
        }),
      ),
      rowBlur: getComputedStyle(document.querySelector('.track-row')).backdropFilter,
    };
  });
  assert.match(glassStyle.blur, /blur/);
  assert.equal(
    glassStyle.radius,
    await page
      .locator('.aligned-arrangement')
      .evaluate((node) => getComputedStyle(node).borderRadius),
    'Title bar and main modules share one surface radius',
  );
  assert.equal(glassStyle.rowBlur, 'none');
  assert(
    glassStyle.textContrast >= 4.5 &&
      glassStyle.primaryContrast >= 4.5 &&
      glassStyle.brightBackdropContrast >= 4.5 &&
      glassStyle.subtleTextContrast >= 4.5,
    JSON.stringify(glassStyle),
  );
  report.checks.glassMaterial = glassStyle;
  const settleGlass = async () =>
    page.locator('.toolbar-popover').evaluateAll(async (nodes) => {
      await Promise.all(
        nodes.flatMap((node) => node.getAnimations().map((animation) => animation.finished)),
      );
    });
  await page.getByRole('button', { name: '设置', exact: true }).evaluate(async (node) => {
    node.click();
    await new Promise((resolve) => setTimeout(resolve, 35));
    node.click();
    await new Promise((resolve) => setTimeout(resolve, 35));
    node.click();
  });
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  await settleGlass();
  assert.equal(
    await page
      .getByRole('dialog', { name: '设置', exact: true })
      .evaluate((node) => getComputedStyle(node).opacity),
    '1',
  );
  assert.equal(
    await page.locator('.liquid-bridge').count(),
    0,
    'A popover must animate as one surface without detached drops',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.toolbar-popover[aria-hidden="true"]'));
  report.checks.glassMotion = {
    rapidToggle: true,
    singleSurface: true,
    reversesFromPresentation: true,
  };
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('dialog', { name: '账户', exact: true }).waitFor();
  assert(
    await page.getByRole('dialog', { name: '账户', exact: true }).evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      );
    }),
  );
  assert.equal(
    await page
      .getByRole('dialog', { name: '账户', exact: true })
      .locator('input[type="password"]')
      .count(),
    0,
  );

  assert.equal(
    await page.getByRole('dialog', { name: '账户', exact: true }).locator('textarea').count(),
    0,
  );
  await page.getByRole('button', { name: '更换 Cookies', exact: true }).click();
  assert.equal(
    await page.getByRole('dialog', { name: '账户', exact: true }).locator('textarea').count(),
    1,
  );
  const cookieGuide = page.getByRole('dialog', { name: '账户', exact: true }).locator('details');
  assert.equal(await cookieGuide.count(), 1);
  assert.equal(await cookieGuide.getAttribute('open'), null);
  await settleGlass();
  await page.screenshot({ path: path.join(outputRoot, 'account-panel.png') });
  await verifyPanel();
  let finishCookie;
  let submittedCookie;
  const cookieSubmitted = new Promise((resolve) => {
    submittedCookie = resolve;
  });
  const cookieFinished = new Promise((resolve) => {
    finishCookie = resolve;
  });
  const slowCookie = async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    submittedCookie();
    await cookieFinished;
    return route.fulfill({
      json: {
        imported: 299,
        status: {
          connected: true,
          running: false,
          needsReconnect: false,
          lastAttemptMs: Date.now(),
          lastSuccessMs: Date.now(),
          nextAttemptMs: null,
          lastImportedCount: 299,
          error: null,
          profile: { username: 'qa_user', followingCount: 299, avatarUrl: null },
        },
      },
    });
  };
  await page.route('**/api/account-sync', slowCookie);
  const accountDialog = page.getByRole('dialog', { name: '账户', exact: true });
  await accountDialog.locator('textarea').fill('synthetic-ui-cookie');
  await accountDialog.getByRole('button', { name: '更新并同步', exact: true }).click();
  await cookieSubmitted;
  await accountDialog.getByRole('status').filter({ hasText: '正在验证 Cookies' }).waitFor();
  assert.equal(await accountDialog.locator('.operation-spinner').count(), 1);
  finishCookie();
  await page.locator('.account-tool').getByText('关注 299 位', { exact: true }).waitFor();
  assert.equal(await accountDialog.getByText('关注 299 位', { exact: true }).count(), 0);
  await accountDialog.getByRole('button', { name: '更换 Cookies', exact: true }).waitFor();
  assert.equal(
    await accountDialog.getByRole('button', { name: '同步清单', exact: true }).count(),
    0,
  );
  assert.equal(await accountDialog.getByText('同步状态', { exact: true }).count(), 0);
  assert.equal(await accountDialog.getByText('最近同步', { exact: true }).count(), 0);
  assert.equal(
    await accountDialog.getByRole('heading', { name: '关注清单', exact: true }).count(),
    0,
  );
  assert.equal(await accountDialog.locator('textarea').count(), 0);
  await accountDialog.getByRole('button', { name: '更换 Cookies', exact: true }).click();
  assert.equal(await accountDialog.locator('textarea').inputValue(), 'synthetic-ui-cookie');
  await page.unroute('**/api/account-sync', slowCookie);
  report.checks.accountImmediateFeedback = true;
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.toolbar-popover[aria-hidden="true"]'));
  assert.equal(
    await page.getByRole('button', { name: '账户', exact: true }).getAttribute('aria-expanded'),
    'false',
  );
  await wakeChrome();
  await page.getByRole('button', { name: '密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '密钥', exact: true }).waitFor();
  await settleGlass();
  const keyPanelPlacement = async () =>
    page.getByRole('dialog', { name: '密钥', exact: true }).evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        above: node.style.bottom !== 'auto',
        edge: parseFloat(node.style.bottom !== 'auto' ? style.bottom : style.top),
      };
    });
  assert.equal(await page.getByRole('button', { name: '立即更新', exact: true }).count(), 0);
  const keyPanelBeforeSave = await keyPanelPlacement();
  await page
    .getByRole('dialog', { name: '密钥', exact: true })
    .getByRole('textbox', { name: '密钥名:密钥值', exact: true })
    .fill('synthetic:synthetic-fixture-key');
  await page.getByRole('button', { name: '添加密钥', exact: true }).click();
  await page
    .getByRole('dialog', { name: '密钥', exact: true })
    .getByText('synthetic-fixture-key', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '密钥名:密钥值', exact: true }).inputValue(),
    '',
  );
  assert(await page.locator('.key-tool').evaluate((node) => node.classList.contains('has-keys')));
  const afterSave = await keyPanelPlacement();
  assert.equal(afterSave.above, keyPanelBeforeSave.above);
  await verifyPanel();
  report.checks.manualKeys = { import: true, noExtractionButton: true };
  await page.keyboard.press('Escape');
  // Portraits reuse a valid synthetic cached raster; no external account is read.
  await page.route('**/avatar.jpg', async (route) => {
    const response = await route.fetch({ url: `${origin}/api/subjects/stripchat%3A42/cover.jpg` });
    await route.fulfill({ response });
  });
  const historyRead = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/events/read') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.locator('.history-event-line').first().waitFor();
  assert.match(
    await page.locator('.history-event-line time').first().innerText(),
    /^\d{2}:\d{2}:\d{2}$/,
  );
  assert.equal(await page.locator('.history-event-line').first().locator(':scope > *').count(), 4);
  await historyRead;
  await page.waitForFunction(
    () =>
      document.querySelector('.history-event.unread strong') &&
      getComputedStyle(document.querySelector('.history-event.unread strong')).fontWeight === '700',
  );
  const portrait = page.locator('.history-event-line .subject-avatar img').first();
  await portrait.waitFor();
  await settleGlass();
  await page.screenshot({ path: path.join(outputRoot, 'history-panel.png') });
  assert(
    (await page.getByRole('dialog', { name: '历史', exact: true }).boundingBox()).width <= 420,
  );
  const eventColors = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return [css.getPropertyValue('--orange').trim(), css.getPropertyValue('--private').trim()];
  });
  assert.notEqual(eventColors[0], eventColors[1]);
  const longHistory = page.locator('.history-subject .overflow-text.is-overflowing').first();
  await longHistory.hover();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.history-subject .overflow-text.is-overflowing > span')].some(
      (node) => getComputedStyle(node).animationName === 'history-cell-pan',
    ),
  );
  assert.equal(
    await page
      .locator('.history-event-line')
      .first()
      .evaluate((node) => getComputedStyle(node).columnGap),
    '4px',
  );
  await verifyPanel();
  await page.keyboard.press('Escape');
  await settleGlass();
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.locator('.history-event-line').first().waitFor();
  assert.equal(await page.locator('.history-event.unread').count(), 0);
  await page.keyboard.press('Escape');
  report.checks.historyPresentation = {
    unreadBoldAfterAck: true,
    normalAfterReopen: true,
    avatarColumn: true,
  };
  const navigationStarted = Date.now();
  // The fixture briefly re-follows 300 to create a confirmed history event,
  // then archives it. History and membership refresh on separate heartbeats;
  // wait for the final membership snapshot rather than navigating stale rows.
  const navigationMembership = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== '/api/subjects' || !response.ok()) return false;
    const subjects = await response.json();
    const archived = subjects.find((subject) => subject.id === 'stripchat:300');
    return archived?.archived === true && archived.observedAtMs >= navigationStarted;
  });
  await fixture.navigationEvents();
  await navigationMembership;
  await page.waitForFunction(
    () =>
      document.querySelector('.subject-filters button[aria-label="归档"] .filter-count')
        ?.textContent === '1',
  );
  for (const [id, filter] of [
    [299, '在线'],
    [299, '在线'],
    [297, '离线'],
    [300, '归档'],
  ]) {
    await page.locator('.track-table-scroll').evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page
      .getByRole('button', { name: `在列表中定位 演示主播 ${id}`, exact: true })
      .first()
      .click();
    const row = page.locator(`[data-subject-id="stripchat:${id}"]`);
    await row.waitFor();
    await page.waitForFunction(
      (id) =>
        document.activeElement?.closest('[data-subject-id]')?.dataset.subjectId ===
        `stripchat:${id}`,
      id,
    );
    assert.equal(
      await page.locator('.subject-filters button.active').getAttribute('aria-label'),
      filter,
    );
    const visible = await row.evaluate((node) => {
      const box = node.getBoundingClientRect(),
        viewport = node.closest('.track-table-scroll').getBoundingClientRect();
      return box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1;
    });
    assert(visible);
    assert(
      await row.evaluate((node) =>
        node.getAnimations({ subtree: true }).some((animation) => animation.id === 'row-reveal'),
      ),
    );
    if (id === 299)
      assert(
        await page.locator('.track-table-scroll').evaluate((node) => node.scrollTop > 24 * 116),
      );
    assert((await page.locator('.track-row').count()) < 16);
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(
      await page.getByRole('button', { name: '历史', exact: true }).getAttribute('aria-expanded'),
      'false',
    );
  }
  await page.locator('.subject-filters').getByRole('button', { name: '在线', exact: true }).click();
  await lane().waitFor();
  report.checks.historyNavigation = {
    deepVirtualRow: true,
    repeatedTarget: true,
    onlineOfflineArchived: true,
    noPlayback: true,
    transientRowIndication: true,
  };
  const edges = await page
    .locator('.time-ruler-row .ruler-division[data-window-edge]')
    .evaluateAll((elements) =>
      elements.map((e) => ({
        width: e.getBoundingClientRect().width,
        height: e.getBoundingClientRect().height,
      })),
    );
  assert.equal(edges.length, 2);
  assert(edges.every((e) => e.width >= 1 && e.height > 0));
  const nowLine = page.locator('.live-now-line');
  await nowLine.waitFor();
  const previousClock = Number(await nowLine.getAttribute('data-at'));
  await page.waitForFunction(
    (at) => Number(document.querySelector('.live-now-line')?.dataset.at) > at,
    previousClock,
  );
  report.checks.menusAndClock = {
    accountInDirectory: true,
    keyInPlayer: true,
    flatPanels: true,
    compactHistory: true,
    rulerEdges: edges,
    liveLineAdvances: true,
  };
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('dialog', { name: '设置', exact: true }).locator('details').count(),
    0,
  );
  assert.equal(
    await page
      .getByRole('dialog', { name: '设置', exact: true })
      .getByText('统一同步间隔（秒）', { exact: true })
      .count(),
    1,
  );
  await settleGlass();
  assert.equal(
    await page
      .getByRole('dialog', { name: '设置', exact: true })
      .locator('.routing-options')
      .count(),
    0,
  );
  await page.screenshot({ path: path.join(outputRoot, 'settings-panel.png') });
  await page.keyboard.press('Escape');
  const draftAccountRoute = (route) =>
    route.fulfill({
      json: {
        connected: false,
        running: false,
        needsReconnect: false,
        origin: 'https://stripchat.com',
        error: null,
        profile: null,
      },
    });
  await page.route('**/api/account-sync', draftAccountRoute);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['account'] })),
  );
  await page.getByRole('button', { name: '账户', exact: true }).click();
  const siteOptions = page
    .getByRole('dialog', { name: '账户', exact: true })
    .locator('.routing-options');
  await siteOptions.locator('.routing-item').first().waitFor();
  const siteCount = await siteOptions.locator('.routing-item').count();
  assert(siteCount >= 34);
  let probeRequests = 0;
  let liveOpenRequests = 0;
  const countProbes = (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/network/probe'))
      probeRequests++;
    if (request.method() === 'POST' && /\/api\/subjects\/[^/]+\/live$/.test(request.url()))
      liveOpenRequests++;
  };
  page.on('request', countProbes);
  const org = siteOptions
    .locator('.routing-list')
    .getByText('stripchat.org', { exact: true })
    .locator('..');
  await org.click();
  await page.waitForFunction(() =>
    document
      .querySelector('.routing-item[aria-pressed="true"]')
      ?.textContent.includes('stripchat.org'),
  );
  assert.equal(await siteOptions.getByRole('button', { name: '自动', exact: true }).count(), 0);
  assert.equal(probeRequests, 0);
  await siteOptions.getByRole('button', { name: '重新测速', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.routing-item')].every((node) =>
      /\d+ ms/.test(node.textContent),
    ),
  );
  assert.equal(probeRequests, 1);
  await verifyRoutingPresentation(page, siteOptions);
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 1024, height: 600 });
  await settleGlass();
  await verifyPanel();
  await page.screenshot({ path: path.join(outputRoot, 'settings-panel-compact.png') });
  await page.setViewportSize(originalViewport);
  report.checks.siteRouting = {
    candidates: siteCount,
    draftSelected: true,
    explicitProbeOnly: true,
  };
  await page.screenshot({ path: path.join(outputRoot, 'account-site-panel.png') });
  await verifyPanel();
  assert.equal(
    await page
      .getByRole('dialog', { name: '设置', exact: true })
      .getByLabel('系统状态', { exact: true })
      .count(),
    0,
  );
  await page.keyboard.press('Escape');
  await page.unroute('**/api/account-sync', draftAccountRoute);
  let archiveFault = false;
  await wakeChrome();
  await page.getByRole('button', { name: '视频 CDN', exact: true }).click();
  const cdnOptions = page
    .getByRole('dialog', { name: '视频 CDN', exact: true })
    .locator('.routing-options');
  await cdnOptions.locator('.routing-item').first().waitFor();
  assert.equal(await cdnOptions.locator('.routing-item').count(), 4);
  assert.equal(await cdnOptions.getByRole('button', { name: '自动', exact: true }).count(), 0);
  const testCdn = cdnOptions.getByRole('button', { name: '重新测速', exact: true });
  await testCdn.click();
  await cdnOptions
    .getByText(/MB\/s|GB\/s/)
    .first()
    .waitFor();
  await testCdn.waitFor();
  assert.equal(liveOpenRequests, 0);
  await cdnOptions
    .locator('.routing-list')
    .getByText('doppiocdn.org', { exact: true })
    .locator('..')
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('.routing-item[aria-pressed="true"]')
      ?.textContent.includes('doppiocdn.org'),
  );
  assert.equal(
    (await page.request.get(origin + '/api/network/routes').then((r) => r.json())).preferences
      .cdnHost,
    'edge-hls.doppiocdn.org',
  );
  await settleGlass();
  await page.screenshot({ path: path.join(outputRoot, 'cdn-panel.png') });
  assert.equal(probeRequests, 2);
  page.off('request', countProbes);
  await page.keyboard.press('Escape');
  report.checks.cdnRouting = {
    candidates: 4,
    manualPersisted: true,
    besideKey: true,
  };
  const archiveHealthRoute = async (route) => {
    const response = await route.fetch();
    const system = await response.json();
    await route.fulfill({
      json: {
        ...system,
        backgroundTasks: system.backgroundTasks.map((task) =>
          task.id === 'site-probe' || task.id === 'site-access'
            ? { ...task, id: 'site-access', detail: 'account-bound', target: 'fast.invalid' }
            : task,
        ),
        siteRoutes: {
          selectedOrigin: 'https://fast.invalid',
          candidates: [
            {
              origin: 'https://fast.invalid',
              latencyMs: 85,
              failures: 0,
              checkedAtMs: Date.now(),
            },
          ],
        },
        disk: {
          ...system.disk,
          freeBytes: 64 * 1024 ** 3,
          totalBytes: 128 * 1024 ** 3,
          error: null,
          lowSpace: false,
        },
        maintenanceError: null,
        archiveHealth: {
          error: archiveFault ? 'archive_timeout' : null,
          checkedAtMs: Date.now(),
          failures: archiveFault ? 1 : 0,
          recovery: archiveFault ? 'retrying' : 'none',
        },
      },
    });
  };
  await page.route('**/api/system', archiveHealthRoute);
  await page.getByRole('button', { name: '状态', exact: true }).click();
  const statusPanel = page.getByRole('dialog', { name: '状态', exact: true });
  await statusPanel.getByLabel('系统状态', { exact: true }).waitFor();
  // The panel can first render the cached real status; wait for the mocked refresh.
  await statusPanel.locator('.background-task-disclosure summary').click();
  await statusPanel
    .locator('[data-task="site-access"] .background-task-detail .overflow-text > span')
    .filter({ hasText: 'fast.invalid' })
    .waitFor();
  assert.match(await statusPanel.locator('[data-task="site-access"]').innerText(), /fast.invalid/);
  await statusPanel.locator('.archive-health.is-ok').waitFor();
  const healthStyle = await statusPanel.locator('.archive-health').evaluate((node) => {
    const label = node.querySelector('.panel-status-label'),
      value = node.querySelector('.panel-status-value'),
      dot = node.querySelector('.panel-status-dot');
    const probe = document.createElement('span');
    probe.style.color = 'var(--success)';
    document.body.append(probe);
    const green = getComputedStyle(probe).color;
    probe.remove();
    return {
      labeled: label.textContent === '归档服务' && value.textContent === '可用',
      quiet: getComputedStyle(value).color !== green,
      green: getComputedStyle(dot).backgroundColor === green,
      aligned: value.getBoundingClientRect().left > label.getBoundingClientRect().left,
    };
  });
  assert(
    healthStyle.labeled && healthStyle.quiet && healthStyle.green && healthStyle.aligned,
    JSON.stringify(healthStyle),
  );
  assert.equal(
    await statusPanel.getByRole('heading', { name: '关注清单', exact: true }).count(),
    0,
  );
  const recordingStats = statusPanel
    .locator('.system-stats')
    .filter({ has: page.getByText('录制', { exact: true }) });
  assert.match(await recordingStats.innerText(), /\d+ 正在录制 · \d+ 已设自动录制/);
  const statsAlignment = await recordingStats
    .locator('span')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));
  assert(statsAlignment[1] > statsAlignment[0], 'Recording counters belong on the right');
  assert.equal(await statusPanel.locator('.runtime-settings').count(), 0);
  await settleGlass();
  await verifyPanel();
  await page.screenshot({ path: path.join(outputRoot, 'status-panel.png') });
  archiveFault = true;
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system'] })),
  );
  await statusPanel.locator('.archive-health.is-error').waitFor();
  await page.locator('.header-tool:nth-child(2) .tool-alert').waitFor();
  assert.match(await statusPanel.locator('.archive-health').innerText(), /工作线程响应超时/);
  await page.screenshot({ path: path.join(outputRoot, 'status-panel-error.png') });
  archiveFault = false;
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system'] })),
  );
  await statusPanel.locator('.archive-health.is-ok').waitFor();
  await page.unroute('**/api/system', archiveHealthRoute);
  report.checks.statusPanel = {
    independent: true,
    recordingCounters: true,
    quietLabeledHealth: true,
    healthRecovery: true,
  };
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.program-timeline, .program-gap, .program-marker').count(), 0);
  report.checks.runtimeOverlayRemoved = true;
  const accountState = await (await context.request.get(`${origin}/api/account-sync`)).json();
  let cookieIssue = null;
  let loginOrigin = accountState.origin ?? 'https://stripchat.com';
  let followingCount = 300;
  await context.route('**/api/account-sync', (route) =>
    route.fulfill({
      json: {
        ...accountState,
        connected: true,
        origin: loginOrigin,
        error: cookieIssue,
        needsReconnect: cookieIssue !== null,
        profile: {
          username: '合成账户',
          followingCount,
          avatarUrl: '/api/account-sync/avatar?version=synthetic',
        },
      },
    }),
  );
  await context.route('**/api/account-sync/avatar?*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#38bd82"/></svg>',
    }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['account'] })),
  );
  await page.locator('.directory [aria-label="账户"] img').waitFor();
  assert(
    await page
      .locator('.directory [aria-label="账户"] img')
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.locator('.account-tool').getByText('合成账户', { exact: true }).waitFor();

  const boundAccountDialog = page.getByRole('dialog', { name: '账户', exact: true });
  assert.equal(await boundAccountDialog.getByRole('combobox').count(), 0);
  assert.equal(await boundAccountDialog.locator('.routing-options').count(), 0);
  await boundAccountDialog.getByRole('button', { name: '更换 Cookies', exact: true }).click();
  await boundAccountDialog.locator('textarea').fill('synthetic-source-cookie');
  loginOrigin = 'https://zh.stripchat.com';
  followingCount = 301;
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['account'] })),
  );
  await page.locator('.account-tool').getByText('关注 301 位', { exact: true }).waitFor();
  await boundAccountDialog.getByText('zh.stripchat.com', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('.account-settings-form textarea')?.value === '',
  );
  await page.keyboard.press('Escape');
  cookieIssue = 'cookies_domain_mismatch';
  await page.route('**/api/system', archiveHealthRoute);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['account', 'system'] })),
  );
  await page.locator('.header-tool:nth-child(2) .tool-alert').waitFor({ state: 'detached' });
  await page.locator('.account-tool .tool-alert').waitFor();
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page
    .getByRole('dialog', { name: '账户', exact: true })
    .getByText('Cookies 与所选站点域名不匹配，请导入该站点的 Cookies；更换站点需先退出账户。', {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole('dialog', { name: '账户', exact: true })
    .getByText('登录域名', { exact: true })
    .waitFor();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(outputRoot, 'account-domain-status.png') });
  await page.keyboard.press('Escape');
  cookieIssue = null;
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['account'] })),
  );
  await page.locator('.account-tool .tool-alert').waitFor({ state: 'detached' });
  await page.unroute('**/api/system', archiveHealthRoute);
  report.checks.accountDomainHealth = true;
  await context.unroute('**/api/account-sync');
  await context.unroute('**/api/account-sync/avatar?*');
  const keyState = await (await context.request.get(`${origin}/api/keys`)).json();
  await context.route('**/api/keys', (route) =>
    route.fulfill({ json: { ...keyState, keyCount: 1 } }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['keys'] })),
  );
  await page.locator('.player-actions .key-tool.has-keys').waitFor({ state: 'attached' });
  const keyColor = await page
    .locator('.player-actions .key-tool button')
    .evaluate((element) => getComputedStyle(element).color);
  assert.notEqual(
    keyColor,
    await page
      .locator('.header-tools button')
      .first()
      .evaluate((element) => getComputedStyle(element).color),
  );
  await context.unroute('**/api/keys');
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['keys', 'account'] })),
  );
  report.checks.menusAndClock.connectedAvatar = true;
  report.checks.menusAndClock.keyAvailableColor = keyColor;
  const frameBounds = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ['.player-picture', '.player-actions', '.viewer-focus', '.snapshot-section'].map(
          (selector) => {
            const rect = document
              .querySelector('.studio-viewer ' + selector)
              .getBoundingClientRect();
            return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
          },
        ),
      ),
    );
  const idleFrame = await frameBounds();
  const headerGeometry = await page.evaluate(() => {
    const board = document.querySelector('.track-board');
    const header = board.querySelector('.track-header-viewport');
    const ruler = header.querySelector('.timeline-ruler').getBoundingClientRect();
    const lane = board.querySelector('.track-lane').getBoundingClientRect();
    return {
      unusedWidth: board.clientWidth - header.offsetWidth,
      rulerRight: ruler.right,
      laneRight: lane.right,
    };
  });
  assert.equal(headerGeometry.unusedWidth, 0);
  assert(Math.abs(headerGeometry.rulerRight - headerGeometry.laneRight) < 1);
  // The preceding panel flows can outlive a viewport refresh. Recording controls
  // belong to virtual rows, so restore the fixture row before querying them.
  await page.locator('.track-table-scroll').evaluate((node) => {
    node.scrollTop = 0;
  });
  const record = page.locator('[data-subject-id="' + info.subjectId + '"] .record-button');
  const originalRecording = await record.getAttribute('aria-checked');
  // Isolate notification-to-paint latency from the real network. The fixture
  // confirms capture after 600ms; coverage exists only if the query includes it.
  let firstAvailableAt = Infinity;
  const coverageReads = [];
  await context.route('**/api/workbench?*', async (route) => {
    const response = await route.fetch();
    const packet = await response.json();
    const to = Number(new URL(route.request().url()).searchParams.get('to'));
    for (const row of packet.rows)
      if (row.subjectId === info.subjectId) {
        const available = Date.now() >= firstAvailableAt && to > firstAvailableAt;
        row.coverage.buckets = available
          ? [
              {
                fromMs: firstAvailableAt,
                toMs: Math.min(to, firstAvailableAt + 2000),
                coveredMs: Math.min(to - firstAvailableAt, 2000),
              },
            ]
          : [];
        coverageReads.push({ at: Date.now(), to, available });
      }
    await route.fulfill({ response, json: packet });
  });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
  );
  await page.waitForFunction(
    (id) => !document.querySelector('[data-subject-id="' + id + '"] .track-clip'),
    info.subjectId,
  );
  const recordingClickedAt = Date.now();
  firstAvailableAt = recordingClickedAt + 600;
  await record.click();
  await record.locator('.operation-spinner').waitFor();
  assert(!(await record.evaluate((node) => node.classList.contains('is-recording'))));
  await page.waitForFunction(
    (id) =>
      document
        .querySelector('[data-subject-id="' + id + '"] .record-button')
        ?.classList.contains('is-recording'),
    info.subjectId,
  );
  assert.equal(await record.locator('.operation-spinner').count(), 0);
  const redAt = Date.now();
  await page
    .locator('[data-subject-id="' + info.subjectId + '"] .track-clip')
    .first()
    .waitFor({ timeout: 2000 });
  const coveragePaintAt = Date.now();
  report.checks.recordingCoverage = {
    simulatedCaptureMs: 600,
    clickToRedMs: redAt - recordingClickedAt,
    clickToCoverageMs: coveragePaintAt - recordingClickedAt,
    redToCoverageMs: coveragePaintAt - redAt,
    reads: coverageReads,
  };
  console.log('[qa] Recording coverage timing ' + JSON.stringify(report.checks.recordingCoverage));
  await context.unroute('**/api/workbench?*');
  await page.waitForFunction(
    ({ id, before }) => {
      const button = document.querySelector('[data-subject-id="' + id + '"] .record-button');
      return !button.disabled && button.getAttribute('aria-checked') !== before;
    },
    { id: info.subjectId, before: originalRecording },
  );
  assert.equal(await page.locator('video').count(), 0);
  await record.click();
  await page.waitForFunction(
    ({ id, before }) => {
      const button = document.querySelector('[data-subject-id="' + id + '"] .record-button');
      return !button.disabled && button.getAttribute('aria-checked') === before;
    },
    { id: info.subjectId, before: originalRecording },
  );
  const previewStyle = await page
    .locator('[data-subject-id="' + info.subjectId + '"] .track-label')
    .evaluate((node) => {
      const preview = node.querySelector('.track-cover-wrap').getBoundingClientRect();
      const icon = node.querySelector('.record-button').getBoundingClientRect();
      return {
        width: node.getBoundingClientRect().width,
        headerWidth: document.querySelector('.directory').getBoundingClientRect().width,
        background: getComputedStyle(node).backgroundColor,
        name: getComputedStyle(node.querySelector('.subject-name')).color,
        inside:
          icon.left >= preview.left &&
          icon.right <= preview.right &&
          icon.top >= preview.top &&
          icon.bottom <= preview.bottom,
      };
    });
  assert.equal(previewStyle.width, previewStyle.headerWidth);
  const verifyDirectoryLayout = async () => {
    const result = await page.evaluate(() => {
      const fits = [...document.querySelectorAll('.subject-filters button')].map((button) => {
        const count = button.querySelector('.filter-count');
        const original = count.textContent;
        count.textContent = '10000';
        const label = button.querySelector('.filter-label');
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        range.selectNodeContents(count);
        const number = range.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        count.textContent = original;
        return (
          text.left >= bounds.left + 3 &&
          number.right <= bounds.right - 3 &&
          number.left >= bounds.left + 3 &&
          text.right <= bounds.right - 3 &&
          number.top >= text.bottom
        );
      });
      const row = document.querySelector('.track-row');
      const label = row.querySelector('.track-label').getBoundingClientRect();
      const lane = row.querySelector('.track-lane').getBoundingClientRect();
      const directory = document.querySelector('.directory').getBoundingClientRect();
      const ruler = document
        .querySelector('.time-ruler-row .timeline-ruler')
        .getBoundingClientRect();
      const date = document
        .querySelector('.time-ruler-row .ruler-date:not([aria-hidden="true"])')
        .getBoundingClientRect();
      const hour = document
        .querySelector('.time-ruler-row .ruler-hour:not([aria-hidden="true"])')
        .getBoundingClientRect();
      const cover = row.querySelector('.track-cover-wrap').getBoundingClientRect();
      return {
        fits,
        width: label.width,
        row: row.getBoundingClientRect().height,
        cover: { width: cover.width, height: cover.height },
        aligned:
          Math.abs(label.width - directory.width) < 1 && Math.abs(lane.left - ruler.left) < 1,
        datesFit:
          date.top >= ruler.top && date.bottom + 4 <= hour.top && hour.bottom <= ruler.bottom,
        rulerHeight: ruler.height,
      };
    });
    assert(result.fits.every(Boolean), JSON.stringify(result));
    assert(result.aligned && result.datesFit, JSON.stringify(result));
    assert.equal(result.rulerHeight, 48);
    assert(
      Math.abs(result.cover.width - (107 * 16) / 9) < 1 && Math.abs(result.cover.height - 107) < 1,
      JSON.stringify(result),
    );
    return result;
  };
  report.checks.directoryLayout = { chinese: await verifyDirectoryLayout() };
  const subjectRowHeight = await page
    .locator('.track-row')
    .first()
    .evaluate((row) => row.getBoundingClientRect().height);
  assert.equal(subjectRowHeight, 116);
  assert.equal(previewStyle.inside, true);
  assert.equal(await page.locator('.timeline-filmstrip').count(), 0);
  report.checks.preview = {
    ...previewStyle,
    recordToggleWithoutPlayback: true,
  };
  const startHandle = page.getByRole('slider', { name: '视窗起点', exact: true });
  const endHandle = page.getByRole('slider', { name: '视窗终点', exact: true });
  const setDays = async (days) => {
    await startHandle.press('End');
    for (let i = 0.5; i < days; i += 0.5) await startHandle.press('ArrowLeft');
  };
  assert.equal(await page.locator('.day-span-options').count(), 0);
  for (const days of [0.5, 1, 1.5, 2, 3, 4, 5, 6, 7]) {
    await setDays(days);
    current = await view();
    assert.equal((current.from - dayStart(current.from)) % (day / 2), 0);
    assert.equal(current.to - current.from, days * day);
    const panCount = await page.evaluate(() => window.__qaPanAnimations);
    await page.getByRole('button', { name: '前12小时', exact: true }).click();
    const after = await view();
    assert.equal(after.from - current.from, -day / 2);
    assert.equal(after.to - current.to, -day / 2);
    assert(await page.evaluate((before) => window.__qaPanAnimations > before, panCount));
    await page.getByRole('button', { name: '后12小时', exact: true }).click();
    assert.deepEqual(await view(), current);
    assert(await page.getByRole('button', { name: '后12小时', exact: true }).isDisabled());
  }
  report.checks.calendar = {
    spans: [0.5, 1, 1.5, 2, 3, 4, 5, 6, 7],
    halfDayBoundary: true,
    stepByTwelveHours: true,
    stableClock: true,
  };
  console.log('[qa] Half-day controls passed');
  await setDays(1);
  const originalView = await view();
  const positionBar = page.getByRole('group', { name: '视图位置与跨度' });
  const bounds = await positionBar.boundingBox();
  const firstDay = Number(await startHandle.getAttribute('aria-valuenow'));
  const totalDays = Number(await endHandle.getAttribute('aria-valuemax'));
  const startBox = await startHandle.boundingBox();
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    startBox.x + startBox.width / 2 - (bounds.width / totalDays) * 2,
    startBox.y + startBox.height / 2,
    { steps: 8 },
  );
  assert.deepEqual(await view(), originalView);
  assert.equal(
    Number(await endHandle.getAttribute('aria-valuenow')) -
      Number(await startHandle.getAttribute('aria-valuenow')),
    3,
  );
  await endHandle.evaluate((node) => {
    node.dispatchEvent(new PointerEvent('pointerup', { pointerId: 999, bubbles: true }));
    node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 999, bubbles: true }));
  });
  assert.deepEqual(await view(), originalView);
  assert.equal(
    Number(await endHandle.getAttribute('aria-valuenow')) -
      Number(await startHandle.getAttribute('aria-valuenow')),
    3,
  );
  await page.mouse.up();
  assert.deepEqual(await view(), { from: originalView.from - 2 * day, to: originalView.to });
  await endHandle.press('ArrowLeft');
  assert.deepEqual(await view(), {
    from: originalView.from - 2 * day,
    to: originalView.to - day / 2,
  });
  const endBox = await endHandle.boundingBox();
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    endBox.x + endBox.width / 2 + (bounds.width / totalDays) * 0.6,
    endBox.y + endBox.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  assert.deepEqual(await view(), { from: originalView.from - 2 * day, to: originalView.to });
  const cancelBox = await startHandle.boundingBox();
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    cancelBox.x + cancelBox.width / 2 - bounds.width / totalDays,
    cancelBox.y + cancelBox.height / 2,
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await view(), { from: originalView.from - 2 * day, to: originalView.to });
  await endHandle.press('ArrowLeft');
  await positionBar.hover();
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(
    (from) => Number(document.querySelector('.track-row .track-lane')?.dataset.from) === from,
    originalView.from - 2.5 * day,
  );
  await page.mouse.wheel(100, 0);
  await page.waitForFunction(
    (from) => Number(document.querySelector('.track-row .track-lane')?.dataset.from) === from,
    originalView.from - 2 * day,
  );
  assert(firstDay > 0);
  const grip = page.getByRole('slider', { name: '平移视窗', exact: true });
  assert.equal(await page.locator('.view-position-ridges').count(), 2);
  assert(
    await page
      .locator('.view-position-ridges')
      .evaluateAll((nodes) =>
        nodes.every((node) =>
          getComputedStyle(node).backgroundImage.includes('repeating-linear-gradient'),
        ),
      ),
  );
  assert.equal(await startHandle.locator('span').count(), 0);
  assert.equal(await startHandle.evaluate((node) => getComputedStyle(node).cursor), 'ew-resize');
  assert.equal(await grip.evaluate((node) => getComputedStyle(node).cursor), 'grab');
  assert.equal(
    await startHandle.evaluate((node) => getComputedStyle(node, '::after').content),
    'none',
  );
  const beforeGrip = await view(),
    gripBox = await grip.boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  assert.equal(await grip.evaluate((node) => getComputedStyle(node).outlineStyle), 'none');
  await page.mouse.move(
    gripBox.x +
      gripBox.width / 2 +
      (bounds.width - gripBox.width) / Number(await grip.getAttribute('aria-valuemax')) / 2,
    gripBox.y + gripBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  assert.deepEqual(await view(), { from: beforeGrip.from + day / 2, to: beforeGrip.to + day / 2 });
  await grip.press('ArrowLeft');
  assert.deepEqual(await view(), beforeGrip);
  report.checks.navigatorGrip = { halfDayDrag: true, noEndpointMarks: true, cursors: true };
  await endHandle.press('End');
  await setDays(2);
  // Verify whole-day centering on an explicitly midnight-aligned window.
  if ((await view()).to !== dayStart((await view()).to))
    await page.getByRole('button', { name: '前12小时', exact: true }).click();
  const classes = await page
    .locator('.timeline-grid > .timeline-scene > i')
    .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.className))]);
  assert.deepEqual(classes.sort(), ['division-day', 'division-half-day', 'division-hour']);
  const dateCenters = await page
    .locator('.time-ruler-row .ruler-date:not([aria-hidden="true"])')
    .evaluateAll((nodes) => nodes.map((node) => parseFloat(node.style.left)));
  assert.deepEqual(dateCenters, [25, 75]);
  await page.locator('.time-ruler-row .timeline-scene').evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  await page.screenshot({ path: path.join(outputRoot, 'timeline-navigation.png') });
  report.checks.calendarHandles = {
    halfDaySnap: true,
    fixedOppositeBoundary: true,
    previewBeforeCommit: true,
    wheelBothAxes: true,
    threeDivisionLevels: true,
    centeredDates: true,
  };
  await setDays(1);
  for (
    let remaining = 14;
    await page.getByRole('button', { name: '后12小时', exact: true }).isEnabled();
    remaining--
  ) {
    assert(remaining > 0);
    await page.getByRole('button', { name: '后12小时', exact: true }).click();
    assert((await view()).to <= currentHalfDayEnd(Date.now()));
  }
  assert(await page.getByRole('button', { name: '后12小时', exact: true }).isDisabled());
  report.checks.futureNavigationBlocked = true;
  current = await view();
  let openingPhase = 'checking';
  let releaseOpening;
  const openingGate = new Promise((resolve) => {
    releaseOpening = resolve;
  });
  let openingContinued;
  const continued = new Promise((resolve) => {
    openingContinued = resolve;
  });
  await page.route('**/api/subjects/*/live', async (route) => {
    await openingGate;
    await route.continue();
    openingContinued();
  });
  await page.route('**/api/subjects/*/live-progress', (route) =>
    route.fulfill({ json: { phase: openingPhase } }),
  );
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  for (const [phase, title] of [
    ['checking', '确认公开直播状态'],
    ['resolving', '获取直播源'],
    ['buffering', '接收首批直播画面'],
  ]) {
    openingPhase = phase;
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['playback'] })),
    );
    await page.locator('.playback-status strong').filter({ hasText: title }).waitFor();
    await page.locator('.playback-poster img').waitFor();
  }
  // Keep the live request blocked: metadata and independent reads must not wait
  // for a playback session, decoder or first frame.
  await wakeChrome();
  assert.equal(await page.locator('.player-heading h2').textContent(), '00 演示直播');
  assert.equal(await page.locator('.player-avatar-link .subject-avatar').count(), 1);
  async function assertSelectedSpan() {
    const { actualSpan, actualLabel } = await page.locator('.viewer-focus').evaluate((node) => ({
      actualSpan: Number(node.dataset.to) - Number(node.dataset.from),
      actualLabel: document.querySelector('[aria-label="所选跨度"]').textContent,
    }));
    const spanSeconds = Math.max(1, Math.round(actualSpan / 1000));
    const expectedSpan = [
      Math.floor(spanSeconds / 3600) && `${Math.floor(spanSeconds / 3600)}小时`,
      Math.floor((spanSeconds % 3600) / 60) && `${Math.floor((spanSeconds % 3600) / 60)}分钟`,
      spanSeconds % 60 && `${spanSeconds % 60}秒`,
    ]
      .filter(Boolean)
      .join('');
    assert.equal(actualLabel, expectedSpan);
  }
  await assertSelectedSpan();
  await page.locator('.viewer-focus .track-clip').first().waitFor();
  await page.locator('.snapshot-cell').first().waitFor();
  assert.equal(await page.locator('video').count(), 0);
  report.checks.metadataBeforePlaybackSession = true;
  await page.screenshot({ path: path.join(outputRoot, 'player-opening.png') });
  report.checks.playerOpening = { realPhaseInput: true, selectedCover: true, layoutStable: true };
  openingPhase = 'ready';
  await page.unroute('**/api/subjects/*/live-progress');
  releaseOpening();
  await continued;
  await page.unroute('**/api/subjects/*/live');
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video[data-media-slot="active"]');
      return video?.readyState >= 2 && !video.paused && video.currentTime > 0.5;
    },
    null,
    { timeout: 30000 },
  );
  assert.equal(await page.evaluate(() => window.__qaInterruptedPlay), 1);
  assert.equal(await page.locator('.player-picture .form-error').count(), 0);
  const time = await active().evaluate((video) => video.currentTime);
  await active().evaluate((video) => {
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    video.dispatchEvent(new Event('waiting'));
  });
  await page.locator('.playback-status--brief').waitFor();
  assert.equal(await page.locator('.playback-poster').count(), 0);
  assert.equal(await page.locator('.playback-status--brief p').count(), 0);
  assert.equal(
    await page
      .locator('.playback-status--brief')
      .evaluate((node) => getComputedStyle(node).pointerEvents),
    'none',
  );
  await page.waitForTimeout(4200);
  assert.equal(await page.locator('.playback-status--brief').count(), 1);
  assert.equal(await page.locator('.playback-status--brief p').count(), 0);
  assert((await page.locator('.playback-status--brief').boundingBox()).height < 50);
  assert.equal(await page.locator('.playback-poster').count(), 0);
  await active().evaluate((video) => {
    delete video.readyState;
    video.dispatchEvent(new Event('canplay'));
  });
  await page.waitForFunction(() => !document.querySelector('.playback-status'));
  report.checks.bufferingPresentation = { retainsFrame: true, compact: true, clearsOnReady: true };
  await page.waitForFunction(
    (time) => document.querySelector('video[data-media-slot="active"]')?.currentTime > time + 0.25,
    time,
  );
  assert.deepEqual(await view(), current);
  await wakeChrome();
  const playingFrame = await frameBounds();
  for (const [selector, before] of Object.entries(idleFrame)) {
    for (const key of ['x', 'y', 'width', 'height'])
      assert(
        Math.abs(before[key] - playingFrame[selector][key]) < 1,
        selector + ' shifted at ' + key,
      );
  }
  report.checks.stablePlayer = { idleFrame, playingFrame };
  assert.equal(await page.locator('.player-heading input').count(), 0);
  await page
    .locator('.subject-former-names')
    .getByText('曾用名：旧名 Synthetic', { exact: true })
    .waitFor();
  await page
    .locator('[data-subject-id="' + info.subjectId + '"] .subject-name small')
    .getByText('旧名 Synthetic', { exact: true })
    .waitFor();
  const savedProfile = await (await context.request.get(origin + '/api/subjects')).json();
  assert.deepEqual(savedProfile.find((row) => row.id === info.subjectId).formerNames, [
    '旧名 Synthetic',
  ]);
  report.checks.formerNames = { automaticallyRecorded: true, readOnly: true, visibleInList: true };
  report.checks.playerLayout.liveGap = await playerSpacing();
  assert((await playerSpacing()) <= 16);
  await assertSelectedSpan();
  assert.equal(
    await page
      .locator('.studio-viewer h2')
      .evaluate((element) => getComputedStyle(element.parentElement).textAlign),
    'center',
  );
  assert.equal(await page.locator('.connection-rail[data-connected="true"]').count(), 1);
  const titleConnection = await page
    .getByRole('button', { name: '关闭播放器', exact: true })
    .evaluate((button) => {
      const frame = document.querySelector('.studio-viewer').getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return {
        titleY: frame.top + box.height / 2,
        connectorY: box.top + box.height / 2,
        gap: frame.right - box.right,
        size: box.width,
        iconWidth: button.querySelector('svg').getBoundingClientRect().width,
      };
    });
  assert(
    Math.abs(titleConnection.titleY - titleConnection.connectorY) < 1,
    JSON.stringify(titleConnection),
  );
  assert(Math.abs(titleConnection.gap) < 1, JSON.stringify(titleConnection));
  assert.equal(titleConnection.size, 32);
  assert.equal(titleConnection.iconWidth, 24);
  await page.screenshot({ path: path.join(outputRoot, 'title-connection.png') });
  const publicCell = await page
    .locator('[data-subject-id="' + info.subjectId + '"] .track-label')
    .evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      name: getComputedStyle(node.querySelector('.subject-name')).color,
    }));
  // A fixed number of scroll events can all run before the next lazy page is
  // ready. Keep advancing the viewport as pages arrive; color assertions below
  // still require a real private subject, rather than an offscreen placeholder.
  const privateDeadline = Date.now() + 20000;
  while (
    Date.now() < privateDeadline &&
    !(await page.locator('.track-label.status-cell-private').count())
  ) {
    await page.locator('.track-table-scroll').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForTimeout(150);
  }
  await page.locator('.track-label.status-cell-private').first().waitFor();
  const privateCell = await page
    .locator('.track-label.status-cell-private')
    .first()
    .evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      name: getComputedStyle(node.querySelector('.subject-name')).color,
    }));
  assert.equal(publicCell.name, privateCell.name);
  assert.notEqual(publicCell.background, privateCell.background);
  await page.locator('.subject-filters').getByRole('button', { name: '离线', exact: true }).click();
  await page.waitForSelector('.row-connection[data-offscreen="filtered"]');
  await page.locator('.subject-filters').getByRole('button', { name: '在线', exact: true }).click();
  await lane().waitFor();
  await page.locator('.track-table-scroll').evaluate((node) => {
    node.scrollTop = 600;
  });
  await page.waitForSelector('.row-connection[data-offscreen="above"]');
  assert.equal(await page.getByRole('button', { name: '关闭播放器', exact: true }).count(), 1);
  await page.locator('.track-table-scroll').evaluate((node) => {
    node.scrollTop = 0;
  });
  await lane().waitFor();
  report.checks.connection = {
    titleEndpoint: true,
    typeCDisconnect: true,
    filtered: true,
    offscreen: true,
    disconnectStillAvailable: true,
    statusCellColors: true,
    uniformNameColor: true,
  };
  report.checks.cancelledPlay = {
    abortInjected: true,
    normalPlayback: true,
    clockAdvances: true,
    noFalseError: true,
  };
  console.log('[qa] Synthetic live playback and AbortError recovery passed');
  await page.reload();
  await page.locator('.inline-player[aria-label="直播播放器"]').waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  report.checks.reloadLiveConnection = true;
  await page.locator('.inline-player').evaluate((node) => {
    if (node.contains(document.activeElement)) document.activeElement.blur();
  });
  await wakeChrome();
  await page.waitForFunction(
    () => document.querySelector('.player-picture').dataset.chrome === 'hidden',
    { timeout: 10000 },
  );
  const beforeWake = await frameBounds();
  const modeBadge = page.locator('.player-picture > .player-mode-badge.is-live');
  assert.equal(await modeBadge.isVisible(), true);
  assert.equal(await modeBadge.textContent(), '');
  assert.equal(await modeBadge.locator('svg').count(), 1);
  assert(
    await modeBadge.evaluate(
      (node) =>
        Number(getComputedStyle(node).zIndex) <
        Number(getComputedStyle(document.querySelector('.player-heading')).zIndex),
    ),
  );
  await wakeChrome();
  await page.waitForFunction(
    () => document.querySelector('.player-picture').dataset.chrome === 'visible',
  );
  const afterWake = await frameBounds();
  for (const selector of ['.player-picture', '.snapshot-section'])
    assert.deepEqual(afterWake[selector], beforeWake[selector]);
  await page.screenshot({ path: path.join(outputRoot, 'player-overlay-live.png') });
  report.checks.playerAutoHide = {
    defaultHidden: true,
    hidesOnInactivity: true,
    movementRestores: true,
    noLayoutShift: true,
  };
  const liveWindowTo = await page
    .locator('.viewer-focus')
    .evaluate((element) => Number(element.dataset.to));
  const followed = await page.waitForRequest(
    (request) => {
      if (!request.url().includes('/snapshot-pages?')) return false;
      return Number(new URL(request.url()).searchParams.get('to')) > liveWindowTo;
    },
    { timeout: 15000 },
  );
  const followedQuery = new URL(followed.url()).searchParams;
  const snapshotSpan = Number(followedQuery.get('to')) - Number(followedQuery.get('from'));
  assert(snapshotSpan > 29 * 60000 && snapshotSpan <= 30 * 60000);
  const followedReply = await followed.response();
  assert(followedReply);
  const followedPacket = await followedReply.json();
  for (const item of followedPacket.items) {
    assert(item.unitId && item.slotFromMs <= item.atMs && item.slotToMs > item.atMs);
    assert.equal(new URL(item.url, origin).searchParams.get('unit'), item.unitId);
  }
  await page.waitForFunction(() => {
    const focus = document.querySelector('.viewer-focus');
    return [...document.querySelectorAll('.snapshot-cell')].every(
      (cell) =>
        Number(cell.dataset.at) >= Number(focus.dataset.from) &&
        Number(cell.dataset.at) < Number(focus.dataset.to),
    );
  });
  report.checks.snapshotWindow = {
    followsLiveClock: true,
    from: Number(followedQuery.get('from')),
    to: Number(followedQuery.get('to')),
  };
  await verifySnapshotRoll(page, info.subjectId, wakeSnapshots);
  report.checks.snapshotRolling = {
    metadataFirst: true,
    reused29Images: true,
    retriesNewTail: true,
    autoHide: true,
    emptyState: true,
  };
  const beforeDecoderRecovery = await active().evaluate((video) => video.currentTime);
  await active().evaluate((video) => {
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 3, message: 'Synthetic recoverable decoder failure' },
    });
    video.dispatchEvent(new Event('error'));
  });
  assert.equal(await page.locator('.player-picture .form-error').count(), 0);
  await active().evaluate((video) => {
    delete video.error;
  });
  await page.waitForFunction((before) => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && !video.paused && video.currentTime > before + 0.5;
  }, beforeDecoderRecovery);
  assert.equal(await page.locator('.player-picture .form-error').count(), 0);
  report.checks.decoderRecovery = {
    recovered: true,
    clockAdvances: true,
    noFalseError: true,
  };
  await active().evaluate((video) => {
    video.pause();
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 4, message: 'Synthetic unsupported source' },
    });
    video.dispatchEvent(new Event('error'));
  });
  await page.locator('.player-picture .form-error').waitFor();
  assert.match(
    await page.locator('.player-picture .form-error').textContent(),
    /当前视频格式或编码不受浏览器支持/,
  );
  await active().evaluate((video) => {
    delete video.error;
    return video.play();
  });
  await page.waitForFunction(() => !document.querySelector('.player-picture .form-error'));
  report.checks.realFailure = { visible: true, actualPlaybackClears: true };
  await page.locator('.snapshot-cell button[data-unit-index]').first().waitFor();
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const screenshotPlayback = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/playback',
  );
  await page.route('**/api/playback', async (route) => {
    await snapshotGate;
    await route.continue();
  });
  await active().evaluate((video) => {
    window.__qaSnapshotLive = video;
  });
  const liveSnapshotWindow = await page
    .locator('.viewer-focus')
    .evaluate((node) => ({ fromMs: Number(node.dataset.from), toMs: Number(node.dataset.to) }));
  await page.locator('.snapshot-cell button[data-unit-index]').first().click();
  const screenshotRequest = (await screenshotPlayback).postDataJSON();
  assert(
    !('fromMs' in screenshotRequest) && !('toMs' in screenshotRequest),
    'A screenshot seek is independent of the rolling view bounds',
  );
  assert(
    await active().evaluate((video) => video === window.__qaSnapshotLive),
    'The live decoder must remain mounted while archive lookup is pending',
  );
  assert.equal(await page.locator('.playback-status:not(.playback-status--compact)').count(), 0);
  await page.locator('.playback-status--brief').waitFor();
  assert.equal(await page.locator('.playback-status--brief p').count(), 0);
  assert.equal(await page.locator('.playback-poster').count(), 0);
  await page.screenshot({ path: path.join(outputRoot, 'snapshot-seek-feedback.png') });
  releaseSnapshot();
  await page.locator('.player-mode-badge.is-archive').waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video !== window.__qaSnapshotLive && video.readyState >= 2 && !video.paused;
  });
  const screenshotWindow = await page
    .locator('.viewer-focus')
    .evaluate((node) => ({ fromMs: Number(node.dataset.from), toMs: Number(node.dataset.to) }));
  assert.equal(screenshotWindow.fromMs, liveSnapshotWindow.fromMs);
  assert(
    screenshotWindow.toMs >= liveSnapshotWindow.toMs,
    'The live presentation clock continues while archive media loads',
  );
  await page.unroute('**/api/playback');
  report.checks.liveScreenshotSeek = { keepsWindow: true, retainsLiveUntilReady: true };
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  await page.locator('.player-mode-badge.is-live').waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video && video.readyState >= 2 && !video.paused;
  });
  await active().evaluate((video) => video.pause());
  await page.route('**/api/subjects/*/live-progress', (route) =>
    route.fulfill({ json: { phase: 'stopped', reason: 'private' } }),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['playback'] })),
  );
  await page
    .locator('.playback-status strong')
    .filter({ hasText: '主播已转入非公开直播' })
    .waitFor();
  assert.equal(await active().count(), 0);
  await page.locator('.playback-poster img').waitFor();
  await page.screenshot({ path: path.join(outputRoot, 'player-stopped.png') });
  report.checks.authoritativeStop = {
    removesLiveMedia: true,
    selectedCover: true,
    specificCause: true,
  };
  await page.unroute('**/api/subjects/*/live-progress');
  await page.reload();
  await lane().waitFor();
  assert.deepEqual(await view(), current);
  // The fixture includes recent footage from yesterday when run just after
  // midnight. Navigate to it before drawing; scrolling cannot reveal another day.
  if (info.archiveStart < current.from) {
    await page.getByRole('button', { name: '前12小时', exact: true }).click();
    await page.waitForFunction(
      (at) => Number(document.querySelector('.track-lane')?.getAttribute('data-from')) <= at,
      info.archiveStart,
    );
    current = await view();
  }
  await revealInterval({ fromMs: info.archiveStart, toMs: info.archiveEnd });
  const box = await lane().boundingBox(),
    x = (at) => box.x + ((at - current.from) / (current.to - current.from)) * box.width;
  // Start on the larger blank margin. Just after midnight the left margin is
  // the column divider, so drawing in reverse keeps the pointer on the lane.
  const blankEdges = [
    x(Math.max(current.from, info.archiveStart - 20 * 60000)),
    x(Math.min(current.to, info.archiveEnd + 40 * 60000)),
  ];
  if (info.archiveStart - current.from < current.to - info.archiveEnd) blankEdges.reverse();
  await page.mouse.move(blankEdges[0], box.y + 40);
  await page.mouse.down();
  await page.mouse.move(blankEdges[1], box.y + 40, {
    steps: 12,
  });
  await page.waitForFunction(
    ({ from, to }) => {
      const drawing = document.querySelector('.range-selection.is-drawing');
      const left = Number(drawing?.getAttribute('data-from'));
      const right = Number(drawing?.getAttribute('data-to'));
      return (
        drawing?.getAttribute('aria-hidden') === 'false' &&
        left <= from &&
        right >= to &&
        (left < from || right > to)
      );
    },
    { from: info.archiveStart, to: info.archiveEnd },
  );
  assert.equal(await page.locator('.selection-caption').count(), 0);
  assert.equal(await lane().getAttribute('title'), null);
  assert.equal(await lane().locator('[title]').count(), 0);
  assert.equal(
    await page
      .locator('.range-selection')
      .evaluate((node) => node.getAnimations().some((a) => a.id === 'media-layout')),
    false,
  );
  await page.mouse.up();
  await page.locator('.inline-player[aria-label="录像播放器"]').waitFor({ timeout: 30000 });
  await page.locator('[aria-label="所选跨度"]').waitFor({ state: 'attached' });
  const selected = await page
    .locator('.range-selection[aria-hidden="false"]')
    .evaluate((element) => ({
      from: Number(element.dataset.from),
      to: Number(element.dataset.to),
    }));
  assert.equal(selected.from, info.archiveStart);
  assert.equal(selected.to, info.archiveEnd);
  const emptyLanes = page.locator(
    '.track-row:not(:has(.track-clip)) .track-lane[aria-busy="false"]',
  );
  const emptyIndex = await emptyLanes.evaluateAll((nodes) =>
    nodes.findIndex((node) => {
      const row = node.getBoundingClientRect();
      const viewport = node.closest('.track-table-scroll').getBoundingClientRect();
      return row.top + 40 > viewport.top && row.top + 40 < Math.min(viewport.bottom, innerHeight);
    }),
  );
  assert(emptyIndex >= 0, 'The fixture must expose an empty row without changing list position');
  const emptyLane = emptyLanes.nth(emptyIndex);
  const emptyId = await emptyLane.evaluate((node) => node.closest('.track-row').dataset.subjectId);
  const emptyBox = await emptyLane.boundingBox();
  let emptyBoundaryRequests = 0;
  const watchEmptyBounds = (request) => {
    if (request.url().includes(`/subjects/${encodeURIComponent(emptyId)}/recording-bounds`))
      emptyBoundaryRequests++;
  };
  page.on('request', watchEmptyBounds);
  const emptyResponse = page.waitForResponse((response) =>
    response.url().includes(`/subjects/${encodeURIComponent(emptyId)}/recording-bounds`),
  );
  const boundsPattern = `**/api/subjects/${encodeURIComponent(emptyId)}/recording-bounds?*`;
  await page.route(boundsPattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.mouse.move(blankEdges[0], emptyBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(blankEdges[1], emptyBox.y + 40, { steps: 12 });
  await page
    .locator(`.range-selection.is-drawing[data-selected-subject="${emptyId}"][aria-hidden="false"]`)
    .waitFor();
  await page.mouse.up();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await page
      .locator(`.range-selection[data-selected-subject="${emptyId}"][aria-hidden="false"]`)
      .count(),
    0,
  );
  assert.equal((await (await emptyResponse).json()).fromMs, null);
  await page.unroute(boundsPattern);
  page.off('request', watchEmptyBounds);
  assert.equal(
    emptyBoundaryRequests,
    1,
    'Release validates the archive once after clearing the empty draft',
  );
  assert.deepEqual(
    await page
      .locator(`.range-selection[data-selected-subject="${info.subjectId}"]`)
      .evaluate((node) => ({ from: Number(node.dataset.from), to: Number(node.dataset.to) })),
    selected,
  );
  assert.equal(
    await page
      .locator(
        '.range-selection.is-empty,.range-selection.is-error,.range-selection.is-pending,.selection-caption',
      )
      .count(),
    0,
  );
  await page.waitForFunction(() => {
    const focus = document.querySelector('.viewer-focus');
    const cells = [...document.querySelectorAll('.snapshot-cell')];
    return (
      cells.length > 0 &&
      cells.every(
        (cell) =>
          Number(cell.dataset.at) >= Number(focus.dataset.from) &&
          Number(cell.dataset.at) < Number(focus.dataset.to),
      )
    );
  });
  assert(selected.to <= Date.now());
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video[data-media-slot="active"]');
      return video?.readyState >= 2 && !video.paused && video.currentTime > 0;
    },
    null,
    { timeout: 30000 },
  );
  assert.equal(await page.locator('.player-picture .form-error').count(), 0);
  const focusBox = await page.locator('.focus-lane').boundingBox();
  await page.mouse.move(focusBox.x + focusBox.width * 0.2, focusBox.y + focusBox.height / 2);
  assert.equal(
    await page.locator('.focus-lane').evaluate((node) => getComputedStyle(node).cursor),
    'pointer',
  );
  await page.mouse.down();
  await page.locator('.focus-lane[data-scrubbing="true"]').waitFor();
  assert.equal(
    await page.locator('.focus-lane').evaluate((node) => getComputedStyle(node).cursor),
    'grabbing',
  );
  const playheadStyle = await page.locator('.focus-playhead').evaluate((node) => ({
    width: getComputedStyle(node).width,
    layer: getComputedStyle(node).zIndex,
    cap: getComputedStyle(node, '::before').content,
  }));
  assert.equal(playheadStyle.width, '3px');
  assert.equal(playheadStyle.layer, '4');
  assert.notEqual(playheadStyle.cap, 'none');
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video?.currentTime >= 20 && video.readyState >= 2 && !video.seeking;
  });
  await page.mouse.move(focusBox.x + focusBox.width * 0.4, focusBox.y + focusBox.height / 2, {
    steps: 5,
  });
  await page.waitForFunction(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video?.currentTime >= 40 && video.readyState >= 2 && !video.seeking;
  });
  await page.mouse.up();
  assert.equal(
    await page.locator('.focus-lane').evaluate((node) => getComputedStyle(node).cursor),
    'pointer',
  );
  await page.screenshot({ path: path.join(outputRoot, 'player-playhead.png') });
  await page.locator('.inline-player').focus();
  assert.equal(
    await page.locator('.inline-player').evaluate((node) => getComputedStyle(node).outlineStyle),
    'none',
    'Keyboard playback ownership must not outline the entire player and screenshot surface',
  );
  const beforeArrow = await page
    .locator('video[data-media-slot="active"]')
    .evaluate((video) => video.currentTime);
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction((before) => {
    const video = document.querySelector('video[data-media-slot="active"]');
    return video?.currentTime >= before + 8 && video.readyState >= 2 && !video.seeking;
  }, beforeArrow);
  await page.keyboard.up('ArrowRight');
  report.checks.continuousSeek = { framesDuringHeldPointer: true, framesBeforeArrowRelease: true };
  report.checks.selection = {
    exactBounds: selected,
    normalArchivePlayback: true,
  };
  const replayFrame = await frameBounds();
  for (const [selector, before] of Object.entries(idleFrame))
    for (const key of ['x', 'y', 'width', 'height'])
      assert(
        Math.abs(before[key] - replayFrame[selector][key]) < 1,
        selector + ' shifted during replay at ' + key,
      );
  await wakeChrome();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await wakeChrome();
  // Verify the fullscreen portal via keyboard focus, which pins auto-hiding
  // controls throughout the test rather than racing their one-second idle timer.
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: '视频 CDN', exact: true }).press('Enter');
  const fullCdn = page.getByRole('dialog', { name: '视频 CDN', exact: true });
  await fullCdn.waitFor();
  assert.equal(await fullCdn.evaluate((node) => document.fullscreenElement.contains(node)), true);
  await fullCdn.locator('.routing-item[aria-pressed="true"]').waitFor();
  assert.equal(await fullCdn.locator('.routing-item').count(), 4);
  assert.equal(await fullCdn.getByRole('button', { name: '重新测速', exact: true }).count(), 1);
  await page.screenshot({ path: path.join(outputRoot, 'cdn-fullscreen.png') });
  await fullCdn.getByRole('button', { name: '关闭浮窗', exact: true }).click();
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
  report.checks.cdnRouting.fullscreenPortal = true;
  await page.waitForFunction(() => !document.querySelector('.snapshot-page-next'));
  const fullGeometry = await page.evaluate(() => {
    const root = document.fullscreenElement;
    const grid = root.querySelector('.snapshot-grid');
    const picture = root.querySelector('.player-picture').getBoundingClientRect();
    const shots = root.querySelector('.snapshot-section').getBoundingClientRect();
    return {
      sections: document.querySelectorAll('.snapshot-section').length,
      scroll: getComputedStyle(grid).overflowY,
      floating: shots.right <= picture.right && shots.left >= picture.left,
      fillsViewport:
        Math.abs(
          root.querySelector('.player-stage').getBoundingClientRect().height - root.clientHeight,
        ) < 1,
      inside: root.contains(grid),
      compactTimeline:
        !root.querySelector('.viewer-focus .timeline-ruler') &&
        root.querySelector('.viewer-focus').getBoundingClientRect().height === 32,
      portInside: !!root.querySelector('.connection-close'),
    };
  });
  assert.deepEqual(fullGeometry, {
    sections: 1,
    scroll: 'hidden',
    floating: true,
    fillsViewport: true,
    inside: true,
    compactTimeline: true,
    portInside: true,
  });
  await page.screenshot({ path: path.join(outputRoot, 'fullscreen-snapshots.png') });
  // Folding restores full-width chrome; the expanded sidebar also leaves all
  // player controls reachable in the remaining picture region.
  await page.getByRole('button', { name: '收起截图面板', exact: true }).click();
  await page.locator('.media-review').waitFor({ state: 'hidden' });
  await wakeChrome();
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  const heart = page.locator('.snapshot-favorite').first();
  // Lose a completed write's response, hold its readback, then start a newer
  // operation. The old reconciliation must not release its lock or selection.
  let holdReads = false,
    readStarted,
    releaseReads;
  const reading = new Promise((resolve) => (readStarted = resolve));
  const readGate = new Promise((resolve) => (releaseReads = resolve));
  const lostLike = async (route) => {
    await route.fetch();
    holdReads = true;
    await route.abort('failed');
  };
  const delayedRead = async (route) => {
    if (holdReads) {
      readStarted();
      await readGate;
    }
    await route.continue();
  };
  await page.route('**/api/subjects/*/unit-favorites/query', delayedRead);
  await page.route('**/api/subjects/*/unit-favorites', lostLike);
  try {
    await heart.click();
    await reading;
    await page
      .locator('.snapshot-actions')
      .getByRole('button', { name: '删除所有非喜欢', exact: true, includeHidden: true })
      .click();
    await page.getByRole('dialog', { name: '删除所有非喜欢', exact: true }).waitFor();
    holdReads = false;
    releaseReads();
    await page.waitForTimeout(300);
    // Planning no longer holds a grid command lock. A late favorite read must
    // preserve the independently owned range confirmation dialog.
    assert.equal(await page.locator('.snapshot-grid').getAttribute('aria-busy'), 'false');
    assert(await page.getByRole('dialog', { name: '删除所有非喜欢', exact: true }).isVisible());
    assert(await page.getByRole('button', { name: '确认删除', exact: true }).isEnabled());
    await page
      .getByRole('dialog', { name: '删除所有非喜欢', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await wakeSnapshots();
    await page.waitForFunction(
      () => document.querySelector('.snapshot-favorite')?.getAttribute('aria-pressed') === 'true',
    );
    report.checks.uncertainMutation = {
      completedWriteRecovered: true,
      oldReadPreservesRangeDialog: true,
    };
  } finally {
    releaseReads();
    await page.unroute('**/api/subjects/*/unit-favorites/query', delayedRead);
    await page.unroute('**/api/subjects/*/unit-favorites', lostLike);
  }
  await heart.click();
  await page.waitForFunction(
    () => document.querySelector('.snapshot-favorite')?.getAttribute('aria-pressed') === 'false',
  );
  await heart.click();
  await page.waitForFunction(
    () => document.querySelector('.snapshot-favorite')?.getAttribute('aria-pressed') === 'true',
  );
  await heart.click();
  await page.waitForFunction(
    () => document.querySelector('.snapshot-favorite')?.getAttribute('aria-pressed') === 'false',
  );
  assert.equal(
    await page.locator('.snapshot-cell button[data-unit-index][aria-pressed]').count(),
    0,
  );

  // Exercise real unit pagination with 90 recording units, reusing a decoded JPEG.
  const historyWindow = await fixture.seedSnapshotHistory();
  if (historyWindow.fromMs < (await view()).from) await setDays(2);
  await revealInterval(historyWindow);
  const historyView = await view(),
    historyBox = await lane().boundingBox();
  const historyX = (at) =>
    historyBox.x +
    ((at - historyView.from) / (historyView.to - historyView.from)) * historyBox.width;
  const historyBounds = page.waitForResponse((response) =>
    response.url().includes(`/subjects/${encodeURIComponent(info.subjectId)}/recording-bounds`),
  );
  // At a multi-day scale one second is subpixel; leave a real pointer-sized
  // margin so browser coordinate quantization cannot land inside the first fragment.
  await page.mouse.move(historyX(historyWindow.fromMs) - 2, historyBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(historyX(historyWindow.toMs) + 2, historyBox.y + 40, { steps: 8 });
  await page.mouse.up();
  const historyBoundsValue = await (await historyBounds).json();
  assert.deepEqual(
    { fromMs: historyBoundsValue.fromMs, toMs: historyBoundsValue.toMs },
    historyWindow,
  );
  await page.waitForFunction(({ fromMs, toMs }) => {
    const node = document.querySelector('.viewer-focus');
    return Number(node?.dataset.from) === fromMs && Number(node?.dataset.to) === toMs;
  }, historyWindow);
  const historyPacket = await (
    await context.request.get(
      `${origin}/api/subjects/${encodeURIComponent(info.subjectId)}/snapshot-pages?at=${historyWindow.fromMs}&from=${historyWindow.fromMs}&to=${historyWindow.toMs}&limit=30`,
    )
  ).json();
  const historyJpeg = historyPacket.items[0].url;
  const scrollPages = async (route) => {
    const response = await route.fetch();
    const packet = await response.json();
    await route.fulfill({
      response,
      json: {
        ...packet,
        items: packet.items.map((item) => ({ ...item, url: historyJpeg })),
      },
    });
  };
  await page.route('**/snapshot-pages?*', scrollPages);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] })),
  );
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages output')?.textContent === '1 / 3',
  );
  // Cross the final fragment of unit 29 using the real video clock, then
  // verify pagination and the current-unit indication follow together.
  await page.locator('video[data-media-slot="active"]').evaluate(async (video) => {
    video.currentTime = 59.7;
    await video.play();
  });
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('.snapshot-pages output')?.textContent === '2 / 3' &&
        !!document.querySelector('.snapshot-cell button[aria-current="time"]'),
    );
  } catch (error) {
    console.error(
      '[qa] Unit page follow failed',
      await page.evaluate(() => ({
        page: document.querySelector('.snapshot-pages output')?.textContent,
        focus: { ...document.querySelector('.viewer-focus')?.dataset },
        media: [...document.querySelectorAll('video')].map((video) => ({
          slot: video.dataset.mediaSlot,
          time: video.currentTime,
          duration: video.duration,
          paused: video.paused,
          ready: video.readyState,
        })),
        cells: [...document.querySelectorAll('.snapshot-cell')].map((cell) => ({
          key: cell.dataset.key,
          at: cell.dataset.at,
          playing: cell.querySelector('button').getAttribute('aria-current'),
          image: !!cell.querySelector('img'),
        })),
      })),
      { anchors: historyPacket.pageAnchors },
    );
    throw error;
  }
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  await wakeSnapshots();
  await turnSnapshots(-1);
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages output')?.textContent === '1 / 3',
  );
  await turnSnapshots(1);
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages output')?.textContent === '2 / 3',
  );
  await wakeSnapshots();
  await turnSnapshots(-1);
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages output')?.textContent === '1 / 3',
  );
  await wakeSnapshots();
  assert.equal(await page.locator('.snapshot-actions button').count(), 2);
  await page.unroute('**/snapshot-pages?*', scrollPages);
  await fixture.resetSnapshotHistory();
  await page.reload();
  await lane().waitFor();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] })),
  );
  await page.waitForFunction(
    () => !document.fullscreenElement && document.querySelectorAll('.snapshot-cell').length === 2,
  );
  // Reset removed the active historical unit. Restoring its explicit identity
  // must fail, rather than selecting another same-time source. Establish a real
  // surviving connection before testing persistence of that connection below.
  const survivingCard = page.locator('.snapshot-cell button[data-unit-index]').first();
  const survivingUnit = await survivingCard.getAttribute('data-key');
  const survivingPlayback = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/playback',
  );
  await survivingCard.click();
  const survivingResponse = await survivingPlayback;
  assert.equal(survivingResponse.request().postDataJSON().unitId, survivingUnit);
  assert.equal(survivingResponse.status(), 200);
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  // A thumbnail seek preserves the old presentation range. The first successful
  // restore after external fixture deletion normalizes it to surviving bounds;
  // subsequent restores must preserve both that range and the explicit unit.
  const canonicalPlayback = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/playback',
  );
  await page.reload();
  assert.equal((await canonicalPlayback).postDataJSON().unitId, survivingUnit);
  await page.waitForFunction(
    () =>
      document.querySelector('video[data-media-slot="active"]')?.readyState >= 2 &&
      document.querySelector('[aria-label="所选跨度"]')?.textContent === '2分钟',
  );
  report.checks.fullscreen = true;
  console.log('[qa] Archive range selection, playback and fullscreen passed');
  const reloadRange = await page.locator('[aria-label="所选跨度"]').textContent();
  const reloadedPlayback = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/playback',
  );
  await page.reload();
  assert.equal((await reloadedPlayback).postDataJSON().unitId, survivingUnit);
  await page.locator('.inline-player[aria-label="录像播放器"]').waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  assert.equal(await page.locator('[aria-label="所选跨度"]').textContent(), reloadRange);
  report.checks.reloadArchiveConnection = true;
  assert.equal(await page.getByRole('button', { name: '喜欢此刻', exact: true }).count(), 0);
  assert.equal(
    await page.locator('.snapshot-cell button[data-unit-index][aria-pressed]').count(),
    0,
  );
  await wakeSnapshots();
  await page.locator('.snapshot-favorite').first().click();
  await page.locator('.snapshot-favorite[aria-pressed="true"]').first().waitFor();
  assert.equal(await page.locator('.track-favorite-range').count(), 0);
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'false',
  );
  await page.getByRole('button', { name: '取消所有喜欢', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.snapshot-favorite[aria-pressed="true"]'),
  );
  report.checks.rangeFavorites = { individualHeart: true, unlikeRange: true };
  const snapshot = await context.request.get(
    `${origin}/api/subjects/${encodeURIComponent(info.subjectId)}/snapshots/${info.archiveStart + 1000}.jpg`,
  );
  assert.equal(
    snapshot.status(),
    200,
    `Snapshot HTTP ${snapshot.status()}: ${snapshot.status() === 200 ? '' : await snapshot.text()}`,
  );
  const jpeg = await snapshot.body();
  await fixture.verifySnapshot(jpeg);
  await writeFile(path.join(outputRoot, 'snapshot.jpg'), jpeg);
  report.checks.snapshot = {
    ffmpegDecodedAndVerified: true,
    bytes: jpeg.length,
    runtime: info.ffmpeg,
  };
  assert.equal(await page.locator('.timeline-filmstrip').count(), 0);
  assert.equal(
    await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => entry.name.includes('snapshot-samples')).length,
    ),
    0,
  );
  await wakeChrome();
  await page.screenshot({ path: path.join(outputRoot, 'desktop.png') });
  report.checks.playerLayout.replayGap = await playerSpacing();
  assert((await playerSpacing()) <= 16);
  const rangeDuration = await page.getByLabel('所选跨度', { exact: true }).textContent();
  assert.equal(rangeDuration, '2分钟');
  await page
    .locator('.selection-summary')
    .screenshot({ path: path.join(outputRoot, 'selected-time-range.png') });
  report.checks.selectionSummary = {
    liveCapacity: 30,
    selected: rangeDuration,
    secondsOnly: true,
  };
  const beforeLanguage = await active().evaluate((video) => ({
    time: video.currentTime,
    src: video.currentSrc,
  }));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: 'Language / 语言', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await settleGlass();
  await verifyPanel();
  report.checks.directoryLayout.english = await verifyDirectoryLayout();
  assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
  const afterLanguage = await active().evaluate((video) => ({
    time: video.currentTime,
    src: video.currentSrc,
  }));
  assert.equal(afterLanguage.src, beforeLanguage.src);
  assert(afterLanguage.time >= beforeLanguage.time);
  await page.screenshot({ path: path.join(outputRoot, 'english.png') });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Language / 语言', exact: true }).press('ArrowLeft');
  await page.keyboard.press('Escape');
  report.checks.language = { english: true, chinese: true, keepsPlayback: true };
  await page.getByRole('button', { name: '关闭播放器', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.connection-rail[data-connected="true"]'),
  );
  await page.waitForFunction(() => !document.querySelector('video'));
  assert.equal(await page.locator('video').count(), 0);
  await wakeChrome();
  assert.deepEqual(await frameBounds(), idleFrame);
  report.checks.unplug = { closed: true, layoutRetained: true };
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: 'Language / 语言', exact: true }).press('ArrowRight');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Language / 语言', exact: true }).press('ArrowLeft');
  await page.keyboard.press('Escape');
  report.checks.language.persistsAfterReload = true;
  await lane().waitFor();
  const scroller = page.locator('.track-table-scroll');
  const scrollAnchor = () =>
    scroller.evaluate((root) => {
      const top = root.getBoundingClientRect().top;
      const row = [...root.querySelectorAll('.track-row')].find(
        (row) => row.getBoundingClientRect().bottom > top + 1,
      );
      return {
        id: row.dataset.subjectId,
        offset: row.getBoundingClientRect().top - top,
        top: root.scrollTop,
      };
    });
  await scroller.evaluate((root, height) => {
    root.scrollTop = 10 * height + 17;
  }, subjectRowHeight);
  await page.waitForTimeout(100);
  const anchored = await scrollAnchor();
  let refreshedSubjects = await (await context.request.get(`${origin}/api/subjects`)).json();
  await context.route('**/api/subjects', (route) => route.fulfill({ json: refreshedSubjects }));
  const refreshSubjects = async () => {
    const response = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/subjects',
    );
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
    );
    await response;
    await page.waitForTimeout(150);
    // Sorting now has a visible 360ms transition. Assert the same final anchor
    // after motion settles, rather than sampling its intentionally moving pixels.
    await page.waitForFunction(() => !document.querySelector('[data-row-motion="true"]'));
  };
  await refreshSubjects();
  assert.deepEqual(await scrollAnchor(), anchored);
  refreshedSubjects = refreshedSubjects.map((subject) =>
    // PUBLIC → PRIVATE reorders within Online; OFFLINE now intentionally leaves this filter.
    subject.id === anchored.id ? { ...subject, providerStatus: 'PRIVATE' } : subject,
  );
  await refreshSubjects();
  let afterRefresh = await scrollAnchor();
  assert.notEqual(afterRefresh.id, anchored.id);
  assert.equal(afterRefresh.offset, anchored.offset);
  assert.equal(
    afterRefresh.top,
    anchored.top,
    'browse the neighbors instead of following the moved row',
  );
  const browsingAnchor = afterRefresh;
  const memberToRemove = refreshedSubjects.find(
    (subject) => subject.id !== browsingAnchor.id && subject.providerStatus === 'PUBLIC',
  ).id;
  refreshedSubjects = refreshedSubjects.filter((subject) => subject.id !== memberToRemove);
  await refreshSubjects();
  afterRefresh = await scrollAnchor();
  assert.equal(afterRefresh.id, browsingAnchor.id);
  assert.equal(afterRefresh.offset, browsingAnchor.offset);
  await page.waitForTimeout(5500);
  assert.deepEqual(await scrollAnchor(), afterRefresh);
  await page.reload();
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll('.track-row')].some((row) => row.dataset.subjectId === id),
    afterRefresh.id,
  );
  await page.waitForFunction(() => !document.querySelector('[data-row-motion="true"]'));
  assert.deepEqual(await scrollAnchor(), afterRefresh);
  report.checks.reloadListAnchor = true;
  const dragBox = await scroller.boundingBox();
  await page.mouse.move(dragBox.x + 20, dragBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + 20, dragBox.y + 180, { steps: 4 });
  await page.waitForTimeout(100);
  const heldAnchor = await scrollAnchor();
  const removedId = refreshedSubjects.find((subject) => subject.providerStatus === 'PUBLIC').id;
  refreshedSubjects = refreshedSubjects.filter((subject) => subject.id !== removedId);
  await refreshSubjects();
  const heldAfter = await scrollAnchor();
  assert.equal(heldAfter.id, heldAnchor.id);
  assert.equal(heldAfter.offset, heldAnchor.offset);
  await page.mouse.move(dragBox.x + 20, dragBox.y + 170, { steps: 2 });
  await page.waitForTimeout(100);
  assert.equal((await scrollAnchor()).top, heldAfter.top + 10);
  await page.mouse.up();
  assert((await scroller.locator('.track-row').count()) < 25);
  await context.unroute('**/api/subjects');
  await refreshSubjects();
  const offlineSamples = (await (await context.request.get(`${origin}/api/subjects`)).json())
    .filter(
      (subject) => !subject.archived && !['PUBLIC', 'PRIVATE'].includes(subject.providerStatus),
    )
    .slice(0, 4);
  const ranked = offlineSamples.map((subject, index) => ({
    ...subject,
    lastRecordedAtMs: index === 3 ? 4000 : index === 2 ? 3000 : null,
    lastOnlineAtMs: index === 1 ? 9999 : null,
  }));
  await context.route('**/api/subjects', (route) => route.fulfill({ json: ranked }));
  await refreshSubjects();
  await page.locator('.subject-filters').getByRole('button', { name: '离线', exact: true }).click();
  assert.equal(await scroller.evaluate((root) => root.scrollTop), 0);
  const rankedIds = () =>
    scroller.locator('.track-row').evaluateAll((rows) => rows.map((row) => row.dataset.subjectId));
  const expectedRank = [ranked[3].id, ranked[2].id, ranked[1].id, ranked[0].id];
  assert.deepEqual(await rankedIds(), expectedRank);
  ranked.reverse();
  await refreshSubjects();
  assert.deepEqual(await rankedIds(), expectedRank);
  await context.unroute('**/api/subjects');
  await refreshSubjects();
  report.checks.offlineActivity = {
    recordingsFirst: true,
    onlineHistoryFallback: true,
    stableAcrossRefresh: true,
  };
  await page.locator('.subject-filters').getByRole('button', { name: '在线', exact: true }).click();
  report.checks.scrollStability = {
    unchangedRefresh: true,
    statusReorder: true,
    membershipChange: true,
    acrossSyncTick: true,
    filterResets: true,
    boundedRows: true,
    heldDragAcrossRefresh: true,
  };
  await page.screenshot({ path: path.join(outputRoot, 'idle.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: '当前窗口尺寸不受支持' }).waitFor();
  const mobile = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  assert.equal(mobile.viewport, mobile.width);
  report.checks.mobile = mobile;
  await page.screenshot({ path: path.join(outputRoot, 'mobile.png') });
  await page.setViewportSize({ width: 768, height: 1024 });
  for (const [index, name] of ['账户', '密钥', '设置', '历史'].entries()) {
    if (name === '密钥') await wakeChrome();
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('dialog', { name, exact: true }).waitFor();
    await settleGlass();
    await verifyPanel();
    await page.screenshot({ path: path.join(outputRoot, `panel-tablet-${index}.png`) });
    await page.keyboard.press('Escape');
  }
  report.checks.panelLayout = {
    sharedHierarchy: true,
    delayedCookieFeedback: true,
    english: true,
    tabletPortrait: true,
    titleAndCloseAligned: true,
  };
  // Batch management uses only the synthetic archive. Destructive checks run last.
  await page.setViewportSize({ width: 1440, height: 900 });
  await lane().waitFor();
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  await page.locator('.snapshot-cell').first().waitFor();
  const cells = page.locator('.snapshot-cell');
  assert((await cells.count()) >= 2);
  await page.locator('.track-label .track-cover').first().waitFor();
  const coverFits = await page
    .locator('.track-label')
    .first()
    .evaluate((label) => {
      const original = label.className;
      try {
        return Object.fromEntries(
          ['public', 'private', 'offline', 'unknown'].map((status) => {
            label.className = `track-label status-cell-${status}`;
            return [status, getComputedStyle(label.querySelector('.track-cover')).objectFit];
          }),
        );
      } finally {
        label.className = original;
      }
    });
  assert.deepEqual(coverFits, {
    public: 'contain',
    private: 'contain',
    offline: 'cover',
    unknown: 'contain',
  });
  report.checks.coverFitByStatus = coverFits;
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForFunction(() => {
      const button = document.querySelector('.connection-close')?.getBoundingClientRect();
      const frame = document.querySelector('.studio-viewer').getBoundingClientRect();
      return !button || (button.width === 32 && Math.abs(button.top - frame.top) < 2);
    });
    const geometry = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const image = rect('.snapshot-cell button > div');
      const grid = rect('.snapshot-grid');
      const section = rect('.snapshot-section');
      const header = rect('.snapshot-pages');
      const focus = rect('.viewer-focus');
      const picture = rect('.player-picture');
      const actions = rect('.player-actions');
      const summary = rect('.player-actions .selection-summary');
      const viewer = document.querySelector('.studio-viewer');
      return {
        pictureFills:
          picture.left < actions.left &&
          picture.right > actions.right &&
          picture.top < actions.top &&
          picture.bottom > actions.bottom,
        pictureRatio: picture.width / picture.height,
        summaryInline:
          Math.abs(summary.top + summary.height / 2 - actions.top - actions.height / 2) < 1 &&
          summary.left >= rect('.player-audio').right &&
          summary.right <= rect('.player-actions .key-tool').left,
        gridFills:
          grid.width <= section.width + 1 &&
          Math.abs(grid.left + grid.width / 2 - section.left - section.width / 2) < 1,
        noDesktopOverflow: viewer.scrollHeight <= viewer.clientHeight + 1,
        ratio: image.width / image.height,
        fits: grid.bottom <= section.bottom + 1 && grid.top >= section.top,
        toolsBetween: header.top >= focus.bottom && header.bottom <= grid.top + 1,
      };
    });
    assert(Math.abs(geometry.ratio - 16 / 9) < 0.03, JSON.stringify(geometry));
    assert(geometry.fits && geometry.toolsBetween, JSON.stringify(geometry));
    assert(
      geometry.pictureFills &&
        geometry.gridFills &&
        geometry.noDesktopOverflow &&
        geometry.summaryInline,
      JSON.stringify({ size, ...geometry }),
    );
    assert(Math.abs(geometry.pictureRatio - 16 / 9) < 0.01, JSON.stringify(geometry));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await wakeSnapshots();
  assert.equal(await page.locator('.snapshot-actions button').count(), 2);
  await page.emulateMedia({ contrast: 'more' });
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    window.__surfaceMotion = [];
    window.__restoreSurfaceAnimate = () => (Element.prototype.animate = animate);
    Element.prototype.animate = function (frames, options) {
      if (this.matches('.toolbar-popover'))
        window.__surfaceMotion.push({ frames, duration: options.duration });
      return animate.call(this, frames, options);
    };
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const accessiblePanel = page.getByRole('dialog', { name: '设置', exact: true });
  await accessiblePanel.waitFor();
  const accessibility = await accessiblePanel.evaluate((node) => ({
    blur: getComputedStyle(node).backdropFilter,
    motion: window.__surfaceMotion,
  }));
  await page.evaluate(() => window.__restoreSurfaceAnimate());
  assert.equal(accessibility.blur, 'none');
  assert.equal(accessibility.motion.length, 1, 'Opening must start one shared surface animation');
  assert.equal(accessibility.motion[0].duration, 320);
  assert.equal(accessibility.motion[0].frames.length, 4);
  assert.equal(accessibility.motion[0].frames[1].transform, 'scale(1.012, 1.01)');
  assert.equal(accessibility.motion[0].frames.at(-1).transform, 'none');
  await page.keyboard.press('Escape');
  await accessiblePanel.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('dialog', { name: '设置', exact: true }).count(), 0);
  assert(
    await page
      .getByRole('button', { name: '设置', exact: true })
      .evaluate((node) => node === document.activeElement),
  );
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page
    .getByRole('dialog', { name: '设置', exact: true })
    .getByRole('button', { name: '关闭浮窗' })
    .click();
  assert(
    await page
      .getByRole('button', { name: '设置', exact: true })
      .evaluate((node) => node === document.activeElement),
  );
  await page.emulateMedia({
    contrast: 'no-preference',
    forcedColors: 'active',
  });
  assert.equal(
    await page.locator('.topbar').evaluate((node) => getComputedStyle(node).backdropFilter),
    'none',
  );
  await page.emulateMedia({ forcedColors: 'none' });
  const mediaSession = await context.newCDPSession(page);
  await mediaSession.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  const transparencySupported = await page.evaluate(
    () => matchMedia('(prefers-reduced-transparency: reduce)').matches,
  );
  if (transparencySupported)
    assert.equal(
      await page.locator('.topbar').evaluate((node) => getComputedStyle(node).backdropFilter),
      'none',
    );
  await mediaSession.send('Emulation.setEmulatedMedia', { features: [] });
  await mediaSession.detach();
  report.checks.glassAccessibility = {
    ...accessibility,
    focusRestored: true,
    forcedColors: true,
    reducedTransparency: transparencySupported,
  };
  const touchContext = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
    storageState: await context.storageState(),
  });
  try {
    await touchContext.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === origin) await route.continue();
      else {
        externalRequests.push(route.request().url());
        await route.abort('blockedbyclient');
      }
    });
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', (error) => errors.push(error.message));
    await touchPage.goto(origin);
    const settingsButton = touchPage.getByRole('button', { name: '设置', exact: true });
    await settingsButton.waitFor();
    const touchTargets = await touchPage
      .locator('.header-tools button, .account-tool .tool-trigger, .day-step')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
      );
    assert(
      touchTargets.every((box) => box.width >= 44 && box.height >= 44),
      JSON.stringify(touchTargets),
    );
    await settingsButton.tap();
    await touchPage.getByRole('dialog', { name: '设置', exact: true }).waitFor();
    await touchPage.locator('.toolbar-popover').evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
    });
    await touchPage.screenshot({ path: path.join(outputRoot, 'glass-touch.png') });
    report.checks.glassTouch = { targets44px: true, touchOpen: true };
  } finally {
    await touchContext.close();
  }
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('heading', { name: 'PIN 解锁', exact: true }).waitFor();
  assert.equal(await page.locator('.auth-card input[type="password"]').count(), 1);
  assert.equal(await page.locator('.auth-card select').count(), 0);
  await page.screenshot({ path: path.join(outputRoot, 'auth-login.png') });
  await page.getByRole('button', { name: '中文 / English', exact: true }).click();
  await page.getByRole('heading', { name: 'Unlock with PIN', exact: true }).waitFor();
  await page.getByRole('button', { name: '中文 / English', exact: true }).click();
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.getByRole('button', { name: '设置', exact: true }).waitFor();
  report.checks.authLayout = {
    cornerLanguageIcon: true,
    directToggle: true,
    focusedFields: true,
    loginWorks: true,
  };
  assert.deepEqual(errors, []);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(retiredRequests, []);
  report.checks.viewingHistoryRemoved = {
    noCollectionRequests: true,
    noTimelineOrScreenshotMarkers: true,
  };
  report.passed = true;
  console.log('[qa] Browser acceptance passed');
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(`[qa] Browser acceptance failed: ${error.stack ?? error}`);
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: path.join(outputRoot, 'failure.png') });
    } catch (captureError) {
      console.error(`[qa] Failure screenshot unavailable: ${captureError.message}`);
    }
  }
} finally {
  const cleanupErrors = [];
  for (const cleanup of [() => context?.close(), () => browser?.close(), () => fixture?.close()]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error.message);
      console.error(`[qa] Cleanup failed: ${error.message}`);
    }
  }
  if (cleanupErrors.length) {
    report.passed = false;
    report.cleanupErrors = cleanupErrors;
    process.exitCode = 1;
  }
  report.pageErrors = errors;
  report.serverErrors = serverErrors;
  report.externalRequests = externalRequests;
  await writeFile(path.join(outputRoot, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
