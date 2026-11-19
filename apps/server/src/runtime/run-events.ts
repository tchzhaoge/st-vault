import type { ArchivePort } from '../ports.js';
import type { SyncClock } from './sync-clock.js';
import type { BackgroundTask } from '@st-vault/api-schema';
/** Keep signal handling safe even when the durable startup write is still pending. */
export function createRunEvents(
  archive: Pick<ArchivePort, 'startRun' | 'heartbeatRun' | 'stopRun'>,
  onError: () => void = () => undefined,
  clock?: SyncClock,
) {
  let runId: string | undefined,
    starting: Promise<boolean> | undefined,
    beat: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false,
    finished: Promise<void> | undefined;
  let detachClock: (() => void) | undefined;
  let lastAttemptMs: number | null = null,
    lastSuccessMs: number | null = null,
    heartbeatFailed = false;
  const pause = async (): Promise<void> => {
    stopping = true;
    detachClock?.();
    if (timer) clearInterval(timer);
    timer = undefined;
    await starting;
    await beat;
  };
  return {
    start(): Promise<boolean> {
      if (stopping) return Promise.resolve(false);
      starting ??= archive.startRun().then((id) => {
        runId = id;
        if (!stopping) {
          const heartbeat = (): Promise<void> => {
            if (!beat) lastAttemptMs = Date.now();
            beat ??= archive
              .heartbeatRun(id)
              .then(
                () => {
                  lastSuccessMs = Date.now();
                  heartbeatFailed = false;
                },
                () => {
                  heartbeatFailed = true;
                  onError();
                },
              )
              .finally(() => {
                beat = undefined;
              });
            return beat;
          };
          if (clock) detachClock = clock.subscribe('run-heartbeat', heartbeat);
          else {
            timer = setInterval(() => void heartbeat(), 5000);
            timer.unref();
          }
        }
        return !stopping;
      });
      return starting;
    },
    pause,
    backgroundTask(): BackgroundTask {
      return {
        id: 'run-heartbeat',
        group: 'protection',
        state: stopping
          ? 'paused'
          : beat
            ? 'running'
            : heartbeatFailed
              ? 'retrying'
              : runId
                ? 'waiting'
                : 'idle',
        lastRunAtMs: lastAttemptMs,
        lastSuccessAtMs: lastSuccessMs,
        error: heartbeatFailed ? 'run_heartbeat_failed' : null,
      };
    },
    finish(outcome: 'normal' | 'abnormal'): Promise<void> {
      finished ??= pause().then(async () => {
        if (runId) await archive.stopRun(runId, outcome);
      });
      return finished;
    },
  };
}
