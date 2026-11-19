import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  EmbeddedPostgres,
  PostgresProcessesRunningError,
} from '../build/apps/server/src/database/embedded.js';
import { superviseApplication } from '../build/apps/server/src/deploy/processes.js';

const [command, ...args] = process.argv.slice(2);
if (!command) throw Error('QA_COMMAND_REQUIRED');
const root = await mkdtemp(path.join(tmpdir(), 'stv-qa-postgres-'));
let database;
let cleanupAllowed = true;
try {
  database = await EmbeddedPostgres.open({
    root,
    binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    nssWrapper: '/usr/local/lib/libnss_wrapper.so',
  });
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      STV_DATABASE_SOCKET: String(database.connection.host),
      STV_DATABASE_PASSWORD: String(database.connection.password),
    },
  });
  process.exitCode = await superviseApplication(child, database);
} catch (error) {
  if (error instanceof PostgresProcessesRunningError) cleanupAllowed = false;
  throw error;
} finally {
  try {
    if (database) await database.close();
  } finally {
    // Only this mkdtemp directory is disposable; no mounted production paths.
    if ((!database && cleanupAllowed) || database?.stopped)
      await rm(root, { recursive: true, force: true });
  }
}
