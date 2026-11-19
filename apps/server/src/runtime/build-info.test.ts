import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildInfo, parseBuildInfo } from './build-info.js';

it('reads the package version without a separately hardcoded application version', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  expect(buildInfo.version).toBe(manifest.version);
  expect(parseBuildInfo({ version: '2.4.6' }, 'a'.repeat(40))).toEqual({
    version: '2.4.6',
    revision: 'a'.repeat(40),
  });
  expect(parseBuildInfo({ version: '2.4.6' }).revision).toBeNull();
  expect(parseBuildInfo({ version: '2.4.6' }, '').revision).toBeNull();
});
it('rejects malformed package or revision metadata', () => {
  expect(() => parseBuildInfo({ version: 1 })).toThrow('INVALID_BUILD_MANIFEST');
  expect(() => parseBuildInfo({ version: '2.4.6' }, 'not-a-revision')).toThrow(
    'INVALID_BUILD_REVISION',
  );
});
