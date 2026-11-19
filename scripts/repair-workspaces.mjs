#!/usr/bin/env node
// npm workspace links can retain absolute junction targets after a Windows move.
// Repairs preserve old links in backups and derive every path from this script.
import { lstat, mkdir, readlink, realpath, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repair = process.argv.slice(2).includes('--repair');
if (process.argv.slice(2).some((arg) => !['--repair', '--check'].includes(arg))) {
  throw new Error('Usage: node scripts/repair-workspaces.mjs [--check | --repair]');
}
const packages = { server: 'apps/server', ui: 'apps/ui', 'api-schema': 'packages/api-schema' };
const backupRoot = path.join(root, '.local', 'backups', `workspace-links-${Date.now()}`);
let broken = 0;
for (const [name, relativeTarget] of Object.entries(packages)) {
  const target = path.join(root, relativeTarget);
  const link = path.join(root, 'node_modules', '@st-vault', name);
  const expected = await realpath(target);
  let stat;
  try {
    stat = await lstat(link);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat && !stat.isSymbolicLink())
    throw new Error(`Refusing to replace a real package directory: ${name}`);
  let correct = false;
  if (stat) {
    try {
      correct = (await realpath(link)) === expected;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (correct) {
    console.log(`${name}: OK`);
    continue;
  }
  broken++;
  if (!repair) {
    console.log(`${name}: ${stat ? 'stale link' : 'missing link'}`);
    continue;
  }
  // Both link and backup are strictly beneath this checkout, never source targets.
  const backup = path.join(backupRoot, name);
  for (const candidate of [link, backup]) {
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Path outside checkout');
  }
  await mkdir(path.dirname(link), { recursive: true });
  if (stat) {
    const oldTarget = await readlink(link);
    await mkdir(backupRoot, { recursive: true });
    await rename(link, backup);
    console.log(`${name}: preserved old link (${oldTarget})`);
  }
  try {
    await symlink(
      process.platform === 'win32' ? target : path.relative(path.dirname(link), target),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (stat) await rename(backup, link);
    throw error;
  }
  if ((await realpath(link)) !== expected) throw new Error(`Repair verification failed: ${name}`);
  console.log(`${name}: repaired`);
}
if (!repair && broken) process.exitCode = 1;
