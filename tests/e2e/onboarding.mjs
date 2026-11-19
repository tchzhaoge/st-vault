import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { outputRoot } from './support/media.mjs';

const origin = 'http://127.0.0.1:10085';
const report = { synthetic: true, productionCredentialsRead: false, checks: {}, passed: false };
const errors = [];
let browser, fixture, context, page;
async function openPage(extraCookies = []) {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (extraCookies.length) await context.addCookies(extraCookies);
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__pinErrorAnimations = 0;
    document.addEventListener('animationstart', (event) => {
      if (event.animationName === 'pin-error-shake' && event.target.matches('.auth-card'))
        window.__pinErrorAnimations++;
    });
  });
  await page.goto(origin);
}
async function cookieHeader(name) {
  const cookie = (await context.cookies()).find((item) => item.name === name);
  assert(cookie, `Expected ${name} cookie`);
  return `${name}=${cookie.value}`;
}
async function assertCannotManage(cookie) {
  const isolated = await browser.newContext();
  try {
    for (const endpoint of [
      '/api/subjects',
      '/api/settings',
      '/api/keys',
      '/api/keys/current',
      '/api/account-sync',
      '/api/account-sync/avatar',
      '/api/sync',
    ]) {
      const response = await isolated.request.get(origin + endpoint, { headers: { cookie } });
      assert.equal(response.status(), 401, `A restricted/retired cookie accessed ${endpoint}`);
    }
  } finally {
    await isolated.close();
  }
}
async function finishPin({ failSessionRead = false } = {}) {
  let setupRequests = 0,
    successfulSetups = 0,
    injected = false;
  const setupRoute = async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    setupRequests++;
    const response = await route.fetch();
    if (response.ok()) successfulSetups++;
    await route.fulfill({ response });
  };
  const sessionRoute = (route) => {
    if (successfulSetups && !injected && route.request().method() === 'GET') {
      injected = true;
      return route.fulfill({ status: 503, json: { error: 'synthetic_session_read_failure' } });
    }
    return route.continue();
  };
  if (failSessionRead) {
    await page.route('**/api/setup', setupRoute);
    await page.route('**/api/session', sessionRoute);
  }
  try {
    assert.equal(await page.getByRole('button', { name: '完成并进入', exact: true }).count(), 0);
    await page.getByLabel('设置 6 位 PIN', { exact: true }).fill('012345');
    await page.getByLabel('确认 PIN', { exact: true }).fill('012345');
    if (failSessionRead) {
      await page.getByRole('button', { name: '重试进入', exact: true }).waitFor();
      assert.equal(injected, true);
      await page.screenshot({ path: path.join(outputRoot, 'onboarding-resume.png') });
      await page.getByRole('button', { name: '重试进入', exact: true }).click();
    }
    await page.locator('.app-shell').waitFor();
    const session = await (await context.request.get(origin + '/api/session')).json();
    assert.equal(session.authenticated, true);
    assert.equal(session.credential, 'pin');
    assert.equal(session.setupAuthorized, false);
    if (failSessionRead) {
      assert.equal(
        setupRequests,
        1,
        'Recovery must read the session instead of resubmitting setup',
      );
      assert.equal(successfulSetups, 1);
    }
  } finally {
    if (failSessionRead) {
      await page.unroute('**/api/setup', setupRoute);
      await page.unroute('**/api/session', sessionRoute);
    }
  }
}

