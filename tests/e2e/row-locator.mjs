import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright-core';

const source = await readFile('apps/ui/src/design/motion.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const styles = await Promise.all(
  ['style.css', 'design/tokens.css', 'design/liquid-glass.css'].map((path) =>
    readFile(`apps/ui/src/${path}`, 'utf8'),
  ),
);
const browser = await chromium.launch({
  executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setContent(
    `<style>${styles.join('\n')}</style><div class="track-row" style="--subject-column-width:180px;--subject-row-height:116px;width:900px"><div class="track-label status-cell-public"><button onclick="this.dataset.clicked='true'">Model</button></div><div class="track-lane">Recording coverage</div></div>`,
  );
  await page.evaluate(async (url) => {
    window.indicateRow = (await import(url)).indicateRow;
  }, moduleUrl);
  const row = page.locator('.track-row');
  const before = await row.boundingBox();
  await row.evaluate((node) => window.indicateRow(node));
  await page.waitForTimeout(300);
  const shown = await row.evaluate((node) => ({
    opacity: Number(getComputedStyle(node, '::after').opacity),
    pointerEvents: getComputedStyle(node, '::after').pointerEvents,
    shadow: getComputedStyle(node, '::after').boxShadow,
    outline: getComputedStyle(node).outlineStyle,
  }));
  assert(shown.opacity > 0.8);
  assert.equal(shown.pointerEvents, 'none');
  assert.notEqual(shown.shadow, 'none');
  assert.equal(shown.outline, 'none');
  assert.deepEqual(await row.boundingBox(), before);
  await row.getByRole('button').click();
  assert.equal(await row.getByRole('button').getAttribute('data-clicked'), 'true');
  await row.evaluate((node) => window.indicateRow(node));
  assert.equal(
    await row.evaluate(
      (node) =>
        node.getAnimations({ subtree: true }).filter((item) => item.id === 'row-reveal').length,
    ),
    1,
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.local/qa/row-locator.png' });
  await row.evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  assert.equal(await row.evaluate((node) => getComputedStyle(node, '::after').opacity), '0');
  assert.deepEqual(await row.boundingBox(), before);
  console.log(
    'Row locator: visible soft overlay, stable geometry, pass-through clicks, restart and clean fade passed.',
  );
} finally {
  await browser.close();
}
