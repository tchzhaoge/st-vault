import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { linkWorkspaceDependencies } from './lib/workspace-dependencies.mjs';
test('rejects a malformed release version before building', () => {
  const result = spawnSync(process.execPath, ['scripts/build-release.mjs'], {
    env: { ...process.env, STV_BUILD_VERSION: '0.0.01' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_RELEASE_VERSION/);
});
test('local compiled workspaces resolve nested runtime dependencies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-build-')),
    output = path.join(root, 'build');
  try {
    const dependency = path.join(root, 'apps/server/node_modules/fixture-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture-dep', type: 'module', exports: './index.js' }),
    );
    await writeFile(path.join(dependency, 'index.js'), 'export default 42;');
    await mkdir(path.join(output, 'apps/server'), { recursive: true });
    const entry = path.join(output, 'apps/server/entry.mjs');
    await writeFile(entry, "import answer from 'fixture-dep';export default answer;");
    await assert.rejects(import(pathToFileURL(entry).href + '?unlinked'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    await linkWorkspaceDependencies(root, output, ['apps/server']);
    assert.equal((await import(pathToFileURL(entry).href)).default, 42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('hoisted-only workspaces need no generated link', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-build-'));
  try {
    const output = path.join(root, 'build');
    await linkWorkspaceDependencies(root, output, ['apps/server']);
    await assert.rejects(lstat(path.join(output, 'apps/server/node_modules')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('never replaces an existing build dependency directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-build-'));
  try {
    const output = path.join(root, 'build');
    await mkdir(path.join(root, 'apps/server/node_modules'), { recursive: true });
    await mkdir(path.join(output, 'apps/server/node_modules'), { recursive: true });
    await assert.rejects(
      linkWorkspaceDependencies(root, output, ['apps/server']),
      /BUILD_DEPENDENCIES_EXIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