try {
  await mkdir(outputRoot, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
  });
  fixture = await startFixture({
    freshSetup: true,
  });
  await openPage();
  await page.getByLabel('设置 6 位 PIN', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('确认 PIN', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('Cookies', { exact: true }).count(), 0);
  const setupCookie = await cookieHeader('stv_setup');
  await assertCannotManage(setupCookie);
  const restrictedImport = await context.request.put(origin + '/api/account-sync', {
    data: { cookiesText: 'fixture=blocked', origin: 'https://stripchat.com' },
  });
  assert.equal(restrictedImport.status(), 401);
  const competitor = await browser.newContext();
  try {
    const response = await competitor.request.post(origin + '/api/setup/session', { data: {} });
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).error, 'setup_busy');
  } finally {
    await competitor.close();
  }
  await page.getByLabel('设置 6 位 PIN', { exact: true }).fill('012345');
  await page.getByLabel('确认 PIN', { exact: true }).fill('012346');
  await page.getByText('两次输入的 PIN 不一致。', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__pinErrorAnimations > 0);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.auth-card input')].every((input) => input.value === ''),
  );
  await page.screenshot({ path: path.join(outputRoot, 'onboarding-pin.png') });
  await finishPin({ failSessionRead: true });
  await assertCannotManage(setupCookie);
  await page.locator('.player-picture').hover();
  await page.getByRole('button', { name: '密钥', exact: true }).click();
  const keyPanel = page.getByRole('dialog', { name: '密钥', exact: true });
  const keyInput = keyPanel.getByRole('textbox', { name: '密钥名:密钥值', exact: true });
  const keyBorder = () =>
    keyInput.evaluate((input) => {
      const style = getComputedStyle(input);
      return ['Top', 'Right', 'Bottom', 'Left'].map(
        (side) =>
          style[`border${side}Width`] +
          ' ' +
          style[`border${side}Style`] +
          ' ' +
          style[`border${side}Color`],
      );
    });
  const idleBorder = await keyBorder();
  assert.equal(new Set(idleBorder).size, 1, 'All four edges should use the same border');
  assert.match(idleBorder[0], /^1px solid /);
  await keyInput.focus();
  const focusedBorder = await keyBorder();
  assert.equal(new Set(focusedBorder).size, 1, 'Focus should highlight all four edges');
  assert.notEqual(focusedBorder[0], idleBorder[0]);
  await keyInput.fill('onboarding sample-key');
  await keyPanel.getByRole('button', { name: '添加密钥', exact: true }).click();
  await keyPanel.getByText('请填写“密钥名:密钥值”。', { exact: true }).waitFor();
  assert.equal((await (await context.request.get(origin + '/api/keys')).json()).keyCount, 0);
  await keyInput.fill('onboarding:sample-key');
  await keyPanel.getByRole('button', { name: '添加密钥', exact: true }).click();
  await keyPanel.getByText('sample-key', { exact: true }).waitFor();
  await keyPanel.getByText('等待直播验证', { exact: true }).waitFor();
  assert.equal(await keyInput.inputValue(), '');
  await keyInput.fill('replacement : new-sample-key');
  await keyPanel.getByRole('button', { name: '更换密钥', exact: true }).click();
  await keyPanel.getByText('new-sample-key', { exact: true }).waitFor();
  assert.equal(await keyPanel.getByText('sample-key', { exact: true }).count(), 0);
  assert.equal((await (await context.request.get(origin + '/api/keys')).json()).keyCount, 1);
  await page.keyboard.press('Escape');
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name === 'stv_setup'),
    false,
  );
  const disconnected = await (await context.request.get(origin + '/api/account-sync')).json();
  assert.equal(disconnected.connected, false, 'PIN initialization must not require an account');
  const removedImport = await context.request.post(origin + '/api/account/import-list', {
    data: { cookiesText: 'fixture=removed' },
  });
  assert.equal(removedImport.status(), 404, 'The direct list-import shortcut must be removed');
  assert.equal(await page.getByLabel('Cookies', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page
    .getByLabel('Cookies', { exact: true })
    .fill(
      JSON.stringify([
        { name: 'fixture', value: 'onboarding', domain: '.stripchat.com', path: '/' },
      ]),
    );
  await page.getByRole('button', { name: '连接并同步', exact: true }).click();
  await page.waitForFunction(
    async () => (await (await fetch('/api/account-sync')).json()).connected,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  const rejectionAnimations = await page.evaluate(() => window.__pinErrorAnimations);
  await page.locator('.auth-card').evaluate(async (card) => {
    await Promise.all(card.getAnimations().map((animation) => animation.finished));
  });
  await page.getByLabel('6 位 PIN', { exact: true }).fill('999999');
  await page.getByText('PIN 不正确，请检查后重试。', { exact: true }).waitFor();
  await page.waitForFunction(
    (previous) => window.__pinErrorAnimations > previous,
    rejectionAnimations,
  );
  await page.waitForFunction(() => document.querySelector('input[name="pin"]')?.value === '');
  assert.equal(await page.getByRole('button', { name: '解锁', exact: true }).count(), 0);
  assert.equal(await page.locator('.pin-cell').count(), 6);
  assert.equal(await page.getByLabel('6 位 PIN', { exact: true }).getAttribute('type'), 'password');
  let loginRequests = 0;
  const countLogins = (request) => {
    if (new URL(request.url()).pathname === '/api/login' && request.method() === 'POST')
      loginRequests++;
  };
  page.on('request', countLogins);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('01234');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert(
    await page
      .locator('.auth-card')
      .evaluate((card) => Number(getComputedStyle(card).opacity) > 0.99),
    'Typing again after a rejected PIN must not restart the entrance fade',
  );
  assert.equal(loginRequests, 0, 'Five digits must not submit a partial PIN');
  assert.equal(await page.locator('.app-shell').count(), 0);
  assert.deepEqual(await page.locator('.pin-cell.is-filled').allTextContents(), Array(5).fill('•'));
  await page.screenshot({ path: path.join(outputRoot, 'onboarding-unlock.png') });
  await page.getByLabel('6 位 PIN', { exact: true }).press('5');
  await page.locator('.app-shell').waitFor();
  assert.equal(loginRequests, 1, 'The sixth digit must submit exactly once');
  page.off('request', countLogins);
  report.checks.fresh = {
    pinBeforeOptionalAccount: true,
    cookieJsonImport: true,
    restrictedSetup: true,
    competingClientDenied: true,
    confirmation: true,
    leadingZeroPin: true,
    maskedSixCells: true,
    automaticSubmit: true,
    partialPinDoesNotSubmit: true,
    rejectionShakeAndClear: true,
    retiredSetupCookie: true,
    committedSetupRecovery: true,
  };
  await context.close();
  context = undefined;
  await fixture.close();
  fixture = undefined;

  let reconnected = 0;
  const savedStatus = {
    connected: true,
    running: false,
    origin: 'https://stripchat.com',
    needsReconnect: false,
    lastAttemptMs: Date.now(),
    lastSuccessMs: Date.now(),
    nextAttemptMs: null,
    lastImportedCount: 299,
    error: null,
    profile: { username: 'Existing account', followingCount: 299, avatarUrl: null },
  };
  fixture = await startFixture({
    legacyPassword: 'synthetic-old-password',
    accountSync: {
      status: () => savedStatus,
      configure: () => {
        reconnected++;
        return Promise.reject(new Error('Existing account should be reused'));
      },
      refresh: () => Promise.resolve({ imported: 299, status: savedStatus }),
      disconnect: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
  });
  const legacyCookie = `stv_next=${fixture.legacyToken}`;
  await openPage([{ name: 'stv_next', value: fixture.legacyToken, url: origin }]);
  await page.getByLabel('原管理员密码', { exact: true }).fill('incorrect-old-password');
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await page.getByText('原管理员密码不正确，请检查后重试。', { exact: true }).waitFor();
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name === 'stv_setup'),
    false,
  );
  await assertCannotManage(legacyCookie);
  await page.getByLabel('原管理员密码', { exact: true }).fill('synthetic-old-password');
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await page.getByLabel('设置 6 位 PIN', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('账户密码', { exact: true }).count(), 0);
  const migrationCookie = await cookieHeader('stv_setup');
  await page.screenshot({ path: path.join(outputRoot, 'onboarding-migration.png') });
  await finishPin();
  const retainedAccount = await (await context.request.get(origin + '/api/account-sync')).json();
  assert.equal(retainedAccount.profile.username, 'Existing account');
  await assertCannotManage(legacyCookie);
  await assertCannotManage(migrationCookie);
  assert.equal(reconnected, 0);
  const newClient = await browser.newContext();
  try {
    const unlocked = await newClient.request.post(origin + '/api/login', {
      data: { pin: '012345' },
    });
    assert.equal(unlocked.status(), 200);
    assert.equal((await newClient.request.get(origin + '/api/subjects')).status(), 200);
  } finally {
    await newClient.close();
  }
  report.checks.migration = {
    originalPasswordRequired: true,
    existingAccountReused: true,
    oldCookieRetired: true,
    setupCookieRetired: true,
    newPinWorks: true,
  };
  assert.deepEqual(errors, []);
  report.passed = true;
  console.log(
    'Onboarding and legacy-to-PIN browser acceptance passed (synthetic credentials only).',
  );
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(outputRoot, 'onboarding-failure.png') });
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  await fixture?.close();
  await writeFile(
    path.join(outputRoot, 'onboarding-report.json'),
    JSON.stringify({ ...report, errors }, null, 2),
  );
}
