import { chown, chmod, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface RuntimeUser {
  uid: number;
  gid: number;
}
export function validateRuntimeUser(user: RuntimeUser): void {
  if (![user.uid, user.gid].every((id) => Number.isInteger(id) && id >= 1 && id <= 2147483647))
    throw new Error('RUNTIME_USER_MUST_BE_NON_ROOT');
}
async function directory(directory: string, { uid, gid }: RuntimeUser): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('UNSAFE_INIT_DIRECTORY');
  await chown(directory, uid, gid);
  await chmod(directory, 0o700);
}
/** Only touch known top-level state files, never recursively rewrite an archive. */
export async function initializeState(
  state: string,
  user: RuntimeUser,
  media?: string,
): Promise<void> {
  validateRuntimeUser(user);
  for (const name of ['', 'indexes', 'private', 'postgres'])
    await directory(path.join(state, name), user);
  if (media) await directory(media, user);
  for (const name of [
    'app.sqlite',
    'instance-lock.sqlite',
    'app.sqlite-wal',
    'app.sqlite-shm',
    'instance-lock.sqlite-journal',
    'private/address-key.key',
    'private/postgres.json',
  ]) {
    const file = path.join(state, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('UNSAFE_INIT_FILE');
      await chown(file, user.uid, user.gid);
      await chmod(file, 0o600);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
type Identity = Pick<
  NodeJS.Process,
  'getuid' | 'getgid' | 'getgroups' | 'setgroups' | 'setgid' | 'setuid'
>;
export function dropRuntimePrivileges(user: RuntimeUser, identity: Identity = process): void {
  validateRuntimeUser(user);
  if (
    !identity.getuid ||
    !identity.getgid ||
    !identity.getgroups ||
    !identity.setgroups ||
    !identity.setgid ||
    !identity.setuid
  )
    throw new Error('POSIX_RUNTIME_REQUIRED');
  if (identity.getuid() === 0) {
    // Preserve explicitly supplied non-root groups for mounted-volume access.
    identity.setgroups(identity.getgroups().filter((group) => group !== 0));
    identity.setgid(user.gid);
    identity.setuid(user.uid);
  }
  if (identity.getuid() !== user.uid || identity.getgid() !== user.gid)
    throw new Error('RUNTIME_PRIVILEGE_DROP_FAILED');
}
