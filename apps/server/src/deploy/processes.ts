import type { ChildProcess } from 'node:child_process';

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
interface DatabaseProcess {
  exited: Promise<Exit>;
  close: () => Promise<void>;
}
interface Signals {
  on: (event: 'SIGTERM' | 'SIGINT', listener: () => void) => unknown;
  off: (event: 'SIGTERM' | 'SIGINT', listener: () => void) => unknown;
}
/** Application drains first; its database stays alive until that drain completes. */
export async function superviseApplication(
  child: ChildProcess,
  database: DatabaseProcess,
  options: { signals?: Signals; stopTimeoutMs?: number; databaseFailureTimeoutMs?: number } = {},
): Promise<number> {
  const signals = options.signals ?? process;
  let stopRequested = false,
    timedOut = false,
    deadline = Infinity,
    timer: ReturnType<typeof setTimeout> | undefined;
  const requestStop = (timeout: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!stopRequested) {
      stopRequested = true;
      child.kill('SIGTERM');
    }
    const nextDeadline = Date.now() + timeout;
    if (nextDeadline >= deadline) return;
    deadline = nextDeadline;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      console.error('application_shutdown_timeout');
      child.kill('SIGKILL');
    }, timeout);
    timer.unref();
  };
  const stop = () => requestStop(options.stopTimeoutMs ?? 55000);
  const application = new Promise<
    { kind: 'application'; exit: Exit } | { kind: 'application-error'; error: Error }
  >((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ kind: 'application', exit: { code: child.exitCode, signal: child.signalCode } });
      return;
    }
    child.once('exit', (code, signal) => resolve({ kind: 'application', exit: { code, signal } }));
    child.once('error', (error) => resolve({ kind: 'application-error', error }));
  });
  const postgres = database.exited.then(
    (exit) => ({ kind: 'database' as const, exit }),
    (error: unknown) => ({ kind: 'database-error' as const, error }),
  );
  signals.on('SIGTERM', stop);
  signals.on('SIGINT', stop);
  let failure: unknown;
  try {
    const first = await Promise.race([application, postgres]);
    if (first.kind === 'database' || first.kind === 'database-error') {
      console.error(
        'embedded_database_exited',
        first.kind === 'database' ? first.exit : first.error,
      );
      requestStop(options.databaseFailureTimeoutMs ?? 5000);
      await application;
      return 1;
    }
    if (first.kind === 'application-error') throw first.error;
    return timedOut ? 1 : (first.exit.code ?? 1);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signals.off('SIGTERM', stop);
    signals.off('SIGINT', stop);
    clearTimeout(timer);
    try {
      await database.close();
    } catch (error) {
      if (failure)
        throw new AggregateError([failure, error], 'APPLICATION_AND_DATABASE_SHUTDOWN_FAILED');
      throw error;
    }
  }
}
