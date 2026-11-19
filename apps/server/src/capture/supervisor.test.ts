/* eslint-disable @typescript-eslint/require-await -- Async port fixtures deliberately complete without I/O. */
import { describe, expect, it, vi } from 'vitest';
import type { PublicStatus, Segment, Subject } from '@st-vault/api-schema';
import type { ArchivePort, CaptureSink, CommitInput, ProviderPort } from '../ports.js';
import { createSupervisor } from './supervisor.js';
import { SyncClock } from '../runtime/sync-clock.js';
import { StatusEvidence } from '../provider/status-evidence.js';

function subject(id = 1): Subject {
  return {
    id: `stripchat:${id}`,
    providerId: id,
    handle: `fixture-${id}`,
    monitorEnabled: true,
    autoRecord: true,
    providerStatus: 'UNKNOWN',
    observedAtMs: null,
  };
}
it('runs the configured monitor rotation rather than the old fixed eight workers', async () => {
  const rows = Array.from({ length: 64 }, (_, index) => ({
    ...subject(index + 1),
    autoRecord: false,
  }));
  const { archive } = memoryArchive(rows);
  const releases: ((value: PublicStatus) => void)[] = [];
  let held = true;
  const status = vi.fn(() =>
    held
      ? new Promise<PublicStatus>((resolve) => releases.push(resolve))
      : Promise.resolve('PUBLIC' as const),
  );
  const evidence = new StatusEvidence({
    provider: { status },
    publicConcurrency: 32,
    monitorConcurrency: 16,
  });
  const supervisor = createSupervisor({
    archive,
    evidence,
    statusConcurrency: 32,
    autoStart: false,
    provider: {
      status,
      importList: () => Promise.resolve([]),
      capture: () => Promise.reject(Error('unused capture')),
    },
  });
  const reconciling = supervisor.reconcile();
  try {
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(32));
    held = false;
    releases.forEach((release) => release('PUBLIC'));
    await reconciling;
    expect(status).toHaveBeenCalledTimes(64);
  } finally {
    const closing = supervisor.close();
    held = false;
    releases.forEach((release) => release('PUBLIC'));
    await Promise.allSettled([closing, reconciling]);
    await evidence.close();
  }
});
function segment(input: CommitInput): Segment {
  return {
    ...input,
    id: 'segment',
    mediaObjectId: 'fixture-object',
    initObjectId: null,
    wallEndMs: input.wallStartMs === null ? null : input.wallStartMs + input.durationSeconds * 1000,
  };
}
function memoryArchive(subjects: Subject[]): {
  archive: ArchivePort;
  commits: CommitInput[];
  observations: PublicStatus[];
} {
  const commits: CommitInput[] = [],
    observations: PublicStatus[] = [];
  const archive: ArchivePort = {
    async setGlobalRecording() {
      throw new Error('unused-fixture');
    },
    async prepareAccountSubjects() {
      throw new Error('unused-fixture');
    },
    async activateAccountSubjects() {
      throw new Error('unused-fixture');
    },
    async accountActivation() {
      return null;
    },
    async discardAccountPreparation() {
      throw new Error('unused-fixture');
    },
    async getSubject(id: string) {
      return (await this.listSubjects()).find((row) => row.id === id) ?? null;
    },

    async listSubjects() {
      return subjects.map((value) => ({ ...value }));
    },
    async setObservation(id, status, time) {
      const row = subjects.find((value) => value.id === id);
      if (row) {
        row.providerStatus = status;
        row.observedAtMs = time;
      }
      observations.push(status);
    },
    async setPolicy(id, patch) {
      const row = subjects.find((value) => value.id === id);
      if (!row) throw new Error('missing-fixture');
      Object.assign(row, patch);
      return { ...row };
    },
    async commit(input) {
      commits.push(input);
      return segment(input);
    },
    async upsertSubjects() {
      throw new Error('unused-fixture');
    },
    async timeline() {
      throw new Error('unused-fixture');
    },
    async statusHistory() {
      throw new Error('unused-fixture');
    },
    async events() {
      throw new Error('unused-fixture');
    },
    async eventMeta() {
      throw new Error('unused-fixture');
    },
    async ackEvents() {
      throw new Error('unused-fixture');
    },
    async startRun() {
      throw new Error('unused-fixture');
    },
    async heartbeatRun() {
      throw new Error('unused-fixture');
    },
    async stopRun() {
      throw new Error('unused-fixture');
    },
    async runHistory() {
      throw new Error('unused-fixture');
    },
    async locate() {
      throw new Error('unused-fixture');
    },
    async sourceCheckpoint() {
      return null;
    },
    async coverage() {
      throw new Error('unused-fixture');
    },
    async deleteUnlocated() {
      throw new Error('unused-fixture');
    },
    async setPolicies() {
      throw new Error('unused-fixture');
    },
    async pruneBefore() {
      throw new Error('unused-fixture');
    },
    async hasMedia() {
      return true;
    },
    async media() {
      return null;
    },
    async deleteRange() {
      throw new Error('unused-fixture');
    },
    async getSetting() {
      return null;
    },
    async setSetting() {
      throw new Error('unused-fixture');
    },
    async close() {
      /* no external resources */
    },
    async identity() {
      throw new Error('unused-fixture');
    },
    async personal() {
      throw new Error('unused-fixture');
    },
    async personalRevision() {
      return 0;
    },
    async removeFavorite() {
      throw new Error('unused-fixture');
    },
  };
  return { archive, commits, observations };
}
const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const untilAbort = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
};
const input: CommitInput = {
  subjectId: 'stripchat:1',
  sourceEpoch: 'fixture-source',
  sourceSequence: '1',
  init: null,
  bytes: new Uint8Array([1]),
  durationSeconds: 2,
  wallStartMs: null,
  timeBasis: 'unknown',
  uncertaintyMs: null,
  discontinuity: false,
};

