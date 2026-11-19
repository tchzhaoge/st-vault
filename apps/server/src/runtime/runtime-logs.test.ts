import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { boundedLogMirror, createRuntimeLog, redactLog } from './runtime-logs.js';

it('reopens persistence after a recoverable path failure without blocking producers or flooding retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-log-recovery-'));
  const directory = path.join(root, 'logs');
  const mirrored: string[] = [];
  let now = 10000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await writeFile(directory, 'temporarily not a directory');
    const log = createRuntimeLog({ directory, role: 'app', mirror: (line) => mirrored.push(line) });
    log.write('{"event":"before-failure"}\n');
    await vi.waitFor(() => expect(mirrored.join('')).toContain('log_persistence_failed'));
    for (let n = 0; n < 100; n++) log.write('{"event":"during-failure"}\n');
    expect(mirrored.filter((line) => line.includes('log_persistence_failed'))).toHaveLength(1);
    expect(log.writableLength).toBe(0);
    now += 1000;
    log.write('{"event":"retry-still-broken"}\n');
    await vi.waitFor(() =>
      expect(mirrored.filter((line) => line.includes('log_persistence_failed'))).toHaveLength(2),
    );
    await rm(directory);
    await mkdir(directory);
    now += 1000;
    log.write('{"event":"backoff-not-yet-due"}\n');
    expect(mirrored.filter((line) => line.includes('log_persistence_failed'))).toHaveLength(2);
    now += 1000;
    log.write('{"event":"after-repair"}\n');
    log.end();
    await once(log, 'finish');
    const persisted = await readFile(path.join(directory, 'app.jsonl'), 'utf8');
    expect(persisted).toContain('after-repair');
    expect(persisted).toContain('log_persistence_recovered');
    expect(persisted).toContain('"failures":2,"dropped":103');
    expect(mirrored.join('')).toContain('log_persistence_recovered');
  } finally {
    clock.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds burst admission independently of callers respecting Writable backpressure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stv-log-budget-'));
  const mirrored: string[] = [];
  try {
    const log = createRuntimeLog({
      directory,
      role: 'app',
      maxQueuedBytes: 4096,
      mirror: (line) => {
        mirrored.push(line);
      },
    });
    for (let n = 0; n < 2000; n++)
      log.write(JSON.stringify({ event: 'burst', n, message: 'x'.repeat(1024) }) + '\n');
    log.write(
      JSON.stringify({
        event: 'critical-after-burst',
        level: 'error',
        message: 'preserve diagnostic',
      }) + '\n',
    );
    expect(log.writableLength).toBeLessThanOrEqual(4096);
    log.end();
    await once(log, 'finish');
    const records = (await readFile(path.join(directory, 'app.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; dropped?: number });
    const overflow = records.filter((record) => record.event === 'log_queue_overflow');
    expect(overflow.reduce((sum, record) => sum + (record.dropped ?? 0), 0)).toBeGreaterThan(0);
    expect(records.filter((record) => record.event === 'burst').length).toBeLessThanOrEqual(4);
    expect(
      overflow.reduce((sum, record) => sum + (record.dropped ?? 0), 0) +
        records.filter((record) => record.event === 'burst').length,
    ).toBe(2000);
    expect(mirrored.some((line) => line.includes('log_queue_overflow'))).toBe(true);
    expect(records.some((record) => record.event === 'critical-after-burst')).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('bounds a stalled stdout pipe and reports dropped records after one drain subscription', () => {
  let bytes = 0;
  const records: string[] = [];
  const drains: (() => void)[] = [];
  const mirror = boundedLogMirror(
    (line) => {
      records.push(line);
      bytes += Buffer.byteLength(line);
      return false;
    },
    () => bytes,
    (listener) => {
      drains.push(listener);
    },
    1024,
  );
  for (let n = 0; n < 1000; n++) mirror('x'.repeat(200));
  expect(bytes).toBeLessThanOrEqual(1024);
  expect(drains).toHaveLength(1);
  bytes = 0;
  drains[0]();
  expect(records.at(-1)).toContain('log_stdout_overflow');
  expect(JSON.parse(records.at(-1)!) as { dropped: number }).toMatchObject({ dropped: 995 });
});
it('redacts secrets and signed addresses without losing diagnostic codes', () => {
  const result = JSON.stringify(
    redactLog({
      cookie: 'private-cookie',
      password: 'private-password',
      otp: '123456',
      verificationCode: '654321',
      captcha: 'private-challenge',
      snapshotPages: 45,
      pin: '012345',
      confirmPin: '012345',
      stv_setup: 'private-setup',
      spinning: true,
      keyCount: 2,
      code: 'upstream-http',
      url: 'https://cdn.example/private/path?token=private-token',
      error: new Error('request https://cdn.example/secret?sig=x'),
    }),
  );
  expect(result).not.toMatch(
    /012345|private-setup|123456|654321|private-challenge|private-cookie|private-password|private-token|\/private\/path|sig=x/,
  );
  expect(result).toContain('upstream-http');
  expect(result).toContain('keyCount');
  expect(result).toContain('"snapshotPages":45');
  expect(result).toContain('"spinning":true');
});
it('preserves individual service-drain failures while redacting their secrets', () => {
  const result = JSON.stringify(
    redactLog(
      new AggregateError(
        [
          new Error('first-close-failed'),
          new Error('fetch https://cdn.example/x?token=private-token'),
        ],
        'SERVICE_DRAIN_FAILED',
      ),
    ),
  );
  expect(result).toContain('first-close-failed');
  expect(result).not.toContain('private-token');
});
it('persists ordered JSON lines and bounds rotation without discarding current diagnostics', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stv-logs-'));
  try {
    const log = createRuntimeLog({
      directory,
      role: 'app',
      maxBytes: 800,
      maxFiles: 3,
      mirror: () => undefined,
    });
    for (let n = 0; n < 20; n++)
      log.write(JSON.stringify({ event: 'test', n, secret: 'hidden' }) + '\n');
    log.end();
    await once(log, 'finish');
    const names = await readdir(directory);
    expect(names.length).toBeLessThanOrEqual(3);
    const records = (await readFile(path.join(directory, 'app.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { n: number; at: string; role: string });
    expect(records.at(-1)?.n).toBe(19);
    expect(records.every((record) => record.role === 'app' && record.at)).toBe(true);
    expect(await readFile(path.join(directory, 'app.jsonl'), 'utf8')).not.toContain('hidden');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
