import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { superviseApplication } from './processes.js';

function fixture() {
  const child = new EventEmitter() as { -readonly [Key in keyof ChildProcess]: ChildProcess[Key] };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  let finish!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const database = {
    exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finish = resolve;
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  const signals = new EventEmitter();
  return {
    child,
    database,
    signals,
    finish,
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('keeps PostgreSQL alive while the application drains and ignores repeated signals', async () => {
  const f = fixture(),
    work = superviseApplication(f.child, f.database, { signals: f.signals });
  f.signals.emit('SIGTERM');
  f.signals.emit('SIGTERM');
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(f.database.close).not.toHaveBeenCalled();
  f.exit(0);
  expect(await work).toBe(0);
  expect(f.database.close).toHaveBeenCalledOnce();
  expect(f.signals.listenerCount('SIGTERM')).toBe(0);
});
it('stops the application and fails if PostgreSQL exits unexpectedly', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = fixture(),
    work = superviseApplication(f.child, f.database, { signals: f.signals });
  f.finish({ code: 1, signal: null });
  await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'));
  f.exit(0);
  expect(await work).toBe(1);
});
it('closes PostgreSQL after an application failure', async () => {
  const f = fixture(),
    work = superviseApplication(f.child, f.database, { signals: f.signals });
  f.exit(12);
  expect(await work).toBe(12);
  expect(f.database.close).toHaveBeenCalledOnce();
});
it('forces a bounded shutdown when the application does not drain', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = fixture(),
    work = superviseApplication(f.child, f.database, { signals: f.signals, stopTimeoutMs: 100 });
  f.signals.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(100);
  expect(f.child.kill).toHaveBeenLastCalledWith('SIGKILL');
  f.exit(null, 'SIGKILL');
  expect(await work).toBe(1);
});
it('shortens an existing drain if PostgreSQL becomes unavailable during shutdown', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = fixture(),
    work = superviseApplication(f.child, f.database, {
      signals: f.signals,
      stopTimeoutMs: 1000,
      databaseFailureTimeoutMs: 100,
    });
  f.signals.emit('SIGTERM');
  f.finish({ code: 1, signal: null });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.child.kill).toHaveBeenCalledTimes(2);
  expect(f.child.kill).toHaveBeenLastCalledWith('SIGKILL');
  f.exit(null, 'SIGKILL');
  expect(await work).toBe(1);
});
it('closes PostgreSQL if spawning the application fails', async () => {
  const f = fixture(),
    work = superviseApplication(f.child, f.database, { signals: f.signals });
  const failed = expect(work).rejects.toThrow('SPAWN_TEST');
  f.child.emit('error', Error('SPAWN_TEST'));
  await failed;
  expect(f.database.close).toHaveBeenCalledOnce();
});
