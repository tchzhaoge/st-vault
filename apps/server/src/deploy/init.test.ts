import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chown, chmod, lstat, mkdir } from 'node:fs/promises';
import { dropRuntimePrivileges, initializeState } from './init.js';

vi.mock('node:fs/promises', () => ({
  chown: vi.fn(),
  chmod: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
}));
const user = { uid: 1000, gid: 1000 },
  state = path.resolve('/fixture/state');
const info = {
  isSymbolicLink: () => false,
  isDirectory: () => true,
  isFile: () => true,
} as Awaited<ReturnType<typeof lstat>>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lstat).mockResolvedValue(info);
});

describe('state initialization', () => {
  it('only changes known state directories/files without touching media contents', async () => {
    await initializeState(state, user);
    const directories = ['', 'indexes', 'private', 'postgres'].map((name) =>
      path.join(state, name),
    );
    const files = [
      'app.sqlite',
      'instance-lock.sqlite',
      'app.sqlite-wal',
      'app.sqlite-shm',
      'instance-lock.sqlite-journal',
      'private/address-key.key',
      'private/postgres.json',
    ].map((name) => path.join(state, name));
    expect(vi.mocked(chown).mock.calls).toEqual(
      [...directories, ...files].map((name) => [name, 1000, 1000]),
    );
    expect(vi.mocked(chmod).mock.calls).toEqual([
      ...directories.map((name) => [name, 0o700]),
      ...files.map((name) => [name, 0o600]),
    ]);
  });
  it('rejects symlink directories and files before changing their target permissions', async () => {
    vi.mocked(lstat).mockResolvedValueOnce({ ...info, isSymbolicLink: () => true });
    await expect(initializeState(state, user)).rejects.toThrow('UNSAFE_INIT_DIRECTORY');
    expect(chown).not.toHaveBeenCalled();
    vi.mocked(lstat)
      .mockResolvedValueOnce(info)
      .mockResolvedValueOnce(info)
      .mockResolvedValueOnce(info)
      .mockResolvedValueOnce(info)
      .mockResolvedValueOnce({ ...info, isSymbolicLink: () => true });
    await expect(initializeState(state, user)).rejects.toThrow('UNSAFE_INIT_FILE');
    expect(chown).not.toHaveBeenCalledWith(path.join(state, 'app.sqlite'), 1000, 1000);
  });
  it('permits absent state files but fails closed on actual permission errors', async () => {
    vi.mocked(lstat).mockImplementation((name) =>
      String(name).endsWith('sqlite')
        ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        : Promise.resolve(info),
    );
    await initializeState(state, user);
    vi.mocked(chmod).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(initializeState(state, user)).rejects.toMatchObject({ code: 'EACCES' });
  });
  it.each([0, -1, 1.5, NaN, 2147483648])(
    'rejects invalid UID/GID %s before filesystem access',
    async (id) => {
      await expect(initializeState(state, { ...user, uid: id })).rejects.toThrow(
        'RUNTIME_USER_MUST_BE_NON_ROOT',
      );
      await expect(initializeState(state, { ...user, gid: id })).rejects.toThrow(
        'RUNTIME_USER_MUST_BE_NON_ROOT',
      );
      expect(mkdir).not.toHaveBeenCalled();
    },
  );
});

describe('runtime privilege drop', () => {
  it('keeps non-root supplementary groups while dropping the root group, then GID, then UID', () => {
    let uid = 0,
      gid = 0;
    const identity = {
      getuid: () => uid,
      getgid: () => gid,
      getgroups: () => [0, 44, 109],
      setgroups: vi.fn(),
      setgid: vi.fn((id: string | number) => {
        gid = Number(id);
      }),
      setuid: vi.fn((id: string | number) => {
        uid = Number(id);
      }),
    };
    dropRuntimePrivileges(user, identity);
    expect(identity.setgroups).toHaveBeenCalledWith([44, 109]);
    expect(identity.setgid).toHaveBeenCalledWith(1000);
    expect(identity.setuid).toHaveBeenCalledWith(1000);
    expect(identity.setgroups.mock.invocationCallOrder[0]).toBeLessThan(
      identity.setgid.mock.invocationCallOrder[0],
    );
    expect(identity.setgid.mock.invocationCallOrder[0]).toBeLessThan(
      identity.setuid.mock.invocationCallOrder[0],
    );
  });
  it('fails closed when the identity transition does not take effect', () => {
    const identity = {
      getuid: () => 0,
      getgid: () => 0,
      getgroups: () => [0],
      setgroups: vi.fn(),
      setgid: vi.fn(),
      setuid: vi.fn(),
    };
    expect(() => dropRuntimePrivileges(user, identity)).toThrow('RUNTIME_PRIVILEGE_DROP_FAILED');
  });
});
