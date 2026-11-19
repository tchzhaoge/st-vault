/* eslint-disable @typescript-eslint/require-await -- Asynchronous source fixtures. */
import { expect, it, vi } from 'vitest';
import type { PublicStatus, Subject } from '@st-vault/api-schema';
import { StatusEvidence } from './status-evidence.js';
import { SyncClock } from '../runtime/sync-clock.js';

const subject: Subject = {
  id: 'stripchat:42',
  providerId: 42,
  handle: 'fixture',
  monitorEnabled: true,
  autoRecord: true,
  providerStatus: 'UNKNOWN',
  observedAtMs: null,
};
it('uses the injected observation capacity and derives active permission leases from its rotation', async () => {
  const releases: ((status: PublicStatus) => void)[] = [];
  const status = vi.fn(() => new Promise<PublicStatus>((resolve) => releases.push(resolve)));
  const evidence = new StatusEvidence({
    provider: { status },
    publicConcurrency: 32,
    monitorConcurrency: 16,
  });
  const observations = Array.from({ length: 32 }, (_, index) =>
    evidence.observe({ ...subject, id: `stripchat:${index + 1}`, providerId: index + 1 }),
  );
  try {
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(32));
    const releaseInterest = evidence.retain(subject, () => undefined);
    expect(evidence.monitorCapacity).toBe(16);
    releaseInterest();
    expect(evidence.monitorCapacity).toBe(32);
  } finally {
    const closed = evidence.close();
    releases.forEach((release) => release('PUBLIC'));
    await closed;
    await Promise.allSettled(observations);
  }
});
it('accounts for the configured active batch rather than a hard-coded four in its lease', async () => {
  const evidence = new StatusEvidence({
    provider: { status: () => Promise.resolve('PUBLIC') },
    now: () => 1000,
    publicConcurrency: 16,
    monitorConcurrency: 8,
    intervalMs: () => 1000,
    leaseMs: () => 1000,
  });
  const releases = Array.from({ length: 24 }, (_, index) =>
    evidence.retain(
      { ...subject, id: `stripchat:${index + 1}`, providerId: index + 1 },
      () => undefined,
    ),
  );
  try {
    evidence.seedPublic(subject, 1000);
    expect(evidence.snapshot(subject.id).publicUntilMs).toBe(10000);
  } finally {
    releases.forEach((release) => release());
    await evidence.close();
  }
});
it('shares an in-flight observation and its confirmation between media and monitoring', async () => {
  let release!: (status: PublicStatus) => void;
  const status = vi.fn(
    () =>
      new Promise<PublicStatus>((resolve) => {
        release = resolve;
      }),
  );
  const evidence = new StatusEvidence({ provider: { status } });
  try {
    const monitoring = evidence.observe(subject);
    const media = evidence.observe(subject);
    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
    release('PUBLIC');
    expect(await monitoring).toMatchObject({ status: 'PUBLIC' });
    expect(await media).toMatchObject({ status: 'PUBLIC' });
    expect(evidence.public(subject.id)).toBe(true);
    expect(status).toHaveBeenCalledOnce();
  } finally {
    await evidence.close();
  }
});
it('backdates confirmed changes, and does not renew PUBLIC permission on UNKNOWN', async () => {
  let now = 1000;
  const persist = vi.fn(async () => undefined);
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockResolvedValueOnce('PUBLIC')
    .mockImplementationOnce(async () => {
      now = 2000;
      return 'OFFLINE';
    })
    .mockImplementationOnce(async () => {
      now = 2400;
      return 'UNKNOWN';
    })
    .mockImplementationOnce(async () => {
      now = 5000;
      return 'OFFLINE';
    });
  const evidence = new StatusEvidence({
    provider: { status },
    now: () => now,
    persist,
    leaseMs: () => 15000,
  });
  try {
    await evidence.observe(subject);
    const deadline = evidence.snapshot(subject.id).publicUntilMs;
    await evidence.observe(subject);
    expect(evidence.snapshot(subject.id).publicUntilMs).toBe(deadline);
    await evidence.observe(subject);
    expect(persist.mock.calls.at(-1)).toEqual([subject.id, 'OFFLINE', 5000, 15000, 2000]);
  } finally {
    await evidence.close();
  }
});
it('revokes public media on the first PRIVATE response before confirmation completes', async () => {
  let confirm!: (value: PublicStatus) => void;
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockResolvedValueOnce('PUBLIC')
    .mockResolvedValueOnce('PRIVATE')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
  const evidence = new StatusEvidence({ provider: { status } });
  try {
    await evidence.observe(subject);
    const changed = vi.fn();
    const release = evidence.retain(subject, changed);
    const observing = evidence.observe(subject);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    expect(evidence.public(subject.id)).toBe(false);
    expect(evidence.snapshot(subject.id).revocation).toBe('PRIVATE');
    expect(changed).toHaveBeenCalled();
    confirm('PRIVATE');
    await observing;
    release();
  } finally {
    await evidence.close();
  }
});
it('keeps one shared offline recovery window instead of tearing media down on a second raw response', async () => {
  let now = 1000;
  const status = vi.fn<() => Promise<PublicStatus>>().mockResolvedValue('PUBLIC');
  const evidence = new StatusEvidence({
    provider: { status },
    now: () => now,
    leaseMs: () => 60000,
  });
  try {
    await evidence.observe(subject);
    status.mockResolvedValue('OFFLINE');
    now = 2000;
    await evidence.observe(subject);
    expect(evidence.public(subject.id)).toBe(true);
    now = 18000;
    await evidence.observe(subject);
    expect(evidence.public(subject.id)).toBe(false);
    expect(evidence.snapshot(subject.id).revocation).toBe('OFFLINE');
  } finally {
    await evidence.close();
  }
});
it('caps actual requests across all consumers even after logical timeouts', async () => {
  const releases: ((value: PublicStatus) => void)[] = [];
  const status = vi.fn(
    () =>
      new Promise<PublicStatus>((resolve) => {
        releases.push(resolve);
      }),
  );
  const evidence = new StatusEvidence({ provider: { status }, timeoutMs: 10 });
  try {
    const pending = Array.from({ length: 9 }, (_, index) =>
      evidence.observe({
        ...subject,
        id: `stripchat:${index + 1}`,
        providerId: index + 1,
      }),
    );
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(8));
    await Promise.all(pending);
    expect(evidence.pending).toBe(8);
    await evidence.observe({ ...subject, id: 'stripchat:1', providerId: 1 });
    expect(status).toHaveBeenCalledTimes(8);
  } finally {
    releases.forEach((release) => release('PUBLIC'));
    await evidence.close();
  }
});
it('rotates active viewers on the common clock and reserves monitoring capacity', async () => {
  vi.useFakeTimers();
  const clock = new SyncClock({ intervalMs: () => 1000 });
  const visited: number[] = [];
  const evidence = new StatusEvidence({
    clock,
    intervalMs: () => 1000,
    provider: {
      status: async (id) => {
        visited.push(id);
        return 'PUBLIC';
      },
    },
  });
  const releases = Array.from({ length: 6 }, (_, index) =>
    evidence.retain(
      {
        ...subject,
        id: `stripchat:${index + 1}`,
        providerId: index + 1,
      },
      () => undefined,
    ),
  );
  try {
    expect(evidence.monitorCapacity).toBe(4);
    await vi.advanceTimersByTimeAsync(1300);
    expect(new Set(visited)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    releases.forEach((release) => release());
    expect(evidence.monitorCapacity).toBe(8);
    const count = visited.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(visited).toHaveLength(count);
  } finally {
    await evidence.close();
    await clock.close();
    vi.useRealTimers();
  }
});
