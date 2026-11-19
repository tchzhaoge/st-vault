import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { EmbeddedPostgres, PostgresProcessesRunningError } from '../database/embedded.js';
import { postgresClusterIdentity, ownedPostgresProcesses } from '../database/postgres-processes.js';

describe.skipIf(process.env.STV_TEST_POSTGRES !== '1')('PostgreSQL descendant shutdown', () => {
  const owned: { root: string; server?: EmbeddedPostgres; unsafe: boolean }[] = [];
  async function fixture(shutdownTimeoutMs = 120000) {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-pg-stop-contract-'));
    const entry: { root: string; server?: EmbeddedPostgres; unsafe: boolean } = {
      root,
      unsafe: false,
    };
    owned.push(entry);
    try {
      entry.server = await EmbeddedPostgres.open({
        root,
        binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
        shutdownTimeoutMs,
        ...(process.env.STV_POSTGRES_NSS_WRAPPER
          ? { nssWrapper: process.env.STV_POSTGRES_NSS_WRAPPER }
          : {}),
      });
      return { root, server: entry.server };
    } catch (error) {
      entry.unsafe = error instanceof PostgresProcessesRunningError;
      throw error;
    }
  }
  afterEach(async () => {
    for (const entry of owned.splice(0).reverse()) {
      try {
        if (entry.server && !entry.server.stopped) await entry.server.close();
      } finally {
        if (!entry.unsafe && (!entry.server || entry.server.stopped))
          await rm(entry.root, { recursive: true, force: true });
      }
    }
  });
  async function pauseCheckpointer(root: string) {
    const identity = await postgresClusterIdentity(path.join(root, 'postgres', '18'));
    const children = await ownedPostgresProcesses(identity);
    for (const child of children) {
      const title = await readFile(`/proc/${child.pid}/cmdline`, 'utf8');
      if (title.includes('checkpointer')) {
        process.kill(child.pid, 'SIGSTOP');
        return identity;
      }
    }
    throw Error('CHECKPOINTER_NOT_FOUND');
  }
  it('kills separate child sessions on timeout without touching another cluster, then recovers WAL', async () => {
    const first = await fixture(100),
      second = await fixture();
    const writer = new Client(first.server.connection);
    await writer.connect();
    try {
      await writer.query(
        "CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO sample VALUES(1,'preserved')",
      );
    } finally {
      await writer.end();
    }
    const peer = new Client(second.server.connection);
    await peer.connect();
    try {
      const identity = await pauseCheckpointer(first.root);
      await expect(first.server.close()).rejects.toThrow('POSTGRES_UNCLEAN_SHUTDOWN');
      expect(first.server.stopped).toBe(true);
      expect(await ownedPostgresProcesses(identity)).toEqual([]);
      expect((await peer.query('SELECT 42 AS value')).rows).toEqual([{ value: 42 }]);
      let recovered: EmbeddedPostgres;
      try {
        recovered = await EmbeddedPostgres.open({
          root: first.root,
          binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
        });
      } catch (error) {
        const entry = owned.find((item) => item.root === first.root)!;
        entry.unsafe = error instanceof PostgresProcessesRunningError;
        throw error;
      }
      const entry = { root: first.root, server: recovered, unsafe: false };
      owned.splice(
        owned.findIndex((item) => item.root === first.root),
        1,
        entry,
      );
      const reader = new Client(recovered.connection);
      await reader.connect();
      try {
        expect((await reader.query('SELECT * FROM sample')).rows).toEqual([
          { id: 1, value: 'preserved' },
        ]);
      } finally {
        await reader.end();
      }
    } finally {
      await peer.end();
    }
  }, 60000);
  it('removes orphaned checkpointer sessions after an externally killed postmaster', async () => {
    const fixtureValue = await fixture(100);
    const identity = await pauseCheckpointer(fixtureValue.root);
    const pid = Number(
      (
        await readFile(path.join(fixtureValue.root, 'postgres', '18', 'postmaster.pid'), 'utf8')
      ).split('\n')[0],
    );
    process.kill(pid, 'SIGKILL');
    await fixtureValue.server.exited;
    await expect(fixtureValue.server.close()).rejects.toThrow('POSTGRES_UNCLEAN_SHUTDOWN');
    expect(fixtureValue.server.stopped).toBe(true);
    expect(await ownedPostgresProcesses(identity)).toEqual([]);
  }, 30000);
});
