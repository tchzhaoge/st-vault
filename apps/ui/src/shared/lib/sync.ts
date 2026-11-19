import { useEffect, useRef } from 'react';
import { DisplayClock } from './display-clock';
import { ApiError, ReadRetryError } from './api';
export type SyncTopic =
  | 'subjects'
  | 'timeline'
  | 'events'
  | 'account'
  | 'keys'
  | 'system'
  | 'personal'
  | 'playback'
  | 'seen';
export type SyncReadOutcome = { status: 'retry'; notBeforeMs: number } | { status: 'stop' };
export type SyncReadResult = void | SyncReadOutcome;
export function syncReadFailure(error: unknown, signal?: AbortSignal): SyncReadOutcome {
  if (signal?.aborted && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'))
    return { status: 'stop' };
  if (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 429].includes(error.status)
  )
    return { status: 'stop' };
  return {
    status: 'retry',
    notBeforeMs:
      error instanceof ApiError || error instanceof ReadRetryError ? error.notBeforeMs : 0,
  };
}
const TOPICS: SyncTopic[] = [
  'seen',
  'subjects',
  'timeline',
  'events',
  'account',
  'keys',
  'system',
  'personal',
  'playback',
];
let connected = false;
const EVENT = 'stv-sync';
const CLOCK = 'stv-clock';
const DISPLAY_CLOCK = 'stv-display-clock';
let intervalMs = 5000;
let pageClock: DisplayClock | null = null;
export const getSyncIntervalMs = (): number => intervalMs;
export const getPageTimeMs = (): number => pageClock?.now() ?? Date.now();
function publishClock(atMs: number, compensate = false): void {
  window.dispatchEvent(new CustomEvent(CLOCK, { detail: atMs }));
  if (compensate) window.dispatchEvent(new CustomEvent(EVENT, { detail: TOPICS }));
}
function useClock(callback: (nowMs: number) => void, enabled: boolean, display: boolean): void {
  const current = useRef(callback);
  current.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const notice = (event: Event): void => {
      if (document.visibilityState === 'visible')
        current.current((event as CustomEvent<number>).detail);
    };
    window.addEventListener(CLOCK, notice);
    if (display) window.addEventListener(DISPLAY_CLOCK, notice);
    return () => {
      window.removeEventListener(CLOCK, notice);
      if (display) window.removeEventListener(DISPLAY_CLOCK, notice);
    };
  }, [enabled, display]);
}
export function useSyncClock(callback: (nowMs: number) => void, enabled = true): void {
  useClock(callback, enabled, false);
}
export function useDisplayClock(callback: (nowMs: number) => void, enabled = true): void {
  useClock(callback, enabled, true);
}
export function usePageSync(enabled: boolean, configuredMs = 5000): void {
  useEffect(() => {
    if (!enabled) return;
    intervalMs = configuredMs;
    const displayClock = new DisplayClock(Date.now());
    pageClock = displayClock;
    const display = (): void => {
      const at = displayClock.sample();
      if (at !== null) window.dispatchEvent(new CustomEvent(DISPLAY_CLOCK, { detail: at }));
    };
    let lastClock = Date.now(),
      lastPulse = 0;
    let source: EventSource | null = null,
      retry: number | undefined,
      delay = 2000,
      stopped = false;
    const close = (): void => {
      source?.close();
      source = null;
      connected = false;
      window.clearTimeout(retry);
    };
    const connect = (): void => {
      close();
      if (stopped || document.visibilityState !== 'visible') return;
      if (typeof EventSource === 'undefined') {
        publishClock(displayClock.now(), true);
        return;
      }
      const stream = new EventSource('/api/sync');
      source = stream;
      stream.onopen = () => {
        if (stopped || source !== stream) return;
        connected = true;
        delay = 2000;
        lastClock = Date.now();
        lastPulse = lastClock;
        publishClock(displayClock.now(), true);
      };
      stream.addEventListener('clock', (event) => {
        if (stopped || source !== stream || document.visibilityState !== 'visible') return;
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            atMs: number;
            intervalMs: number;
          };
          if (
            !Number.isFinite(data.atMs) ||
            !Number.isFinite(data.intervalMs) ||
            data.intervalMs < 1000 ||
            data.intervalMs > 300000
          )
            return;
          intervalMs = data.intervalMs;
          displayClock.synchronize(data.atMs);
          lastClock = Date.now();
          lastPulse = lastClock;
          publishClock(data.atMs);
        } catch (error) {
          console.warn(
            'Invalid synchronization clock',
            error instanceof Error ? error.name : 'unknown',
          );
        }
      });
      stream.addEventListener('change', (event) => {
        if (stopped || source !== stream) return;
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            topics?: unknown;
          };
          if (Array.isArray(data.topics))
            window.dispatchEvent(
              new CustomEvent(EVENT, {
                detail: data.topics.filter((topic) => TOPICS.includes(topic as SyncTopic)),
              }),
            );
        } catch (error) {
          console.warn(
            'Invalid synchronization notification',
            error instanceof Error ? error.name : 'unknown',
          );
        }
      });
      stream.onerror = () => {
        if (stopped || source !== stream) return;
        close();
        if (document.visibilityState === 'visible') {
          retry = window.setTimeout(connect, delay);
          delay = Math.min(30000, delay * 2);
        }
      };
    };
    const visibility = (): void => {
      if (document.visibilityState === 'visible') {
        display();
        connect();
      } else close();
    };
    connect();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      display();
      const now = Date.now();
      if (
        document.visibilityState === 'visible' &&
        (!connected || now - lastClock > Math.max(15000, 2 * intervalMs)) &&
        now - lastPulse >= intervalMs
      ) {
        lastPulse = now;
        publishClock(displayClock.now(), true);
      }
    }, 250);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stopped = true;
      if (pageClock === displayClock) pageClock = null;
      window.clearInterval(timer);
      close();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled, configuredMs]);
}
/** Read on opening/resume and shared-clock invalidations; no per-consumer polling timer. */
export function useSyncRefresh(
  topics: SyncTopic[],
  callback: (signal: AbortSignal) => Promise<SyncReadResult>,
  enabled = true,
  scope = '',
  refreshOnClock = false,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const key = topics.join('|');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let running = false,
      queued = false,
      failed: { notBeforeMs: number } | null = null,
      scheduled: number | undefined;
    const run = (): void => {
      if (controller.signal.aborted || document.visibilityState !== 'visible') return;
      if (failed && Date.now() < failed.notBeforeMs) return;
      if (running) {
        queued = true;
        return;
      }
      // A read covers invalidations received before it starts. Notifications
      // arriving during it still queue a follow-up, including SSE reconnection.
      window.clearTimeout(scheduled);
      scheduled = undefined;
      running = true;
      const requestController = new AbortController(),
        cancel = (): void => requestController.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      const deadline = window.setTimeout(
        () =>
          requestController.abort(
            new DOMException('Synchronization read timed out', 'TimeoutError'),
          ),
        15000,
      );
      void callbackRef
        .current(requestController.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          failed = result && result.status === 'retry' ? result : null;
          if (result && result.status === 'stop') queued = false;
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const result = syncReadFailure(error, requestController.signal);
          failed = result.status === 'retry' ? result : null;
          if (result.status === 'stop') queued = false;
          if (!requestController.signal.aborted)
            console.warn(
              'Synchronization read failed',
              key,
              error instanceof Error ? error.name : 'unknown',
            );
        })
        .finally(() => {
          window.clearTimeout(deadline);
          controller.signal.removeEventListener('abort', cancel);
          running = false;
          if (queued) {
            queued = false;
            schedule();
          }
        });
    };
    const schedule = (): void => {
      if (failed && Date.now() < failed.notBeforeMs) return;
      if (!controller.signal.aborted && scheduled === undefined)
        scheduled = window.setTimeout(() => {
          scheduled = undefined;
          run();
        }, 80);
    };
    const notice = (event: Event): void => {
      if (
        ((event as CustomEvent<SyncTopic[]>).detail ?? []).some((topic) =>
          key.split('|').includes(topic),
        )
      )
        schedule();
    };
    window.addEventListener(EVENT, notice);
    const clock = (): void => {
      if (refreshOnClock || failed) schedule();
    };
    window.addEventListener(CLOCK, clock);
    // Start foreground scopes at the end of this turn, without the background
    // coalescing delay. Same-turn connection notices are covered by this read.
    queueMicrotask(run);
    return () => {
      controller.abort();
      window.clearTimeout(scheduled);
      window.removeEventListener(EVENT, notice);
      window.removeEventListener(CLOCK, clock);
    };
  }, [key, enabled, scope, refreshOnClock]);
}
