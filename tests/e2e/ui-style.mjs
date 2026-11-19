import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const styles = await Promise.all(
  [
    'apps/ui/src/design/tokens.css',
    'apps/ui/src/features/player/player-controls.css',
    'apps/ui/src/features/network/routing-options.css',
    'apps/ui/src/features/timeline/timeline.css',
    'apps/ui/src/style.css',
    'apps/ui/src/design/liquid-glass.css',
    'apps/ui/src/design/panels.css',
    'apps/ui/src/design/player-overlays.css',
  ].map((path) => readFile(path, 'utf8')),
);
const browser = await chromium.launch({
  executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
  headless: true,
});
const problems = [];
const content = `<style>${styles.join('\n')}</style>
  <main style="padding:20px">
    <section class="media-review" style="position:relative;width:320px;height:100px;--review-track-height:32px;--review-inset:6px">
      <div class="viewer-focus"><div class="focus-lane">
        <div class="timeline-content"><div class="status-line"><span class="status-band status-band-public" style="position:absolute;inset:0"></span></div><div class="recording-line"><span class="track-clip" style="left:0;width:100%"></span></div></div>
        <i class="focus-playhead" style="left:1.5px"></i>
      </div></div>
    </section>
    <div class="track-lane material-fixture" style="width:420px;height:116px">
      <div class="timeline-content">
        <div class="status-line">
          <span class="status-band status-band-public" style="left:0;width:25%"></span>
          <span class="status-band status-band-private" style="left:25%;width:25%"></span>
          <span class="status-band status-band-offline" style="left:50%;width:25%"></span>
          <span class="status-band status-band-unknown" style="left:75%;width:25%"></span>
        </div>
        <div class="recording-line"><span class="track-clip" style="left:0;width:24%;opacity:.35"></span><span class="track-clip" style="left:25%;width:24%;opacity:.7"></span><span class="track-clip" style="left:50%;width:24%"></span><span class="track-clip" style="left:90%;width:1px"></span></div>
      </div>
    </div>
    <div class="subject-filters" style="width:200px"><span class="glass-selection"></span><button class="active">在线</button><button>离线</button><button>归档</button></div>
    <nav class="snapshot-pages" style="--snapshot-toolbar-height:26px;width:320px">
      <span class="snapshot-total">30 张</span>
      <div class="snapshot-actions"><button><svg class="ui-icon"></svg><span>取消所有喜欢</span></button></div>
    </nav>
    <div class="record-policy-fixture">
      <button class="recording-toggle record-button" aria-checked="false" aria-label="Auto off"><i></i></button>
      <button class="recording-toggle record-button" aria-checked="true" aria-label="Auto on"><i></i></button>
    </div>
    <div class="player-picture geometry-player" style="position:relative;width:400px;height:230px">
      <span class="player-mode-badge is-live"></span>
      <div class="playback-status playback-status--brief"><div class="playback-status-content"><strong>正在定位画面…</strong></div></div>
    </div>
    <button class="tool-trigger" disabled>Unavailable</button>
    <button class="primary" disabled>Unavailable primary</button>
    <button class="secondary" disabled>Unavailable secondary</button>
    <button class="text-button" disabled>Unavailable text action</button>
    <button class="icon-button" disabled>Unavailable icon</button>
    <div class="routing-toolbar"><button class="text-button" aria-busy="true" disabled>Testing 1/3</button></div>
    <a href="#account">Account</a>
    <label class="field"><input aria-label="Login"></label>
    <button class="primary">Login</button>
    <section class="panel-content" style="width:360px">
      <label class="field"><input aria-label="Setting"></label>
      <button class="primary">Save</button>
      <span class="recording-mode"><button class="recording-toggle"><i></i></button></span>
    </section>
    <div class="player-actions"><button class="player-control">Play</button></div>
    <div class="snapshot-grid"><button class="snapshot-favorite">Like</button></div>
    <section class="snapshot-section" style="position:relative;width:200px;height:100px;min-height:0">
      <div class="snapshot-grid" style="position:relative;left:0;transform:none;width:200px;height:100px;display:block">
        <div class="snapshot-cell test-cell" style="width:200px;height:100px"><button data-unit-index="0" class="selected"><div><span class="minute-image"></span></div></button></div>
      </div>
    </section>
    <div class="view-position-window" style="position:relative;width:100px;height:26px">
      <button class="view-position-handle from">Start</button>
    </div>
  </main>`;
