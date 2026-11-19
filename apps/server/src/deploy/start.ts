import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, lstat, chown } from 'node:fs/promises';
import { installRuntimeLogs } from '../runtime/runtime-logs.js';
import { dropRuntimePrivileges, initializeState, validateRuntimeUser } from './init.js';
import { EmbeddedPostgres } from '../database/embedded.js';
import { migrateDeployment } from '../database/migrate-deployment.js';
import { superviseApplication } from './processes.js';
import { getExecutionPolicy } from '../runtime/execution-policy.js';

if (process.argv.length > 2) throw new Error('UNEXPECTED_RUNTIME_ARGUMENT');
const user = {
  uid: Number(process.env.STV_RUNTIME_UID ?? 1000),
  gid: Number(process.env.STV_RUNTIME_GID ?? 1000),
};
validateRuntimeUser(user);
const dataRoot = path.resolve(process.env.STV_DATA_DIR ?? '/data');
const mediaRoot = path.resolve(process.env.STV_MEDIA_DIR ?? '/media');
await initializeState(dataRoot, user, mediaRoot);
const logDirectory = path.resolve(
  process.env.STV_LOG_DIR ?? path.join(process.env.STV_DATA_DIR ?? '/data', 'logs'),
);
await mkdir(logDirectory, { recursive: true, mode: 0o700 });
if ((await lstat(logDirectory)).isSymbolicLink()) throw Error('INVALID_LOG_DIRECTORY');
await chown(logDirectory, user.uid, user.gid);
dropRuntimePrivileges(user);
installRuntimeLogs(logDirectory, 'supervisor');
console.log(JSON.stringify({ event: 'runtime_initialized', ...user }));
const execution = getExecutionPolicy();
const resourceEnvironment = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value?.length ? value : fallback;
};
const nodeOptions = resourceEnvironment(
  'NODE_OPTIONS',
  `--max-old-space-size=${execution.nodeHeapMb}`,
);
const ioThreads = resourceEnvironment('UV_THREADPOOL_SIZE', String(execution.ioConcurrency));
console.info(JSON.stringify({ event: 'execution_policy', ...execution }));
const startup = new AbortController();
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
const interrupt = () => {
  if (startup.signal.aborted) return;
  startup.abort(Error('RUNTIME_STOP_REQUESTED'));
  shutdownTimer = setTimeout(() => {
    console.error('startup_shutdown_timeout');
    process.exit(1);
  }, 175000);
  shutdownTimer.unref();
};
process.on('SIGTERM', interrupt);
process.on('SIGINT', interrupt);
let database: EmbeddedPostgres | undefined,
  handedOff = false;
try {
  database = await EmbeddedPostgres.open({
    root: dataRoot,
    binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    nssWrapper: process.env.STV_POSTGRES_NSS_WRAPPER ?? '/usr/local/lib/libnss_wrapper.so',
  });
  process.env.STV_DATABASE_SOCKET = String(database.connection.host);
  process.env.STV_DATABASE_PASSWORD = String(database.connection.password);
  startup.signal.throwIfAborted();
  await migrateDeployment(dataRoot, mediaRoot, startup.signal);
  startup.signal.throwIfAborted();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./application.js', import.meta.url))],
    {
      env: {
        ...process.env,
        STV_DATA_DIR: dataRoot,
        STV_MEDIA_DIR: mediaRoot,
        STV_LOG_DIR: logDirectory,
        NODE_OPTIONS: nodeOptions,
        UV_THREADPOOL_SIZE: ioThreads,
      },
      stdio: 'inherit',
    },
  );
  process.off('SIGTERM', interrupt);
  process.off('SIGINT', interrupt);
  clearTimeout(shutdownTimer);
  handedOff = true;
  process.exitCode = await superviseApplication(child, database);
} catch (error) {
  if (!startup.signal.aborted) {
    console.error('runtime_failed', error);
    throw error;
  }
  console.log(JSON.stringify({ event: 'startup_stopped' }));
} finally {
  process.off('SIGTERM', interrupt);
  process.off('SIGINT', interrupt);
  clearTimeout(shutdownTimer);
  if (database && !handedOff) await database.close();
}
