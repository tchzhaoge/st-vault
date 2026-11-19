import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { resolveDataDirectory } from './data-path.js';

const checkout = path.join(tmpdir(), 'st-vault-path-fixture', 'project');

it('locates default data beside the checkout regardless of the working directory', () => {
  expect(resolveDataDirectory(checkout)).toBe(path.join(checkout, 'data'));
});

it('anchors configured relative paths to the checkout rather than the launching terminal', () => {
  expect(resolveDataDirectory(checkout, 'st-vault')).toBe(path.join(checkout, 'st-vault'));
  expect(resolveDataDirectory(checkout, './recordings')).toBe(path.join(checkout, 'recordings'));
});

it('uses the default directory when an environment entry is empty', () => {
  expect(resolveDataDirectory(checkout, '')).toBe(path.join(checkout, 'data'));
});

it('preserves an explicitly configured absolute NAS data location', () => {
  const absolute = path.join(tmpdir(), 'st-vault-explicit-data');
  expect(resolveDataDirectory(checkout, absolute)).toBe(absolute);
});