try {
  const page = await browser.newPage();
  await page.setContent(content);
  const inspectSurfaces = () =>
    page.evaluate(() => {
      const classes = [
        'topbar',
        'player-stage',
        'media-review',
        'aligned-arrangement',
        'toolbar-popover',
        'media-delete-dialog',
        'auth-card',
      ];
      const samples = classes.map((name) => {
        const node = document.createElement('div');
        node.className = name;
        node.style.cssText =
          'position:fixed;left:-1000px;top:0;width:320px;height:44px;animation:none;pointer-events:none';
        document.body.append(node);
        return node;
      });
      const parameters = [
        'backgroundImage',
        'backgroundColor',
        'borderTopWidth',
        'borderTopStyle',
        'borderRadius',
        'boxShadow',
        'backdropFilter',
        'cornerShape',
      ];
      const reference = getComputedStyle(samples[0]);
      const differences = samples.slice(1).flatMap((node) => {
        const value = getComputedStyle(node);
        return parameters
          .filter((key) => value[key] !== reference[key])
          .map((key) => `${node.className}.${key}: ${value[key]} != ${reference[key]}`);
      });
      samples.forEach((node) => node.remove());
      return differences;
    });
  assert.deepEqual(await inspectSurfaces(), [], 'All base surfaces share the title bar material');
  await page.emulateMedia({ forcedColors: 'active' });
  assert.deepEqual(
    await inspectSurfaces(),
    [],
    'Forced-color fallback stays consistent for every base surface',
  );
  await page.emulateMedia({ forcedColors: 'none' });
  assert(
    await page.evaluate(() => CSS.supports('corner-shape', 'superellipse(1.5)')),
    'The browser acceptance image must exercise native continuous corners',
  );
  const rectangular =
    '.media-review, .focus-lane, .focus-lane > .timeline-content, .material-fixture .status-line, .material-fixture .recording-line, .test-cell, .test-cell button[data-unit-index], .test-cell button[data-unit-index] > div, .field input';
  const shapes = await page.locator(rectangular).evaluateAll((nodes) =>
    nodes.map((node) => ({
      element: node.className || node.tagName,
      shape: getComputedStyle(node).getPropertyValue('corner-shape'),
    })),
  );
  assert(
    shapes.every((item) => item.shape === 'superellipse(1.5)'),
    JSON.stringify(shapes),
  );
  const circles = await page
    .locator('.subject-filters, .snapshot-pages, .record-policy-fixture i, .player-mode-badge')
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).getPropertyValue('corner-shape')),
    );
  assert(
    circles.every((shape) => shape === 'superellipse(1)'),
    JSON.stringify(circles),
  );
  assert.equal(
    await page
      .locator('.test-cell button > div')
      .evaluate((node) => getComputedStyle(node, '::after').getPropertyValue('corner-shape')),
    'superellipse(1.5)',
    'The playback ring must use the same curve as its image',
  );
  const fallback = await browser.newPage();
  await fallback.setContent(content.replace(/corner-shape\s*:[^;}]+;/g, ''));
  assert.equal(
    await fallback
      .locator('.media-review')
      .evaluate((node) => getComputedStyle(node).getPropertyValue('corner-shape')),
    'superellipse(1)',
  );
  const bounds = async (tab) =>
    tab.locator('.media-review').evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  assert.deepEqual(
    await bounds(fallback),
    await bounds(page),
    'Unsupported-corner fallback retains layout geometry',
  );
  await fallback.close();
  const nesting = await page.locator('.media-review').evaluate((node) => ({
    outer: parseFloat(getComputedStyle(node).borderTopLeftRadius),
    inset: parseFloat(getComputedStyle(node).paddingTop),
    inner: parseFloat(getComputedStyle(node.querySelector('.focus-lane')).borderTopLeftRadius),
    clip: getComputedStyle(node.querySelector('.timeline-content')).overflowX,
  }));
  assert.equal(nesting.inner, 0, 'The time-domain clip must not cut the thin status track');
  assert(nesting.outer > nesting.inset, 'The surrounding panel keeps its rounded outline');
  assert.equal(
    nesting.clip,
    'hidden',
    'Track content clips inside its outline, independently of the playhead',
  );
  await page.locator('.media-review').screenshot({ path: '/tmp/continuous-review.png' });
  const emptyCoverage = await page.locator('.material-fixture .recording-line').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      fill: style.backgroundImage,
      shadow: style.boxShadow,
      reflection: getComputedStyle(node, '::after').content,
    };
  });
  assert.deepEqual(
    emptyCoverage,
    { fill: 'none', shadow: 'none', reflection: 'none' },
    'Empty coverage must not carry a white reflection layer',
  );
  const glass = await page.locator('.material-fixture .status-line').evaluateAll((nodes) =>
    nodes.map((node) => {
      const surface = getComputedStyle(node, '::after');
      return {
        reflection: surface.content,
        fill: surface.backgroundImage,
        events: surface.pointerEvents,
        filter: getComputedStyle(node).backdropFilter,
      };
    }),
  );
  assert(
    glass.every(
      (surface) =>
        surface.reflection !== 'none' &&
        surface.fill.includes('linear-gradient') &&
        surface.events === 'none',
    ),
    'The status track retains its non-interactive glass reflection layer',
  );
  assert(
    glass.every((surface) => surface.filter === 'none'),
    'Plain track backgrounds should not allocate backdrop blur surfaces',
  );
  assert.equal(
    await page
      .locator('.material-fixture .track-clip')
      .last()
      .evaluate((node) => node.getBoundingClientRect().width),
    1,
    'Glass styling must preserve subpixel-coverage visibility geometry',
  );
  await page.locator('.material-fixture').screenshot({ path: '/tmp/timeline-glass.png' });
  const corners = await page
    .locator('.focus-lane .status-line, .focus-lane .recording-line, .test-cell button > div')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        radius: parseFloat(getComputedStyle(node).borderTopLeftRadius),
        overflow: getComputedStyle(node).overflowX,
      })),
    );
  assert(
    corners.every((item) => item.radius > 0 && item.overflow === 'hidden'),
    'Visible track and image layers must clip their content to shared rounded corners',
  );
  assert.equal(
    await page.locator('.focus-lane').evaluate((node) => getComputedStyle(node).overflowX),
    'visible',
    'The playhead must remain outside track clipping',
  );
  assert.equal(
    await page
      .locator('.test-cell button > div')
      .evaluate((node) => getComputedStyle(node, '::after').borderTopLeftRadius),
    await page
      .locator('.test-cell button > div')
      .evaluate((node) => getComputedStyle(node).borderTopLeftRadius),
    'Playback highlight follows the image corners',
  );
  const surfaces = await page.locator('.subject-filters, .snapshot-pages').evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return { fill: style.background, shadow: style.boxShadow, radius: style.borderRadius };
    }),
  );
  assert.deepEqual(
    surfaces[0],
    surfaces[1],
    'Screenshot tools and directory filters share one light glass control surface',
  );
  assert.match(surfaces[1].shadow, /inset/);
  const idleAction = page.locator('.snapshot-actions button').first();
  const actionBounds = await idleAction.boundingBox();
  const idleFill = await idleAction.evaluate((node) => getComputedStyle(node).background);
  await idleAction.hover();
  await page.waitForTimeout(200);
  const hoverFill = await idleAction.evaluate((node) => getComputedStyle(node).background);
  assert.notEqual(hoverFill, idleFill);
  assert.deepEqual(
    await idleAction.boundingBox(),
    actionBounds,
    'Hover cannot change screenshot tool dimensions',
  );
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  const tools = await page.locator('.snapshot-pages').evaluate((node) => {
    const idle = getComputedStyle(node.querySelector('.snapshot-actions button'));
    const icon = getComputedStyle(node.querySelector('.ui-icon'));
    return {
      idle: idle.backgroundColor,
      idleShadow: idle.boxShadow,
      font: parseFloat(getComputedStyle(node).fontSize),
      icon: parseFloat(icon.width),
      height: node.clientHeight,
    };
  });
  assert.equal(tools.idle, 'rgba(0, 0, 0, 0)');
  assert.equal(
    tools.idleShadow,
    'none',
    'Individual actions must not duplicate the recessed track',
  );
  assert.equal(tools.font, 11);
  assert.equal(tools.icon, 13);
  assert.equal(tools.height, 26, 'The styling must retain the existing toolbar allocation');
  const policies = await page.locator('.record-policy-fixture button').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect(),
        style = getComputedStyle(node);
      return {
        width: box.width,
        height: box.height,
        color: style.color,
        fill: getComputedStyle(node.querySelector('i')).backgroundColor,
      };
    }),
  );
  assert.equal(policies[0].width, policies[1].width);
  assert.equal(policies[0].height, policies[1].height);
  assert.notEqual(
    policies[0].color,
    policies[1].color,
    'Auto policy must be legible before capture starts',
  );
  assert.notEqual(
    policies[0].fill,
    policies[1].fill,
    'Enabled and disabled shapes must differ as well as color',
  );
  const picture = await page.locator('.geometry-player').boundingBox();
  const badge = await page.locator('.player-mode-badge').boundingBox();
  assert(Math.abs(badge.x - picture.x - 10) < 1, 'Media identity belongs at the upper left');
  const notice = await page.locator('.geometry-player .playback-status').boundingBox();
  assert(
    Math.abs(notice.x + notice.width / 2 - picture.x - picture.width / 2) < 1,
    'Brief media notices must be horizontally centered',
  );
  assert(
    Math.abs(picture.y + picture.height - notice.y - notice.height - 54) < 1,
    'Brief media notices keep their existing height',
  );
  for (const selector of [
    '.tool-trigger',
    '.primary',
    '.secondary',
    '.text-button',
    '.icon-button',
  ]) {
    const disabled = page.locator(`${selector}:disabled`).first();
    const appearance = (node) => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
      shine: getComputedStyle(node, '::after').opacity,
    });
    const before = await disabled.evaluate(appearance);
    await disabled.hover();
    await page.waitForTimeout(400);
    const hovered = await disabled.evaluate(appearance);
    if (JSON.stringify(before) !== JSON.stringify(hovered))
      problems.push(`${selector}: disabled control displays enabled hover feedback`);
  }
  const progress = await page
    .locator('[aria-busy="true"]')
    .evaluate((node) => getComputedStyle(node).opacity);
  if (progress !== '1')
    problems.push('Background progress must stay readable while its action is disabled');
  for (const [selector, field] of [
    ['input', 'borderRadius'],
    ['.primary', 'minHeight'],
  ]) {
    const values = await page
      .locator(selector)
      .evaluateAll((nodes, field) => nodes.map((node) => getComputedStyle(node)[field]), field);
    if (new Set(values).size !== 1) problems.push(`${selector}: inconsistent ${field}: ${values}`);
  }
  for (const selector of ['a', '.view-position-handle']) {
    await page.locator(selector).focus();
    const focus = await page.locator(selector).evaluate((node) => ({
      visible: node.matches(':focus-visible'),
      style: getComputedStyle(node).outlineStyle,
      width: parseFloat(getComputedStyle(node).outlineWidth),
    }));
    if (!focus.visible || focus.style === 'none' || focus.width < 2)
      problems.push(`${selector}: keyboard focus is not visible`);
  }
  const favoriteSize = await page.locator('.snapshot-favorite').boundingBox();
  const noticeLayout = await page.evaluate(() => {
    const issues = [];
    for (const width of [320, 560, 800]) {
      for (const kind of ['player', 'snapshot']) {
        const host = document.createElement('div');
        host.className = kind === 'player' ? 'player-picture' : 'snapshot-section';
        host.style.cssText = `position:relative;width:${width}px;height:240px;container-type:inline-size`;
        const notice = document.createElement('div');
        notice.className = kind === 'player' ? 'playback-status' : 'snapshot-status';
        notice.dataset.kind = kind === 'player' ? 'idle' : 'ended';
        const block = document.createElement('div');
        block.className = 'playback-status-content';
        block.innerHTML = '<span class="playback-status-symbol"></span><strong></strong><p></p>';
        const title = block.querySelector('strong'),
          detail = block.querySelector('p');
        title.textContent =
          kind === 'player'
            ? 'Click a model for live, or drag a range to replay'
            : 'Select a model to view snapshots';
        detail.textContent =
          kind === 'player'
            ? 'Select a model to watch live, or drag across the timeline to replay a recording.'
            : 'Select a model to see screenshots by minute within the displayed time range.';
        notice.append(block);
        host.append(notice);
        document.body.append(host);
        const style = getComputedStyle(notice);
        const available =
          notice.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (block.getBoundingClientRect().width < available - 1)
          issues.push(`${kind} ${width}px: notice leaves usable horizontal space empty`);
        const columns = getComputedStyle(block).gridTemplateColumns.split(' ').map(parseFloat);
        const textWidth = columns.at(-1);
        for (const node of [title, detail]) {
          const canvas = document.createElement('canvas').getContext('2d');
          canvas.font = getComputedStyle(node).font;
          const natural = canvas.measureText(node.textContent).width;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (natural <= textWidth - 1 && range.getClientRects().length > 1)
            issues.push(`${kind} ${width}px: text wraps despite fitting its available line`);
          if (node.scrollWidth > node.clientWidth + 1)
            issues.push(`${kind} ${width}px: notice overflows`);
        }
        host.remove();
      }
    }
    return issues;
  });
  problems.push(...noticeLayout);
  if (favoriteSize.width < 24 || favoriteSize.height < 24)
    problems.push('Desktop snapshot favorite hit area must be at least 24px');
  const gridGesture = await page
    .locator('.snapshot-grid')
    .first()
    .evaluate((node) => getComputedStyle(node).touchAction);
  if (gridGesture !== 'pan-y')
    problems.push('Non-editing screenshots must allow vertical touch scrolling');
  const cell = page.locator('.test-cell');
  const resting = await cell.boundingBox();
  await cell.hover();
  await page.waitForTimeout(400);
  const raised = await cell.boundingBox();
  if (Math.abs(resting.y - raised.y) > 0.5)
    problems.push('Screenshot hover must not move its click target');
  const touch = await browser.newContext({ hasTouch: true, isMobile: true });
  const touchPage = await touch.newPage();
  await touchPage.setContent(content);
  for (const selector of ['.player-control', '.recording-toggle']) {
    for (const button of await touchPage.locator(selector).all()) {
      const bounds = await button.boundingBox();
      if (bounds.width < 44 || bounds.height < 44)
        problems.push(`${selector}: touch hit area must be at least 44px`);
    }
  }
  await touch.close();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const indicators = await page.evaluate(() => {
      const failures = [];
      const host = document.createElement('nav');
      host.className = 'header-tools';
      host.style.cssText = 'position:fixed;left:20px;top:30px;z-index:100000';
      document.body.append(host);
      for (const text of ['历史', 'History']) {
        for (const [kind, value] of [
          ['unread-badge', '1'],
          ['unread-badge', '12'],
          ['unread-badge', '99+'],
          ['tool-alert', '!'],
          ['spinner', ''],
        ]) {
          const anchor = document.createElement('div');
          anchor.className = 'tool-anchor header-tool';
          const button = document.createElement('button');
          button.className = 'tool-trigger';
          const label = document.createElement('span');
          label.className = 'tool-label';
          label.textContent = text;
          const badge = document.createElement('span');
          badge.className = kind;
          badge.textContent = value;
          button.append(label, badge);
          anchor.append(button);
          host.append(anchor);
          const rect = badge.getBoundingClientRect();
          if (!rect.width || !rect.height || getComputedStyle(badge).display === 'none')
            failures.push(`${text} ${kind} ${value}: indicator is hidden`);
          for (let node = badge.parentElement; node; node = node.parentElement) {
            const css = getComputedStyle(node),
              box = node.getBoundingClientRect();
            if (
              ['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowX) &&
              (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)
            )
              failures.push(`${text} ${kind} ${value}: clipped horizontally by ${node.className}`);
            if (
              ['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowY) &&
              (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5)
            )
              failures.push(`${text} ${kind} ${value}: clipped vertically by ${node.className}`);
          }
          anchor.remove();
        }
      }
      host.remove();
      return failures;
    });
    problems.push(...indicators.map((issue) => `${width}px: ${issue}`));
  }
  await page.keyboard.press('Tab');
  for (const [tag, className, role, tabIndex] of [
    ['section', 'inline-player', null, 0],
    ['div', 'track-table-scroll', null, -1],
    ['div', 'track-lane', 'group', 0],
    ['video', '', null, -1],
    ['div', 'toolbar-popover', 'dialog', -1],
  ]) {
    const outline = await page.evaluate(
      ({ tag, className, role, tabIndex }) => {
        const node = document.createElement(tag);
        node.className = className;
        node.tabIndex = tabIndex;
        if (role) node.setAttribute('role', role);
        node.style.cssText = 'position:fixed;left:20px;top:20px;width:300px;height:80px';
        document.body.append(node);
        node.focus();
        const result = {
          focused: document.activeElement === node,
          outline: getComputedStyle(node).outlineStyle,
        };
        node.remove();
        return result;
      },
      { tag, className, role, tabIndex },
    );
    if (!outline.focused || outline.outline !== 'none')
      problems.push(`${className || tag}: passive focus must not draw a container selection frame`);
  }
  const panelLayout = await page.evaluate(() => {
    const issues = [];
    for (const [kind, body] of [
      ['keys', '<section class="key-tools"><span>1 key</span></section>'],
      [
        'account',
        '<div class="panel-identity"><span class="panel-identity-icon"></span><div class="panel-identity-content"><span>Site</span><strong>example.test</strong></div></div>',
      ],
      [
        'routing',
        '<div class="routing-options"><div class="routing-toolbar">Mode</div><div class="routing-list"><button class="routing-item">One</button><button class="routing-item">Two</button></div></div>',
      ],
      [
        'settings',
        '<div class="runtime-settings"><section class="panel-section"><h3>Settings</h3><label class="field"><span>Interval</span><input value="5"></label></section></div>',
      ],
    ]) {
      const panel = document.createElement('div');
      panel.className = 'toolbar-popover';
      panel.style.cssText = 'left:12px;top:12px;max-height:500px';
      panel.innerHTML = `<header><h2>${kind}</h2></header><div class="panel-content">${body}</div>`;
      document.body.append(panel);
      const content = panel.querySelector('.panel-content');
      if (panel.getBoundingClientRect().height > 220)
        issues.push(`${kind}: short content retains a fixed panel height`);
      if (content.scrollHeight > content.clientHeight + 1)
        issues.push(`${kind}: short content has unnecessary scrolling`);
      panel.remove();
    }
    const panel = document.createElement('div');
    panel.className = 'toolbar-popover';
    panel.style.cssText = 'left:12px;top:12px;max-height:160px';
    panel.innerHTML =
      '<header><h2>Long settings</h2></header><div class="panel-content" data-scroll-owner="panel"><div class="runtime-settings"><div style="height:120px">Settings</div><div class="routing-list">' +
      Array.from({ length: 15 }, () => '<button class="routing-item">Site</button>').join('') +
      '</div></div></div>';
    document.body.append(panel);
    const content = panel.querySelector('.panel-content'),
      list = panel.querySelector('.routing-list');
    if (content.scrollHeight <= content.clientHeight)
      issues.push('Long panel must retain necessary outer scrolling');
    if (getComputedStyle(list).overflowY !== 'visible')
      issues.push('An outer-scrolling panel must not retain a second list scroll region');
    if (panel.getBoundingClientRect().height > 161)
      issues.push('Long panel escapes its viewport height budget');
    panel.remove();
    return issues;
  });
  problems.push(...panelLayout);
  console.log(JSON.stringify(problems));
  assert.deepEqual(problems, []);
  console.log('UI materials, disabled feedback, focus and control geometry passed.');
} finally {
  await browser.close();
}
