import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Metadata } from './metadata.js';
import { openArchive } from './index.js';

it('retains completed index readiness across later reads without control RPCs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-ready-'));
  const calls = vi.spyOn(Metadata.prototype, 'call');
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    await archive.snapshotUnit!('stripchat:42', 0);
    calls.mockClear();
    await archive.snapshotUnit!('stripchat:42', 0);
    await archive.unitSource!('stripchat:42', '00000000-0000-4000-8000-000000000042', 0);
    expect(calls.mock.calls.filter(([method]) => method === 'buildRecordingUnits')).toHaveLength(0);
  } finally {
    await archive.close();
    calls.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('retries failed startup index construction and then retains its successful readiness', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-retry-'));
  const original = Metadata.prototype.call;
  let builds = 0;
  const calls = vi.spyOn(Metadata.prototype, 'call').mockImplementation(function <T>(
    this: Metadata,
    method: string,
    input: unknown = {},
  ): Promise<T> {
    if (method === 'buildRecordingUnits') {
      builds++;
      if (builds === 1) return Promise.reject(Error('SYNTHETIC_INDEX_FAILURE'));
      if (builds === 2) return Promise.resolve(true as T);
    }
    return original.call(this, method, input) as Promise<T>;
  });
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    await archive.snapshotUnit!('stripchat:42', 0);
    await archive.snapshotUnit!('stripchat:42', 0);
    expect(builds).toBe(3);
  } finally {
    await archive.close();
    calls.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('drains an in-flight index batch during close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-drain-'));
  const original = Metadata.prototype.call;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = vi.spyOn(Metadata.prototype, 'call').mockImplementation(function <T>(
    this: Metadata,
    method: string,
    input: unknown = {},
  ): Promise<T> {
    if (method === 'buildRecordingUnits')
      return gate.then(() => original.call(this, method, input)) as Promise<T>;
    return original.call(this, method, input) as Promise<T>;
  });
  const archive = await openArchive({ root });
  let closed = false;
  const closing = archive.close().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally {
    release();
    await closing;
    calls.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
