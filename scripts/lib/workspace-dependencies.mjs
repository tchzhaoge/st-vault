import { lstat, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
// A local release stays in its checkout. Match Node's workspace lookup even
// when npm keeps a package's dependencies nested instead of hoisting them.
export async function linkWorkspaceDependencies(root, output, workspaces) {
  for (const workspace of workspaces) {
    const source = path.join(root, workspace, 'node_modules'),
      link = path.join(output, workspace, 'node_modules');
    if (!path.resolve(link).startsWith(path.resolve(output) + path.sep))
      throw Error('UNSAFE_DEPENDENCY_LINK');
    try {
      await lstat(source);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await mkdir(path.dirname(link), { recursive: true });
    try {
      await lstat(link);
      throw Error('BUILD_DEPENDENCIES_EXIST');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await symlink(
      process.platform === 'win32' ? source : path.relative(path.dirname(link), source),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}
