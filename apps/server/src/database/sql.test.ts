import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { Postgres } from './postgres.js';
import { bindParameters, databaseSchema, SqlDatabase } from './sql.js';
it('binds parameters without rewriting PostgreSQL literals, identifiers or function bodies', () => {
  expect(
    bindParameters(
      `SELECT ?, '?', "?", $$?$$, $body$?$body$, ? -- ?\n/* ? /* ? */ ? */ WHERE key=?`,
    ),
  ).toBe(`SELECT $1, '?', "?", $$?$$, $body$?$body$, $2 -- ?\n/* ? /* ? */ ? */ WHERE key=$3`);
  expect(bindParameters("SELECT 'it''s ?', ?")).toBe("SELECT 'it''s ?', $1");
});
it('uses deterministic isolated schema names without exposing filesystem names', () => {
  expect(databaseSchema('/data/indexes/library')).toBe(databaseSchema('/data/indexes/library'));
  expect(databaseSchema('/data/indexes/library')).not.toBe(databaseSchema('/data/private'));
  expect(databaseSchema('/data/indexes/library')).toMatch(/^stv_[a-f0-9]{24}$/);
});

it.each([false, true])(
  'releases a snapshot once and discards a failed rollback: %s',
  async (failed) => {
    const failure = new Error('SYNTHETIC_ROLLBACK_FAILED');
    const query = failed
      ? vi.fn().mockRejectedValue(failure)
      : vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const snapshot = vi.spyOn(Postgres.prototype, 'snapshot').mockResolvedValue(client);
    const execute = vi.spyOn(Postgres.prototype, 'query').mockResolvedValue([]);
    vi.stubEnv('STV_DATABASE_SOCKET', '/unused-synthetic-socket');
    vi.stubEnv('STV_DATABASE_PASSWORD', 'synthetic-test-only');
    const database = await SqlDatabase.open('/tmp/snapshot-release-test');
    try {
      const view = await database.snapshot();
      if (failed) await expect(view.close()).rejects.toBe(failure);
      else await view.close();
      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0][0] === true).toBe(failed);
      await view.close();
      expect(query).toHaveBeenCalledExactlyOnceWith('ROLLBACK');
      expect(release).toHaveBeenCalledTimes(1);
      expect(view.isOpen).toBe(false);
    } finally {
      await database.close();
      snapshot.mockRestore();
      execute.mockRestore();
      vi.unstubAllEnvs();
    }
  },
);
