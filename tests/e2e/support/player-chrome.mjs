import assert from 'node:assert/strict';

/** Keep the real pointer inside the controls while Playwright resolves a button.
 * Synthetic pointer events do not move the browser's hit-test position.
 */
export async function holdPlayerControls(page) {
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.locator('.player-picture').hover({ position: { x: 110, y: 110 } });
  const controls = await page.locator('.player-bottom').boundingBox();
  assert(controls, 'The player controls have a layout box');
  await page.mouse.move(controls.x + controls.width / 2, controls.y + controls.height / 2, {
    steps: 4,
  });
  await page.waitForFunction(() => {
    const node = document.querySelector('.player-bottom');
    return node && node.getAttribute('aria-hidden') !== 'true';
  });
}
