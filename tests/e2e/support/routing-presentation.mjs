import assert from 'node:assert/strict';

export async function verifyRoutingPresentation(page, options) {
  const listSelector = '[aria-label="接入点清单"]';
  const keys = [
    'https://stripchat.org',
    'https://superchat.live',
    'https://stripchat.com',
    'https://aznudelive.com',
  ];
  let phase = 0;
  const routeHandler = async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const item of data.sites.candidates) {
      const index = keys.indexOf(item.origin);
      item.checkedAtMs = Date.now();
      item.testing = false;
      item.error = index === 3 ? 'synthetic-timeout' : null;
      item.latencyMs =
        index === 0 ? 500 : index === 1 ? 1500 : index === 2 ? (phase ? 100 : 3000) : 3500;
    }
    data.sites.probing = true;
    data.sites.probeProgress = { completed: phase ? 3 : 1, total: 4 };
    data.sites.selectedOrigin = keys[phase ? 2 : 0];
    await route.fulfill({ json: data });
  };
  const refresh = () =>
    page.evaluate(() => window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system'] })));
  await page.route('**/api/network/routes', routeHandler);
  try {
    await refresh();
    await page.waitForFunction(
      (selector) => !!document.querySelector(`${selector} .routing-metric.is-poor`),
      listSelector,
    );
    const read = () =>
      options.locator('.routing-item').evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: node.firstElementChild.textContent,
          tone: node.lastElementChild.className,
          color: getComputedStyle(node.lastElementChild).color,
          disabled: node.disabled,
        })),
      );
    let items = await read();
    assert.match(await options.locator('.routing-toolbar .text-button').textContent(), /1\/4/);
    assert.match(await options.locator('.routing-toolbar .text-button').textContent(), /测速中/);
    const selected = options.locator('.routing-item[aria-pressed="true"]');
    assert.match(await selected.textContent(), /stripchat\.org/);
    assert.equal(await selected.count(), 1);
    assert.equal(await selected.evaluate((node) => getComputedStyle(node).opacity), '1');
    assert.equal(await selected.locator('.routing-selection svg').count(), 1);
    assert(items[0].label.includes('stripchat.org'));
    assert(items[0].tone.includes('is-good'));
    assert(items.find((item) => item.tone.includes('is-fair')));
    const failure = items.at(-1);
    assert(failure.tone.includes('is-unavailable') && failure.disabled);
    assert.equal(
      new Set(
        items.filter((item) => /is-(good|fair|poor)$/.test(item.tone)).map((item) => item.color),
      ).size,
      3,
    );
    phase = 1;
    await refresh();
    await page.waitForFunction(
      ({ selector, label }) =>
        document.querySelector(`${selector} .routing-item`)?.firstElementChild.textContent ===
        label,
      { selector: listSelector, label: 'stripchat.com' },
    );
    const height = await options
      .locator('.routing-list')
      .evaluate((node) => node.getBoundingClientRect().height);
    assert(height <= 128, `Route list too tall: ${height}`);
    items = await read();
    assert.match(await options.locator('.routing-toolbar .text-button').textContent(), /3\/4/);
    assert.match(await selected.textContent(), /stripchat\.org/);
    assert(items[0].tone.includes('is-good'));
  } finally {
    await page.unroute('**/api/network/routes', routeHandler);
    await refresh();
  }
}
