#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, lstat, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkWorkspaceDependencies } from './lib/workspace-dependencies.mjs';
if (process.argv.slice(2).some((arg) => arg !== '--no-workspace-links'))
  throw Error('UNKNOWN_BUILD_OPTION');
const releaseVersion = process.env.STV_BUILD_VERSION;
if (releaseVersion && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseVersion))
  throw Error('INVALID_RELEASE_VERSION');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'build');
try {
  const info = await lstat(output);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('UNSAFE_BUILD_OUTPUT');
  await rm(output, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const [script, args] of [
  ['node_modules/typescript/bin/tsc', ['-p', 'apps/server/tsconfig.build.json']],
  ['node_modules/vite/bin/vite.js', ['build', 'apps/ui']],
]) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const name of ['apps/server', 'packages/api-schema']) {
  const manifest = JSON.parse(await readFile(path.join(root, name, 'package.json'), 'utf8'));
  if (releaseVersion) manifest.version = releaseVersion;
  if (name === 'packages/api-schema') manifest.exports = { '.': './src/index.js' };
  await mkdir(path.join(root, 'build', name), { recursive: true });
  await writeFile(
    path.join(root, 'build', name, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}
// Resolve the internal workspace to its emitted JS, including when this build/
// runs beside a development node_modules whose workspace still exports TS.
async function linkCompiledContracts(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await linkCompiledContracts(filename);
    else if (entry.isFile() && filename.endsWith('.js')) {
      const source = await readFile(filename, 'utf8');
      const relative = path
        .relative(path.dirname(filename), path.join(output, 'packages/api-schema/src/index.js'))
        .split(path.sep)
        .join('/');
      await writeFile(
        filename,
        source.replace(
          /from (['"])@st-vault\/api-schema\1/g,
          `from '${relative.startsWith('.') ? relative : './' + relative}'`,
        ),
      );
    }
  }
}
await linkCompiledContracts(path.join(output, 'apps/server'));
// The development worker uses native TS; the release contains only compiled JS.
await writeFile(
  path.join(root, 'build/apps/server/src/archive/metadata-worker.mjs'),
  "import './metadata-worker.js';\n",
);
await mkdir(path.join(root, 'build/apps/ui'), { recursive: true });
await cp(path.join(root, 'apps/ui/dist'), path.join(root, 'build/apps/ui/dist'), {
  recursive: true,
});
if (!process.argv.includes('--no-workspace-links'))
  await linkWorkspaceDependencies(root, output, ['apps/server', 'packages/api-schema']);
console.log('Release code is ready in build/ (no TypeScript runtime loader).');
