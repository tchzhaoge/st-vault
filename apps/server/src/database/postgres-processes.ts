import { readdir, readFile, stat } from 'node:fs/promises';

export interface PostgresClusterIdentity {
  directory: string;
  device: bigint;
  inode: bigint;
  uid: bigint;
}
export interface PostgresProcess {
  pid: number;
  group: number;
  started: string;
}
function vanished(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && ['ENOENT', 'ESRCH'].includes(String(error.code))
  );
}
/** PG children create their own sessions; a postmaster process group is insufficient. */
export async function postgresClusterIdentity(directory: string): Promise<PostgresClusterIdentity> {
  const info = await stat(directory, { bigint: true });
  return { directory, device: info.dev, inode: info.ino, uid: info.uid };
}
async function identify(
  pid: number,
  cluster: PostgresClusterIdentity,
): Promise<PostgresProcess | undefined> {
  try {
    const owner = await stat(`/proc/${pid}`, { bigint: true });
    if (owner.uid !== cluster.uid) return;
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = value.lastIndexOf(')');
    if (value.slice(value.indexOf('(') + 1, close) !== 'postgres') return;
    const fields = value
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return;
    const cwd = await stat(`/proc/${pid}/cwd`, { bigint: true });
    if (cwd.dev !== cluster.device || cwd.ino !== cluster.inode) return;
    return { pid, group: Number(fields[2]), started: fields[19] };
  } catch (error) {
    if (vanished(error)) return;
    if (error instanceof Error && 'code' in error && error.code === 'EACCES') {
      // Linux revokes access to a zombie's cwd. It may have exited after the
      // first stat read; confirm that transition instead of hiding live errors.
      try {
        const latest = await readFile(`/proc/${pid}/stat`, 'utf8');
        const state = latest.slice(latest.lastIndexOf(')') + 2).split(/\s+/, 1)[0];
        if (state === 'Z' || state === 'X') return;
      } catch (recheckError) {
        if (vanished(recheckError)) return;
        throw recheckError;
      }
    }
    throw error;
  }
}
export async function ownedPostgresProcesses(
  cluster: PostgresClusterIdentity,
): Promise<PostgresProcess[]> {
  const found: PostgresProcess[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const record = await identify(Number(name), cluster);
    if (record) found.push(record);
  }
  return found;
}
/** Recheck birth and directory before signalling; never signal a parent/shared group. */
export async function killPostgresProcesses(
  cluster: PostgresClusterIdentity,
  records: PostgresProcess[],
): Promise<void> {
  for (const record of records) {
    if (record.pid <= 1 || record.pid === process.pid) throw Error('UNSAFE_POSTGRES_PROCESS');
    const current = await identify(record.pid, cluster);
    if (current?.started !== record.started) continue;
    try {
      process.kill(current.group === current.pid ? -current.pid : current.pid, 'SIGKILL');
    } catch (error) {
      if (!vanished(error)) throw error;
    }
  }
}
