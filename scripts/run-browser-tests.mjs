import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scenarios = [
  'account-panel',
  'global-recording',
  'timezone',
  'list-scroll',
  'list-motion',
  'ui-style',
  'row-locator',
  'snapshot-images',
  'snapshot-seen',
  'snapshot-toolbar-layout',
  'snapshot-seek',
  'snapshot-unit-identity',
  'live-snapshot-follow',
  'live-unit-tail',
  'player-disconnect',
  'player-keyboard',
  'favorite-response',
  'fullscreen-chrome',
  'snapshot-live-refresh',
  'snapshot-roll',
  'review-layout',
  'workspace-layout',
  'localization-layout',
  'display-clock',
  'timeline-navigation',
  'live-selection-pan',
  'view-restoration',
  'timeline-preview',
  'cdn-switch',
  'media-transition',
  'deletion-empty-selection',
  'deletion-intent',
  'durable-deletion',
  'onboarding',
  'workbench',
];
const selected = process.argv.slice(2);
if (selected.some((name) => !scenarios.includes(name)))
  throw new Error(`Unknown scenario. Available: ${scenarios.join(', ')}`);
for (const name of selected.length ? selected : scenarios) {
  console.log(`[e2e] ${name}`);
  const result = spawnSync(process.execPath, [path.join(root, 'tests/e2e', `${name}.mjs`)], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    timeout: name === 'workbench' ? 300000 : 180000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
