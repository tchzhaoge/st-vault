import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, lstat, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson, syncDirectory } from '../library/files.js';
import { FileLease } from './file-lease.js';
import {
  postgresClusterIdentity,
  ownedPostgresProcesses,
  killPostgresProcesses,
} from './postgres-processes.js';
import type { PostgresClusterIdentity } from './postgres-processes.js';
import { Client } from 'pg';
import type { PoolConfig } from 'pg';
import { getExecutionPolicy } from '../runtime/execution-policy.js';

interface Options {
  root: string;
  binaries: string;
  nssWrapper?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export class PostgresProcessesRunningError extends Error {
  constructor(cause?: unknown) {
    super('POSTGRES_PROCESSES_STILL_RUNNING', { cause });
  }
}
async function exists(filename: string): Promise<boolean> {
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw Error('UNSAFE_POSTGRES_PATH');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
async function directory(filename: string): Promise<void> {
  await mkdir(filename, { recursive: true, mode: 0o700 });
  const info = await lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('UNSAFE_POSTGRES_PATH');
}
/** Owns one private, Unix-socket-only PostgreSQL child, not the application process. */
export class EmbeddedPostgres {
  readonly connection: PoolConfig;
  readonly exited: Promise<Exit>;
  private readonly child: ChildProcess;
  private readonly temporary: string;
  private stopping: Promise<void> | undefined;
  private readonly lease: FileLease;
  private readonly cluster: PostgresClusterIdentity;
  private readonly shutdownTimeoutMs: number;
  private processesStopped = false;
  get stopped(): boolean {
    return this.processesStopped;
  }
  private constructor(
    child: ChildProcess,
    temporary: string,
    password: string,
    lease: FileLease,
    cluster: PostgresClusterIdentity,
    shutdownTimeoutMs: number,
  ) {
    this.cluster = cluster;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.lease = lease;
    this.child = child;
    this.temporary = temporary;
    this.connection = {
      host: temporary,
      port: 5432,
      user: 'stvault',
      database: 'stvault',
      password,
    };
    this.exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // Install rejection ownership immediately, including startup failure paths.
    void this.exited.catch((error: unknown) =>
      console.error(
        'postgres_process_error',
        error instanceof Error && 'code' in error ? error.code : 'UNKNOWN',
      ),
    );
  }
  static async open(options: Options): Promise<EmbeddedPostgres> {
    const uid = process.getuid?.();
    if (!uid) throw Error('POSTGRES_REQUIRES_NON_ROOT');
    const root = path.resolve(options.root);
    await directory(root);
    await directory(path.join(root, 'private'));
    await directory(path.join(root, 'postgres'));
    const lease = await FileLease.acquire(path.join(root, 'postgres', '.instance.lock'));
    const ownership = { transferred: false };
    try {
      return await EmbeddedPostgres.openLocked(options, root, uid, lease, ownership);
    } catch (error) {
      if (!ownership.transferred) await lease.close();
      throw error;
    }
  }
  private static async openLocked(
    options: Options,
    root: string,
    uid: number,
    lease: FileLease,
    ownership: { transferred: boolean },
  ): Promise<EmbeddedPostgres> {
    const credentials = path.join(root, 'private', 'postgres.json');
    let password: string;
    let initializing = false;
    if (await exists(credentials)) {
      const value: unknown = JSON.parse(await readFile(credentials, 'utf8'));
      if (
        typeof value !== 'object' ||
        !value ||
        !('password' in value) ||
        typeof value.password !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.password)
      )
        throw Error('INVALID_POSTGRES_CREDENTIALS');
      password = value.password;
      initializing = 'initializing' in value && value.initializing === true;
    } else {
      password = randomBytes(32).toString('hex');
      atomicJson(credentials, { password });
    }
    const cluster = path.join(root, 'postgres', '18');
    const temporary = await mkdtemp(path.join(tmpdir(), 'stv-postgres-'));
    const environment = { ...process.env };
    if (options.nssWrapper) {
      const passwd = path.join(temporary, 'passwd');
      const group = path.join(temporary, 'group');
      await writeFile(passwd, `stv:x:${uid}:${process.getgid!()}:ST-Vault:${root}:/bin/false\n`, {
        mode: 0o600,
      });
      await writeFile(group, `stv:x:${process.getgid!()}:\n`, { mode: 0o600 });
      environment.LD_PRELOAD = options.nssWrapper;
      environment.NSS_WRAPPER_PASSWD = passwd;
      environment.NSS_WRAPPER_GROUP = group;
    }
    let service: EmbeddedPostgres | undefined;
    try {
      if (!(await exists(cluster))) {
        const staging = path.join(root, 'postgres', 'initializing');
        if (await exists(staging)) {
          if (!initializing) throw Error('POSTGRES_INITIALIZATION_INCOMPLETE');
          // Only our marked, reserved initdb staging directory is disposable.
          // A completed cluster is never removed by this recovery path.
          if (path.dirname(staging) !== path.join(root, 'postgres'))
            throw Error('UNSAFE_POSTGRES_PATH');
          await rm(staging, { recursive: true });
        }
        atomicJson(credentials, { password, initializing: true });
        const secret = path.join(temporary, 'bootstrap-password');
        await writeFile(secret, password, { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            path.join(options.binaries, 'initdb'),
            [
              '-D',
              staging,
              '--username=stv_bootstrap',
              '--encoding=UTF8',
              '--no-locale',
              '--auth-local=scram-sha-256',
              '--auth-host=reject',
              `--pwfile=${secret}`,
            ],
            { env: environment, stdio: ['ignore', 'ignore', 'inherit'] },
          );
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(Error('POSTGRES_INITDB_FAILED')),
          );
        });
        await rename(staging, cluster);
        syncDirectory(path.dirname(cluster));
      }
      atomicJson(credentials, { password });
      const version = (await readFile(path.join(cluster, 'PG_VERSION'), 'utf8')).trim();
      if (version !== '18') throw Error('UNSUPPORTED_POSTGRES_CLUSTER');
      const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const configuration = path.join(temporary, 'postgresql.conf');
      const budgets = getExecutionPolicy().database;
      await writeFile(
        configuration,
        [
          `data_directory=${quoted(cluster)}`,
          `hba_file=${quoted(path.join(cluster, 'pg_hba.conf'))}`,
          `ident_file=${quoted(path.join(cluster, 'pg_ident.conf'))}`,
          "listen_addresses=''",
          `unix_socket_directories=${quoted(temporary)}`,
          'unix_socket_permissions=0700',
          `max_connections=${budgets.maxConnections}`,
          'jit=off',
          `shared_buffers=${budgets.sharedBuffersMb}MB`,
          `work_mem=${budgets.workMemMb}MB`,
          `maintenance_work_mem=${budgets.maintenanceWorkMemMb}MB`,
          'max_wal_size=2GB',
          'min_wal_size=128MB',
          'log_min_messages=warning',
          'log_statement=none',
          'log_min_error_statement=panic',
          'logging_collector=off',
        ].join('\n') + '\n',
        { mode: 0o600 },
      );
      const clusterIdentity = await postgresClusterIdentity(cluster);
      const child = spawn(
        path.join(options.binaries, 'postgres'),
        ['-D', cluster, '-c', `config_file=${configuration}`],
        { env: environment, stdio: ['ignore', 'inherit', 'inherit'], detached: true },
      );
      service = new EmbeddedPostgres(
        child,
        temporary,
        password,
        lease,
        clusterIdentity,
        options.shutdownTimeoutMs ?? 120000,
      );
      ownership.transferred = true;
      let exit: Exit | undefined;
      void service.exited.then(
        (value) => {
          exit = value;
        },
        () => {
          exit = { code: -1, signal: null };
        },
      );
      const deadline = Date.now() + (options.startupTimeoutMs ?? 60000);
      for (;;) {
        if (exit) throw Error('POSTGRES_EXITED_DURING_STARTUP');
        const client = new Client({ ...service.connection, connectionTimeoutMillis: 1000 });
        try {
          await client.connect();
          await client.query('SELECT 1');
          break;
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            ['28P01', '28000', '3D000'].includes(String(error.code))
          ) {
            await service.bootstrap();
          } else if (Date.now() >= deadline)
            throw Error('POSTGRES_STARTUP_TIMEOUT', { cause: error });
        } finally {
          await client.end();
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return service;
    } catch (error) {
      try {
        if (service) await service.close();
        else await rm(temporary, { recursive: true, force: true });
      } catch (cleanupError) {
        if (service && !service.stopped)
          throw new PostgresProcessesRunningError(new AggregateError([error, cleanupError]));
        throw new AggregateError([error, cleanupError], 'POSTGRES_STARTUP_RECOVERY_FAILED');
      }
      throw error;
    }
  }
  private async bootstrap(): Promise<void> {
    const client = new Client({ ...this.connection, user: 'stv_bootstrap', database: 'postgres' });
    try {
      await client.connect();
      const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname='stvault'");
      if (!role.rowCount) {
        const ddl = await client.query<{ sql: string }>(
          "SELECT format('CREATE ROLE stvault LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text) AS sql",
          [this.connection.password],
        );
        await client.query(ddl.rows[0].sql);
      }
      const database = await client.query("SELECT 1 FROM pg_database WHERE datname='stvault'");
      if (!database.rowCount) await client.query('CREATE DATABASE stvault OWNER stvault');
      const hba = await client.query<{ hba_file: string }>('SHOW hba_file');
      await writeFile(
        hba.rows[0].hba_file,
        'local stvault stvault scram-sha-256\nlocal all all reject\nhost all all all reject\n',
        { mode: 0o600 },
      );
      await client.query('SELECT pg_reload_conf()');
    } finally {
      await client.end();
    }
  }
  close(): Promise<void> {
    this.stopping ??= this.stop();
    return this.stopping;
  }
  private async stop(): Promise<void> {
    const alive = this.child.exitCode === null && this.child.signalCode === null;
    if (alive) this.child.kill('SIGINT');
    let exit: Exit | undefined,
      exitError: unknown,
      forced = !alive;
    void this.exited.then(
      (value) => {
        exit = value;
      },
      (error) => {
        exitError = error;
      },
    );
    const deadline = Date.now() + this.shutdownTimeoutMs;
    let killDeadline = forced ? Date.now() + 5000 : Infinity;
    try {
      for (;;) {
        const children = await ownedPostgresProcesses(this.cluster);
        if (!children.length && (exit || exitError || !this.child.pid)) break;
        if (exit && (exit.code !== 0 || exit.signal !== null)) forced = true;
        if (!forced && Date.now() >= deadline) forced = true;
        if (forced) {
          if (killDeadline === Infinity) killDeadline = Date.now() + 5000;
          await killPostgresProcesses(this.cluster, children);
          if (children.length && Date.now() >= killDeadline)
            throw new PostgresProcessesRunningError();
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      this.processesStopped = true;
      if (exitError) throw Error('POSTGRES_PROCESS_EXIT_FAILED', { cause: exitError });
      const outcome = exit ?? (await this.exited);
      if (forced || outcome.code !== 0) throw Error('POSTGRES_UNCLEAN_SHUTDOWN');
    } catch (error) {
      if (!this.processesStopped && !(error instanceof PostgresProcessesRunningError))
        throw new PostgresProcessesRunningError(error);
      throw error;
    } finally {
      if (this.processesStopped) {
        try {
          await rm(this.temporary, { recursive: true, force: true });
        } finally {
          await this.lease.close();
        }
      }
    }
  }
}