describe('independent anonymous supervisor', () => {
  it('does not report CAPTURING until the first durable commit finishes', async () => {
    const { archive } = memoryArchive([subject()]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = archive.commit.bind(archive);
    archive.commit = async (value) => {
      await gate;
      return original(value);
    };
    const provider: ProviderPort = {
      importList: async () => [],
      status: async () => 'PUBLIC',
      capture: async (_row, sink, signal) => {
        await sink.commit(input);
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    try {
      await supervisor.reconcile();
      await tick();
      expect(supervisor.states()['stripchat:1']).toBe('RESOLVING');
      release();
      await tick();
      expect(supervisor.states()['stripchat:1']).toBe('CAPTURING');
    } finally {
      release();
      await supervisor.close();
    }
  });
  it('starts an explicitly enabled fresh PUBLIC target without waiting for an unrelated status sweep', async () => {
    const rows = [
      { ...subject(1), autoRecord: false, providerStatus: 'PUBLIC' as const, observedAtMs: 1000 },
      { ...subject(2), autoRecord: false },
    ];
    const { archive } = memoryArchive(rows);
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = vi.fn<ProviderPort['capture']>(async (_row, _sink, signal) =>
      untilAbort(signal),
    );
    const provider: ProviderPort = {
      importList: async () => [],
      status: async (id) => {
        if (id === 2) await slow;
        return 'PUBLIC';
      },
      capture,
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false, now: () => 1000 });
    const sweeping = supervisor.reconcile();
    try {
      await tick();
      await archive.setPolicy('stripchat:1', { autoRecord: true });
      await supervisor.requestRecording!(['stripchat:1']);
      await tick();
      expect(capture).toHaveBeenCalledOnce();
      expect(supervisor.states()['stripchat:1']).toBe('RESOLVING');
    } finally {
      release();
      await sweeping;
      await supervisor.close();
    }
  });
  it('keeps the candidate boundary when the previous display lease expires before confirmation', async () => {
    let clock = 1000;
    const rows = [{ ...subject(), autoRecord: false }];
    const { archive } = memoryArchive(rows);
    const observation = vi.spyOn(archive, 'setObservation');
    const status = vi
      .fn<ProviderPort['status']>()
      .mockResolvedValueOnce('PUBLIC')
      .mockImplementationOnce(async () => {
        clock = 2000;
        return 'OFFLINE';
      })
      .mockImplementationOnce(async () => {
        clock = 2400;
        return 'UNKNOWN';
      })
      .mockImplementationOnce(async () => {
        clock = 5000;
        return 'OFFLINE';
      });
    const supervisor = createSupervisor({
      archive,
      provider: {
        status,
        importList: async () => [],
        capture: async () => {
          throw new Error('unexpected-capture');
        },
      },
      now: () => clock,
      autoStart: false,
    });
    try {
      await supervisor.reconcile();
      await supervisor.reconcile();
      rows[0].providerStatus = 'UNKNOWN';
      await supervisor.reconcile();
      expect(observation.mock.calls.at(-1)).toEqual([
        'stripchat:1',
        'OFFLINE',
        5000,
        expect.any(Number),
        2000,
      ]);
    } finally {
      await supervisor.close();
    }
  });
  it('confirms a transition against the last known state after its fresh lease expires', async () => {
    const rows = [{ ...subject(), autoRecord: false, lastKnownStatus: 'PUBLIC' as const }];
    const { archive, observations } = memoryArchive(rows);
    const status = vi
      .fn<ProviderPort['status']>()
      .mockResolvedValueOnce('OFFLINE')
      .mockResolvedValue('PUBLIC');
    const supervisor = createSupervisor({
      archive,
      provider: { status, importList: async () => [], capture: async () => undefined },
      autoStart: false,
    });
    try {
      await supervisor.reconcile();
      expect(status).toHaveBeenCalledTimes(2);
      expect(observations).toEqual(['PUBLIC']);
    } finally {
      await supervisor.close();
    }
  });
  it.each([
    ['PUBLIC', 'PRIVATE'],
    ['PUBLIC', 'OFFLINE'],
    ['PRIVATE', 'PUBLIC'],
    ['PRIVATE', 'OFFLINE'],
    ['OFFLINE', 'PUBLIC'],
    ['OFFLINE', 'PRIVATE'],
  ] as const)('does not persist a one-off %s → %s → original transition', async (from, to) => {
    const { archive, observations } = memoryArchive([{ ...subject(), autoRecord: false }]);
    const status = vi
      .fn<ProviderPort['status']>()
      .mockResolvedValueOnce(from)
      .mockResolvedValueOnce(to)
      .mockResolvedValue(from);
    const supervisor = createSupervisor({
      archive,
      provider: {
        status,
        importList: async () => [],
        capture: async () => {
          throw new Error('unexpected-capture');
        },
      },
      autoStart: false,
    });
    try {
      await supervisor.reconcile();
      await supervisor.reconcile();
      expect(observations).toEqual([from, from]);
    } finally {
      await supervisor.close();
    }
  });
  it('retains the first candidate timestamp through an indeterminate confirmation without renewing known evidence', async () => {
    let clock = 1000;
    const { archive } = memoryArchive([{ ...subject(), autoRecord: false }]);
    const observation = vi.spyOn(archive, 'setObservation');
    const status = vi
      .fn<ProviderPort['status']>()
      .mockResolvedValueOnce('PUBLIC')
      .mockImplementationOnce(async () => {
        clock = 2000;
        return 'OFFLINE';
      })
      .mockImplementationOnce(async () => {
        clock = 2400;
        return 'UNKNOWN';
      })
      .mockImplementationOnce(async () => {
        clock = 5000;
        return 'OFFLINE';
      });
    const supervisor = createSupervisor({
      archive,
      provider: {
        status,
        importList: async () => [],
        capture: async () => {
          throw new Error('unexpected-capture');
        },
      },
      now: () => clock,
      autoStart: false,
    });
    try {
      await supervisor.reconcile();
      await supervisor.reconcile();
      expect(observation).toHaveBeenCalledTimes(1);
      await supervisor.reconcile();
      expect(observation.mock.calls.at(-1)).toEqual([
        'stripchat:1',
        'OFFLINE',
        5000,
        expect.any(Number),
        2000,
      ]);
    } finally {
      await supervisor.close();
    }
  });
  it('rejects a single false OFFLINE observation before writing history', async () => {
    const rows = [{ ...subject(), autoRecord: false }];
    const { archive, observations } = memoryArchive(rows);
    const status = vi
      .fn<ProviderPort['status']>()
      .mockResolvedValueOnce('PUBLIC')
      .mockResolvedValueOnce('OFFLINE')
      .mockResolvedValue('PUBLIC');
    const supervisor = createSupervisor({
      archive,
      provider: {
        status,
        importList: async () => [],
        capture: async () => {
          throw new Error('unexpected-capture');
        },
      },
      autoStart: false,
    });
    try {
      await supervisor.reconcile();
      await supervisor.reconcile();
      expect(observations).toEqual(['PUBLIC', 'PUBLIC']);
      expect(status).toHaveBeenCalledTimes(3);
    } finally {
      await supervisor.close();
    }
  });
  it('backdates a confirmed transition to its first valid response and retains confirmation freshness', async () => {
    let clock = 1000;
    const rows = [{ ...subject(), autoRecord: false }];
    const { archive } = memoryArchive(rows);
    const observation = vi.spyOn(archive, 'setObservation');
    const status = vi
      .fn<ProviderPort['status']>()
      .mockResolvedValueOnce('PUBLIC')
      .mockImplementationOnce(async () => {
        clock = 2000;
        return 'OFFLINE';
      })
      .mockImplementationOnce(async () => {
        clock = 2400;
        return 'OFFLINE';
      });
    const supervisor = createSupervisor({
      archive,
      provider: {
        status,
        importList: async () => [],
        capture: async () => {
          throw new Error('unexpected-capture');
        },
      },
      now: () => clock,
      autoStart: false,
    });
    try {
      await supervisor.reconcile();
      await supervisor.reconcile();
      expect(observation.mock.calls.at(-1)).toEqual([
        'stripchat:1',
        'OFFLINE',
        2400,
        expect.any(Number),
        2000,
      ]);
    } finally {
      await supervisor.close();
    }
  });
  it('rotates through followed subjects even when active captures consume each polling budget', async () => {
    let now = 2000000000000;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const subjects = Array.from({ length: 9 }, (_, index) => ({
      ...subject(index + 1),
      autoRecord: index < 8,
      providerStatus: index < 8 ? ('PUBLIC' as const) : ('UNKNOWN' as const),
      observedAtMs: index < 8 ? now : null,
    }));
    const { archive } = memoryArchive(subjects);
    const observed = new Set<number>();
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status(id) {
        observed.add(id);
        // One admitted observation consumes a sweep; fairness must span sweeps.
        now += 1001;
        return 'PUBLIC';
      },
      async capture(_subject, _sink, signal) {
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, pollMs: 1000, autoStart: false });
    try {
      await supervisor.requestRecording!(subjects.slice(0, 8).map((row) => row.id));
      for (let sweep = 0; sweep < 18; sweep++) await supervisor.reconcile();
      expect(observed.size).toBe(9);
      expect(
        Object.values(supervisor.states()).filter((state) => state === 'RESOLVING'),
      ).toHaveLength(8);
    } finally {
      await supervisor.close();
      time.mockRestore();
    }
  });
  it('keeps healthy 203-subject rotations continuous without exceeding eight actual requests', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const subjects = Array.from({ length: 203 }, (_, i) => ({
      ...subject(i + 1),
      autoRecord: false,
    }));
    const { archive, observations } = memoryArchive(subjects),
      expires = new Map<string, number>();
    const original = archive.setObservation;
    let gaps = 0,
      active = 0,
      maximum = 0,
      count = 0;
    archive.setObservation = async (id, status, at, lease) => {
      if (expires.has(id) && at > expires.get(id)!) gaps++;
      expires.set(id, at + lease!);
      count++;
      await original(id, status, at, lease);
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 600));
        active--;
        return 'OFFLINE';
      },
      async capture() {
        throw new Error('offline');
      },
    };
    const supervisor = createSupervisor({ archive, provider });
    try {
      await vi.advanceTimersByTimeAsync(90000);
      expect(expires.size).toBe(203);
      expect(count).toBeGreaterThan(600);
      expect(gaps).toBe(0);
      expect(observations.every((status) => status === 'OFFLINE')).toBe(true);
      expect(maximum).toBe(8);
    } finally {
      const closing = supervisor.close();
      await vi.advanceTimersByTimeAsync(1000);
      await closing;
      vi.useRealTimers();
    }
  });
  it('gives requests admitted near a sweep boundary a complete timeout instead of inventing UNKNOWN', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { archive, observations } = memoryArchive(
      Array.from({ length: 20 }, (_, i) => ({ ...subject(i + 1), autoRecord: false })),
    );
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status(id) {
        await new Promise((resolve) => setTimeout(resolve, id <= 8 ? 4900 : 300));
        return 'OFFLINE';
      },
      async capture() {
        throw new Error('offline');
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    try {
      const pending = supervisor.reconcile();
      await vi.advanceTimersByTimeAsync(5300);
      await pending;
      expect(observations).toHaveLength(16);
      expect(observations.every((status) => status === 'OFFLINE')).toBe(true);
    } finally {
      await supervisor.close();
      vi.useRealTimers();
    }
  });
  it('retains a finite last-known state on a failed observation without renewing it or delaying PRIVATE', async () => {
    const rows = [subject()],
      { archive, observations } = memoryArchive(rows);
    let status: PublicStatus = 'PUBLIC',
      clock = 1000,
      current: AbortSignal | undefined;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return status;
      },
      async capture(_row, _sink, signal) {
        current = signal;
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false, now: () => clock });
    try {
      await supervisor.reconcile();
      status = 'UNKNOWN';
      clock = 2000;
      await supervisor.reconcile();
      expect(rows[0].providerStatus).toBe('PUBLIC');
      expect(rows[0].observedAtMs).toBe(1000);
      expect(observations).toEqual(['PUBLIC']);
      status = 'PRIVATE';
      await supervisor.reconcile();
      expect(current?.aborted).toBe(true);
      expect(observations).toEqual(['PUBLIC', 'PRIVATE']);
    } finally {
      await supervisor.close();
    }
  });
  it('refreshes anonymous observations every five seconds while the same recording keeps running', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { archive, observations } = memoryArchive([subject()]);
    let captures = 0;
    const provider: ProviderPort = {
      async importList() {
        throw new Error('no-account');
      },
      async status() {
        return 'PUBLIC';
      },
      async capture(_row, _sink, signal) {
        captures++;
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(observations).toEqual(['PUBLIC']);
      expect(captures).toBe(1);
      await vi.advanceTimersByTimeAsync(10000);
      expect(observations).toEqual(['PUBLIC', 'PUBLIC', 'PUBLIC']);
      expect(captures).toBe(1);
    } finally {
      await supervisor.close();
      vi.useRealTimers();
    }
  });
  it('expires capture evidence independently of a hung status, ignores its late success, and drains it on close', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { archive, observations } = memoryArchive([subject()]);
    let polls = 0,
      release: ((status: PublicStatus) => void) | undefined,
      current: AbortSignal | undefined;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      status: () =>
        ++polls === 1
          ? Promise.resolve('PUBLIC')
          : new Promise((resolve) => {
              release = resolve;
            }),
      async capture(_row, _sink, signal) {
        current = signal;
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, statusTimeoutMs: 1000 });
    try {
      await vi.advanceTimersByTimeAsync(16000);
      expect(current?.aborted).toBe(true);
      expect(polls).toBe(2);
      expect(observations).toEqual(['PUBLIC']);
      let closed = false;
      const closing = supervisor.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release?.('PUBLIC');
      await closing;
      expect(observations).toEqual(['PUBLIC']);
    } finally {
      release?.('PUBLIC');
      await supervisor.close();
      vi.useRealTimers();
    }
  });
  it('retains all eight actual status slots after deadline and cannot fan out replacements', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { archive } = memoryArchive(Array.from({ length: 20 }, (_, i) => subject(i + 1))),
      releases: ((status: PublicStatus) => void)[] = [];
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      status: () => new Promise((resolve) => releases.push(resolve)),
      async capture() {
        throw new Error('unknown-capture');
      },
    };
    const supervisor = createSupervisor({
      archive,
      provider,
      autoStart: false,
      statusTimeoutMs: 10,
    });
    try {
      const first = supervisor.reconcile();
      await vi.advanceTimersByTimeAsync(10);
      await first;
      expect(releases).toHaveLength(8);
      await supervisor.reconcile();
      expect(releases).toHaveLength(8);
    } finally {
      for (const release of releases) release('OFFLINE');
      await supervisor.close();
      vi.useRealTimers();
    }
  });
  it('observes later subjects without waiting for a slow first batch member', async () => {
    const { archive } = memoryArchive(Array.from({ length: 12 }, (_, i) => subject(i + 1)));
    const visited: number[] = [];
    let release: ((status: PublicStatus) => void) | undefined;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      status: (id) => {
        visited.push(id);
        return id === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve('OFFLINE');
      },
      async capture() {
        throw new Error('offline-capture');
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    try {
      const cycle = supervisor.reconcile();
      await tick();
      expect(visited).toContain(12);
      release?.('OFFLINE');
      await cycle;
    } finally {
      release?.('OFFLINE');
      await supervisor.close();
    }
  });
  it('starts every eligible local subject without importing an account or imposing a recording count cap', async () => {
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    const { archive } = memoryArchive(ids.map((id) => subject(id))),
      started: number[] = [];
    const provider: ProviderPort = {
      async importList() {
        throw new Error('account-must-not-be-called');
      },
      async status() {
        return 'PUBLIC';
      },
      async capture(row, sink, signal) {
        started.push(row.providerId);
        await sink.commit({ ...input, subjectId: row.id });
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    await supervisor.reconcile();
    await tick();
    expect(started).toEqual(ids);
    expect(supervisor.states()).toEqual(
      Object.fromEntries(ids.map((id) => [`stripchat:${id}`, 'CAPTURING'])),
    );
    await supervisor.close();
  });
  it('stops a running generation immediately upon PRIVATE observation and leaves local targets intact', async () => {
    const subjects = [subject()],
      { archive, observations } = memoryArchive(subjects);
    let status: PublicStatus = 'PUBLIC',
      signal: AbortSignal | undefined;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return status;
      },
      async capture(_row, _sink, current) {
        signal = current;
        await untilAbort(current);
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    await supervisor.reconcile();
    await tick();
    status = 'PRIVATE';
    await supervisor.reconcile();
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(observations).toEqual(['PUBLIC', 'PRIVATE']);
    expect(subjects).toHaveLength(1);
    expect(supervisor.states()['stripchat:1']).toBe('IDLE');
    await supervisor.close();
  });
  it('rechecks policies after in-flight status so a late response cannot start disabled capture', async () => {
    const subjects = [subject()],
      { archive } = memoryArchive(subjects);
    let resolveStatus: ((value: PublicStatus) => void) | undefined,
      captures = 0;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      status: () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      async capture() {
        captures++;
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    const cycle = supervisor.reconcile();
    await tick();
    subjects[0].autoRecord = false;
    resolveStatus?.('PUBLIC');
    await cycle;
    await tick();
    expect(captures).toBe(0);
    expect(supervisor.states()['stripchat:1']).toBe('IDLE');
    await supervisor.close();
  });
  it('holds a draining slot, rejects stale commits, and cannot let an old run delete its replacement', async () => {
    const subjects = [subject()],
      { archive, commits } = memoryArchive(subjects);
    let release: (() => void) | undefined,
      oldSink: CaptureSink | undefined,
      captures = 0;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return 'PUBLIC';
      },
      async capture(_row, sink, signal) {
        captures++;
        if (captures === 1) {
          oldSink = sink;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        } else await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    await supervisor.reconcile();
    await tick();
    subjects[0].monitorEnabled = false;
    await supervisor.reconcile();
    subjects[0].monitorEnabled = true;
    await supervisor.reconcile();
    await tick();
    expect(captures).toBe(1);
    expect(supervisor.states()['stripchat:1']).toBe('STOPPING');
    await expect(oldSink?.commit(input)).rejects.toThrow('capture-generation-cancelled');
    expect(commits).toHaveLength(0);
    release?.();
    await tick();
    await supervisor.reconcile();
    await tick();
    expect(captures).toBe(2);
    expect(supervisor.states()['stripchat:1']).toBe('RESOLVING');
    await supervisor.close();
  });
  it('releases failed slots and starts an older waiting target before retrying the failed one', async () => {
    const { archive } = memoryArchive([subject(1), subject(2)]),
      started: number[] = [];
    let clock = 0;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return 'PUBLIC';
      },
      async capture(row, _sink, signal) {
        started.push(row.providerId);
        if (row.providerId === 1) throw new Error('synthetic-network');
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({
      archive,
      provider,
      autoStart: false,
      backoffMs: 10,
      now: () => clock,
    });
    await supervisor.reconcile();
    await tick();
    clock = 20;
    await supervisor.reconcile();
    await tick();
    expect(started).toEqual([1, 2, 1]);
    expect(supervisor.states()['stripchat:1']).toBe('BACKOFF');
    await supervisor.close();
  });

  it('coalesces reconcile and aborts/drains a slow status request on close', async () => {
    const { archive } = memoryArchive([subject()]);
    let aborted = false;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status(_id, signal) {
        if (!signal) throw new Error('missing-signal');
        await untilAbort(signal);
        aborted = true;
        throw new Error('cancelled');
      },
      async capture() {
        throw new Error('must-not-start');
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    const first = supervisor.reconcile(),
      second = supervisor.reconcile();
    await tick();
    const closing = supervisor.close();
    expect(supervisor.close()).toBe(closing);
    await closing;
    await Promise.all([first, second]);
    expect(aborted).toBe(true);
  });
  it('revokes policy during an already pending slow poll without waiting for its response', async () => {
    const subjects = [subject()],
      { archive } = memoryArchive(subjects);
    let slow = false,
      signal: AbortSignal | undefined,
      finishStatus: ((status: PublicStatus) => void) | undefined;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      status: () =>
        slow
          ? new Promise((resolve) => {
              finishStatus = resolve;
            })
          : Promise.resolve('PUBLIC'),
      async capture(_row, _sink, current) {
        signal = current;
        await untilAbort(current);
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    await supervisor.reconcile();
    await tick();
    slow = true;
    const polling = supervisor.reconcile();
    await tick();
    subjects[0].autoRecord = false;
    const policyChange = supervisor.reconcile();
    await tick();
    expect(signal?.aborted).toBe(true);
    finishStatus?.('PUBLIC');
    await Promise.all([polling, policyChange]);
    expect(supervisor.states()['stripchat:1']).toBe('IDLE');
    await supervisor.close();
  });
  it('survives 100 stop/start cycles without overlapping generations', async () => {
    const subjects = [subject()],
      { archive } = memoryArchive(subjects);
    let active = 0,
      maxActive = 0,
      started = 0;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return 'PUBLIC';
      },
      async capture(_row, _sink, signal) {
        active++;
        started++;
        maxActive = Math.max(maxActive, active);
        await untilAbort(signal);
        active--;
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false });
    for (let count = 0; count < 100; count++) {
      subjects[0].monitorEnabled = true;
      await supervisor.reconcile();
      await tick();
      subjects[0].monitorEnabled = false;
      await supervisor.reconcile();
      await tick();
    }
    await supervisor.close();
    expect(started).toBe(100);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });
  it('defaults to self-scheduled polling without account setup', async () => {
    const { archive } = memoryArchive([subject()]);
    let observed: (() => void) | undefined;
    const observation = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const provider: ProviderPort = {
      async importList() {
        throw new Error('no-account');
      },
      async status() {
        observed?.();
        return 'OFFLINE';
      },
      async capture() {
        throw new Error('offline');
      },
    };
    const supervisor = createSupervisor({ archive, provider, pollMs: 1000 });
    await observation;
    await supervisor.close();
  });
  it('keeps active recordings through mixed-speed 204-subject rotations on the shared clock', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const { archive } = memoryArchive(Array.from({ length: 204 }, (_, i) => subject(i + 1)));
    const clock = new SyncClock({ intervalMs: () => 5000 });
    const launches = new Map<string, number>();
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status(id) {
        await new Promise((resolve) => setTimeout(resolve, id <= 40 ? 2500 : 10));
        return id <= 40 ? 'PUBLIC' : 'OFFLINE';
      },
      async capture(row, _sink, signal) {
        launches.set(row.id, (launches.get(row.id) ?? 0) + 1);
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, clock });
    try {
      await vi.advanceTimersByTimeAsync(180000);
      expect(launches.size).toBe(40);
      expect([...launches.values()].every((count) => count === 1)).toBe(true);
    } finally {
      const closing = supervisor.close();
      await vi.advanceTimersByTimeAsync(5000);
      await closing;
      await clock.close();
      vi.useRealTimers();
    }
  });
  it('does not shorten an issued capture lease when fast observations reduce the latency estimate', async () => {
    const rows = Array.from({ length: 204 }, (_, index) => subject(index + 1));
    const { archive } = memoryArchive(rows);
    let clock = 0,
      current: AbortSignal | undefined,
      launches = 0;
    let status: PublicStatus = 'PUBLIC';
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status(id) {
        return id === 1 ? status : 'OFFLINE';
      },
      async capture(_row, _sink, signal) {
        launches++;
        current = signal;
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({ archive, provider, autoStart: false, now: () => clock });
    try {
      await supervisor.reconcile();
      await tick();
      const first = current;
      expect(first?.aborted).toBe(false);
      clock = 16000;
      await supervisor.reconcile();
      await tick();
      expect(first?.aborted).toBe(false);
      expect(launches).toBe(1);
      // Even a fresh PUBLIC with a smaller new estimate cannot move an already
      // issued deadline backwards, nor can UNKNOWN extend the original lease.
      status = 'UNKNOWN';
      clock = 40000;
      await supervisor.reconcile();
      expect(first?.aborted).toBe(false);
      clock = 79000;
      await supervisor.reconcile();
      expect(first?.aborted).toBe(true);
    } finally {
      await supervisor.close();
    }
  });
  it('keeps a brief UNKNOWN within its public evidence lease, then revokes expired evidence', async () => {
    const { archive } = memoryArchive([subject()]);
    let status: PublicStatus = 'PUBLIC',
      clock = 0,
      current: AbortSignal | undefined;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return status;
      },
      async capture(_row, _sink, signal) {
        current = signal;
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({
      archive,
      provider,
      autoStart: false,
      now: () => clock,
      unknownLeaseMs: 100,
    });
    await supervisor.reconcile();
    await tick();
    status = 'UNKNOWN';
    clock = 50;
    await supervisor.reconcile();
    expect(current?.aborted).toBe(false);
    clock = 101;
    await supervisor.reconcile();
    expect(current?.aborted).toBe(true);
    await supervisor.close();
  });
  it('requires offline confirmations and a recovery window but never delays PRIVATE', async () => {
    const { archive } = memoryArchive([subject()]);
    let status: PublicStatus = 'PUBLIC',
      clock = 0,
      current: AbortSignal | undefined;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return status;
      },
      async capture(_row, _sink, signal) {
        current = signal;
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({
      archive,
      provider,
      autoStart: false,
      now: () => clock,
      offlineConfirmations: 2,
      recoveryWindowMs: 100,
    });
    await supervisor.reconcile();
    await tick();
    status = 'OFFLINE';
    clock = 10;
    await supervisor.reconcile();
    clock = 50;
    await supervisor.reconcile();
    expect(current?.aborted).toBe(false);
    status = 'PRIVATE';
    await supervisor.reconcile();
    expect(current?.aborted).toBe(true);
    await supervisor.close();
  });
  it('starts all eligible recordings but immediately revokes recording when the storage gate closes', async () => {
    const { archive } = memoryArchive([subject(1), subject(2)]);
    let allowed = true,
      active = 0;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return 'PUBLIC';
      },
      async capture(_row, _sink, signal) {
        active++;
        await untilAbort(signal);
        active--;
      },
    };
    const supervisor = createSupervisor({
      archive,
      provider,
      autoStart: false,
      runtime: () => ({ pollMs: 10 }),
      canRecord: () => allowed,
    });
    await supervisor.reconcile();
    await tick();
    expect(active).toBe(2);
    allowed = false;
    await supervisor.reconcile();
    await tick();
    expect(active).toBe(0);
    await supervisor.close();
  });
  it('reports only safe capture errors and clears them on the next successful commit', async () => {
    const { archive } = memoryArchive([subject()]);
    let broken = true;
    const provider: ProviderPort = {
      async importList() {
        return [];
      },
      async status() {
        return 'PUBLIC';
      },
      async capture(_row, sink, signal) {
        if (broken) throw new Error('sensitive-url-cookie');
        await sink.commit(input);
        await untilAbort(signal);
      },
    };
    const supervisor = createSupervisor({
      archive,
      provider,
      autoStart: false,
      backoffMs: 0,
      now: () => 1234,
    });
    await supervisor.reconcile();
    await tick();
    expect(supervisor.diagnostics?.()['stripchat:1']).toEqual({
      error: 'capture-failed',
      lastSuccessMs: null,
    });
    broken = false;
    await supervisor.reconcile();
    await tick();
    expect(supervisor.diagnostics?.()['stripchat:1']).toEqual({ error: null, lastSuccessMs: 1234 });
    await supervisor.close();
  });
});
