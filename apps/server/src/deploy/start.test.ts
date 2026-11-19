import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropRuntimePrivileges, initializeState, validateRuntimeUser } from './init.js';
import { EmbeddedPostgres } from '../database/embedded.js';
import { migrateDeployment } from '../database/migrate-deployment.js';
import { superviseApplication } from './processes.js';
import { spawn } from 'node:child_process';
const runtime = vi.hoisted(() => ({
  database: {
    connection: { host: '/fixture/socket', password: 'fixture-secret' },
    exited: Promise.resolve({ code: 0, signal: null }),
    close: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../database/embedded.js', () => ({
  EmbeddedPostgres: { open: vi.fn(() => Promise.resolve(runtime.database)) },
}));
vi.mock('../database/migrate-deployment.js', () => ({
  migrateDeployment: vi.fn(() => Promise.resolve()),
}));
vi.mock('./processes.js', () => ({ superviseApplication: vi.fn(() => Promise.resolve(0)) }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({})) }));
vi.mock('./init.js', () => ({
  dropRuntimePrivileges: vi.fn(),
  initializeState: vi.fn(),
  validateRuntimeUser: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
  chown: vi.fn(),
}));
vi.mock('../runtime/runtime-logs.js', () => ({ installRuntimeLogs: vi.fn() }));
vi.mock('../index.js', () => ({}));
const argv = process.argv;
const exitCode = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubEnv('STV_RUNTIME_UID', '1001');
  vi.stubEnv('STV_RUNTIME_GID', '1002');
  vi.stubEnv('STV_DATA_DIR', '/fixture/state');
  vi.stubEnv('STV_MEDIA_DIR', '/fixture/media');
  vi.stubEnv('STV_POSTGRES_NSS_WRAPPER', undefined);
  vi.stubEnv('STV_DATABASE_SOCKET', '');
  vi.stubEnv('STV_DATABASE_PASSWORD', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('single-service startup', () => {
  it('initializes state and drops privileges without a role argument', async () => {
    process.argv = ['node', 'start.js'];
    await import('./start.js');
    expect(validateRuntimeUser).toHaveBeenCalledWith({ uid: 1001, gid: 1002 });
    expect(initializeState).toHaveBeenCalledWith(
      path.resolve('/fixture/state'),
      {
        uid: 1001,
        gid: 1002,
      },
      path.resolve('/fixture/media'),
    );
    expect(vi.mocked(initializeState).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dropRuntimePrivileges).mock.invocationCallOrder[0],
    );
    expect(EmbeddedPostgres.open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ nssWrapper: '/usr/local/lib/libnss_wrapper.so' }),
    );
    expect(vi.mocked(dropRuntimePrivileges).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(EmbeddedPostgres.open).mock.invocationCallOrder[0],
    );
    expect(migrateDeployment).toHaveBeenCalledWith(
      path.resolve('/fixture/state'),
      path.resolve('/fixture/media'),
      expect.any(AbortSignal),
    );
    expect(vi.mocked(migrateDeployment).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0],
    );
    expect(superviseApplication).toHaveBeenCalledOnce();
    expect(process.env.STV_DATABASE_SOCKET).toBe('/fixture/socket');
  });
  it('fails before privilege transition if initialization fails', async () => {
    process.argv = ['node', 'start.js'];
    vi.mocked(initializeState).mockRejectedValueOnce(new Error('UNSAFE_INIT_DIRECTORY'));
    await expect(import('./start.js')).rejects.toThrow('UNSAFE_INIT_DIRECTORY');
    expect(dropRuntimePrivileges).not.toHaveBeenCalled();
  });
  it('rejects extra startup arguments before touching state', async () => {
    process.argv = ['node', 'start.js', 'companion'];
    await expect(import('./start.js')).rejects.toThrow('UNEXPECTED_RUNTIME_ARGUMENT');
    expect(initializeState).not.toHaveBeenCalled();
  });
  it('closes PostgreSQL and does not launch the app if migration fails', async () => {
    process.argv = ['node', 'start.js'];
    vi.mocked(migrateDeployment).mockRejectedValueOnce(Error('MIGRATION_TEST_FAILED'));
    await expect(import('./start.js')).rejects.toThrow('MIGRATION_TEST_FAILED');
    expect(spawn).not.toHaveBeenCalled();
    expect(runtime.database.close).toHaveBeenCalledOnce();
  });
});
