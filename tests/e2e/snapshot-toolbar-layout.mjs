import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const styles = await Promise.all(
  [
    'apps/ui/src/design/tokens.css',
    'apps/ui/src/style.css',
    'apps/ui/src/design/liquid-glass.css',
  ].map((file) => readFile(file, 'utf8')),
);
const browser = await chromium.launch({
  executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
  headless: true,
});
try {
  const page = await browser.newPage();
  for (const width of [320, 600])
    for (const english of [false, true]) {
      await page.setContent(`<style>${styles.join('\n')}</style><div style="width:${width}px"><nav class="snapshot-pages" style="--snapshot-toolbar-height:26px">
      <span class="snapshot-total">${english ? '1234567' : '1234567 张'}</span><button class="snapshot-page-button">↑</button><output>123456 / 999999</output><button class="snapshot-page-button">↓</button>
      <div class="snapshot-actions"><button>${english ? 'Unlike all' : '取消所有喜欢'}</button><button>${english ? 'Delete unliked' : '删除所有非喜欢'}</button></div>
      </nav></div>`);
      const result = await page.locator('.snapshot-pages').evaluate((node) => {
        const numeric = [...node.querySelectorAll('output,.snapshot-total')];
        const clipped = numeric
          .filter((item) => item.scrollWidth > item.clientWidth + 1)
          .map((item) => item.textContent);
        const box = node.getBoundingClientRect(),
          first = node.firstElementChild.getBoundingClientRect();
        node.scrollLeft = node.scrollWidth;
        return {
          clipped,
          firstVisible: first.left >= box.left - 1,
          lastReachable: node.lastElementChild.getBoundingClientRect().right <= box.right + 1,
          height: box.height,
          direction: getComputedStyle(node).flexDirection,
        };
      });
      assert.deepEqual(result.clipped, [], JSON.stringify({ width, english, result }));
      assert(
        result.firstVisible && result.lastReachable,
        JSON.stringify({ width, english, result }),
      );
      assert.equal(result.height, 26);
      assert.equal(result.direction, 'row');
    }
  for (const [columns, rows] of [
    [5, 6],
    [3, 10],
  ])
    for (const exiting of [false, true]) {
      const cells = Array.from(
        { length: 30 },
        (_, i) =>
          `<div class="${exiting ? 'snapshot-ghost' : 'snapshot-cell'}"><button data-unit-index="${i}" class="selected"><div><span class="minute-image"></span></div></button></div>`,
      ).join('');
      await page.setContent(
        `<style>${styles.join('\n')}</style><section class="snapshot-section " style="width:500px;height:700px;--snapshot-columns:${columns};--snapshot-rows:${rows};--snapshot-toolbar-height:0px;--snapshot-content-gap:0px"><div class="snapshot-viewport"><div class="${exiting ? 'snapshot-page-exit snapshot-exits' : 'snapshot-grid'}">${cells}</div></div></section>`,
      );
      const clipped = await page.locator('.snapshot-cell,.snapshot-ghost').evaluateAll((nodes) =>
        nodes.flatMap((node, index) => {
          const cell = node.getBoundingClientRect(),
            picture = node.querySelector('button > div').getBoundingClientRect();
          const border = getComputedStyle(node.querySelector('button > div'), '::after');
          return picture.top < cell.top - 0.1 ||
            picture.bottom > cell.bottom + 0.1 ||
            picture.left < cell.left - 0.1 ||
            picture.right > cell.right + 0.1 ||
            parseFloat(border.borderTopWidth) < 2
            ? [index]
            : [];
        }),
      );
      assert.deepEqual(
        clipped,
        [],
        `Selected snapshot edges must stay inside their cells (${columns}x${rows}, exiting=${exiting})`,
      );
    }
  console.log(
    'Large snapshot numbers: complete, single-row and reachable at 320/600px in both languages.',
  );
} finally {
  await browser.close();
}
