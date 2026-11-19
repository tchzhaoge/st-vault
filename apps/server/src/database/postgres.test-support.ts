import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EmbeddedPostgres, PostgresProcessesRunningError } from './embedded.js';

export interface TestPostgresServer {
  close(): Promise<void>;
}
/** Existing global test credentials are reused; no host service is needed. */
export async function startTestPostgres(): Promise<TestPostgresServer> {
  if (process.env.STV_DATABASE_SOCKET && process.env.STV_DATABASE_PASSWORD)
    return { close: () => Promise.resolve() };
  const root = await mkdtemp(path.join(tmpdir(), 'stv-postgres-suite-'));
  let database: EmbeddedPostgres;
  try {
    database = await EmbeddedPostgres.open({
      root,
      binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    });
  } catch (error) {
    if (!(error instanceof PostgresProcessesRunningError))
      await rm(root, { recursive: true, force: true });
    throw error;
  }
  const previousSocket = process.env.STV_DATABASE_SOCKET,
    previousPassword = process.env.STV_DATABASE_PASSWORD;
  process.env.STV_DATABASE_SOCKET = String(database.connection.host);
  process.env.STV_DATABASE_PASSWORD = String(database.connection.password);
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        if (previousSocket === undefined) delete process.env.STV_DATABASE_SOCKET;
        else process.env.STV_DATABASE_SOCKET = previousSocket;
        if (previousPassword === undefined) delete process.env.STV_DATABASE_PASSWORD;
        else process.env.STV_DATABASE_PASSWORD = previousPassword;
        try {
          await database.close();
        } finally {
          if (database.stopped) await rm(root, { recursive: true, force: true });
        }
      })()),
  };
}
