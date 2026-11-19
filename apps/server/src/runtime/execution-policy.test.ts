import { expect, it } from 'vitest';
import { cpuQuota, deriveExecutionPolicy } from './execution-policy.js';

const GIB = 1024 ** 3;
it('uses strong hardware while reserving memory and connection headroom', () => {
  const policy = deriveExecutionPolicy({ cpuCount: 16, memoryBytes: 8 * GIB });
  expect(policy.previews.decoderConcurrency).toBe(8);
  expect(policy.ioConcurrency).toBe(32);
  expect(policy.status.publicConcurrency).toBe(64);
  expect(policy.database.sharedBuffersMb).toBe(512);
  expect(
    policy.database.interactiveConnections +
      policy.database.backgroundConnections +
      policy.database.playbackConnections +
      policy.database.writerConnections +
      policy.database.snapshotConnections +
      policy.database.jobsInteractiveConnections +
      policy.database.jobsBackgroundConnections +
      10,
  ).toBeLessThanOrEqual(policy.database.maxConnections);
});
it('keeps explicitly small network and I/O budgets internally valid', () => {
  const policy = deriveExecutionPolicy({
    cpuCount: 4,
    memoryBytes: 4 * GIB,
    networkConcurrency: 1,
    ioConcurrency: 1,
  });
  expect(policy.status.monitorConcurrency).toBeLessThanOrEqual(policy.status.publicConcurrency);
  expect(policy.previews.networkConcurrency).toBe(1);
  expect(policy.archive.gcConcurrency).toBe(1);
});
it('honors fractional CPU quotas and does not multiply decoders past the memory plan', () => {
  const small = deriveExecutionPolicy({ cpuCount: 2.5, memoryBytes: 2 * GIB });
  const constrained = deriveExecutionPolicy({
    cpuCount: 64,
    memoryBytes: 2 * GIB,
    decoderConcurrency: 32,
  });
  expect(small.previews.decoderConcurrency).toBe(1);
  expect(small.nodeHeapMb).toBe(256);
  expect(constrained.previews.decoderConcurrency).toBe(3);
  expect(constrained.database.sharedBuffersMb).toBe(128);
});
it('accepts explicit resource-class overrides without conflating network and CPU tasks', () => {
  const policy = deriveExecutionPolicy({
    cpuCount: 8,
    memoryBytes: 8 * GIB,
    decoderConcurrency: 6,
    ioConcurrency: 24,
    networkConcurrency: 48,
  });
  expect(policy.previews.decoderConcurrency).toBe(6);
  expect(policy.ioConcurrency).toBe(24);
  expect(policy.live.mediaConcurrency).toBe(48);
  expect(policy.status.monitorConcurrency).toBe(24);
});
it('rejects invalid resource settings rather than silently ignoring them', () => {
  for (const input of [0, -1, NaN, Infinity])
    expect(() => deriveExecutionPolicy({ cpuCount: input, memoryBytes: 2 * GIB })).toThrow(
      'INVALID_EXECUTION_RESOURCES',
    );
  for (const value of [0, -1, 1.5, NaN, 257])
    expect(() =>
      deriveExecutionPolicy({ cpuCount: 8, memoryBytes: 8 * GIB, ioConcurrency: value }),
    ).toThrow('INVALID_EXECUTION_CONCURRENCY');
});
it('parses cgroup CPU quotas and unlimited or malformed inputs', () => {
  expect(cpuQuota('250000 100000\n')).toBe(2.5);
  expect(cpuQuota('max 100000')).toBeUndefined();
  expect(cpuQuota('-1 100000')).toBeUndefined();
  expect(cpuQuota('100 0')).toBeUndefined();
});
it('keeps large resource overrides within the downstream worker contracts', () => {
  const policy = deriveExecutionPolicy({
    cpuCount: 128,
    memoryBytes: 128 * GIB,
    decoderConcurrency: 256,
    ioConcurrency: 256,
    networkConcurrency: 256,
  });
  expect(policy.previews.decoderConcurrency).toBeLessThanOrEqual(64);
  expect(policy.archive.gcConcurrency).toBeLessThanOrEqual(64);
  expect(policy.previews.networkConcurrency).toBeLessThanOrEqual(64);
  expect(policy.ioConcurrency).toBe(256);
});
