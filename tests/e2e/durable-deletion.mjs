import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

let releasePrepare, enteredPrepare, releaseAdmission;
const prepareGate = new Promise((resolve) => {
  releasePrepare = resolve;
});
const preparing = new Promise((resolve) => {
  enteredPrepare = resolve;
});
const admissionGate = new Promise((resolve) => {
  releaseAdmission = resolve;
});
const fixture = await startFixture({
  beforeDeletionPrepare: async () => {
    enteredPrepare();
    await prepareGate;
  },
});
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  let page = await context.newPage();
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  await row.waitFor();
  const lane = await row.locator('.track-lane').boundingBox();
  await page.mouse.move(lane.x + 1, lane.y + 40);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width - 1, lane.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.locator('video[data-media-slot="active"]').evaluate((video) => video.pause());
  await page.waitForFunction(() => {
    const heart = document.querySelector('.snapshot-favorite');
    return heart && !heart.disabled;
  });
  await page
    .locator('.snapshot-actions')
    .getByRole('button', { name: '删除所有非喜欢', exact: true })
    .click();
  let body;
  await page.route('**/deletion-intents', async (route) => {
    body = route.request().postDataJSON();
    await admissionGate;
    await route.continue();
  });
  const accepted = page
    .waitForResponse((response) => response.url().endsWith('/deletion-intents'))
    .then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
  await page
    .getByRole('dialog', { name: '删除所有非喜欢', exact: true })
    .getByRole('button', { name: '确认删除', exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll('.snapshot-grid .snapshot-cell').length === 0,
  );
  assert.equal(await page.getByText('正在提交删除…', { exact: true }).count(), 0);
  assert.equal(
    await page.locator('.player-picture video').count(),
    0,
    'the retired current frame stops before admission completes',
  );
  assert.equal(
    await row
      .locator('.track-clip')
      .evaluateAll((nodes) => nodes.filter((node) => !node.closest('[data-motion-exit]')).length),
    0,
    'known deleted coverage changes before receipt',
  );
  assert.equal(await page.locator('.snapshot-feedback').count(), 0);
  await page.getByRole('button', { name: '状态', exact: true }).click();
  await page
    .getByText(/正在准备删除/)
    .first()
    .waitFor();
  const taskCount = await page.locator('[data-task="deletion"]').count();
  releaseAdmission();
  const result = await accepted;
  if (result.error) throw result.error;
  const receipt = result.response;
  assert.equal(receipt.status(), 202);
  const job = await receipt.json();
  assert.equal(job.state, 'preparing');
  await preparing;
  const duplicate = await context.request.post(
    `http://127.0.0.1:10085/api/subjects/${encodeURIComponent(fixture.info.subjectId)}/deletion-intents`,
    { data: body },
  );
  assert.equal((await duplicate.json()).id, job.id);
  await page.close();
  page = await context.newPage();
  await page.goto('http://127.0.0.1:10085');
  await page.getByRole('button', { name: '状态', exact: true }).click();
  await page
    .getByText(/正在准备删除/)
    .first()
    .waitFor();
  assert.equal(
    await page.locator('[data-task="deletion"]').count(),
    taskCount,
    'progress replaces existing status',
  );
  const jobs = await (
    await context.request.get('http://127.0.0.1:10085/api/media-deletions')
  ).json();
  assert.equal(jobs.filter((entry) => entry.id === job.id).length, 1);
  assert.equal(jobs.find((entry) => entry.id === job.id).state, 'preparing');
  releasePrepare();
  await page.waitForFunction(
    async (id) => {
      const jobs = await (await fetch('/api/media-deletions')).json();
      return jobs.find((entry) => entry.id === id)?.state === 'completed';
    },
    job.id,
    { polling: 100, timeout: 20000 },
  );
  console.log(
    JSON.stringify({
      immediateProjection: true,
      noSubmissionOverlay: true,
      durableBeforePreparation: true,
      pageCloseIndependent: true,
      idempotent: true,
      stableStatusRow: true,
    }),
  );
} finally {
  releaseAdmission();
  releasePrepare();
  await browser?.close();
  await fixture.close();
}
