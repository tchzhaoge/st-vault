import { beforeEach, expect, it, vi } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { ownedPostgresProcesses } from './postgres-processes.js';

vi.mock('node:fs/promises', () => ({ readdir: vi.fn(), readFile: vi.fn(), stat: vi.fn() }));
const cluster = { directory: '/cluster', device: 1n, inode: 2n, uid: 1000n };
const processStat = (state: string) =>
  `75 (postgres) ${state} 1 75 75 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123`;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readdir).mockResolvedValue(['75'] as never);
  vi.mocked(stat).mockImplementation(((name: string) =>
    name.endsWith('/cwd')
      ? Promise.reject(Object.assign(Error('denied'), { code: 'EACCES' }))
      : Promise.resolve({ uid: 1000n })) as typeof stat);
});
it('recognizes a process that becomes a zombie between stat and cwd inspection', async () => {
  vi.mocked(readFile)
    .mockResolvedValueOnce(processStat('S'))
    .mockResolvedValueOnce(processStat('Z'));
  expect(await ownedPostgresProcesses(cluster)).toEqual([]);
});
it('does not hide permission failures for a process that remains alive', async () => {
  vi.mocked(readFile).mockResolvedValue(processStat('S'));
  await expect(ownedPostgresProcesses(cluster)).rejects.toMatchObject({ code: 'EACCES' });
});
it('recognizes a process reaped during the permission-failure recheck', async () => {
  vi.mocked(readFile)
    .mockResolvedValueOnce(processStat('S'))
    .mockRejectedValueOnce(Object.assign(Error('gone'), { code: 'ENOENT' }));
  expect(await ownedPostgresProcesses(cluster)).toEqual([]);
});
