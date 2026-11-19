import { tr } from './i18n';
export class ApiError extends Error {
  readonly notBeforeMs: number;
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'ApiError';
    this.notBeforeMs = Date.now() + retryAfterMs;
  }
}
/** Preserve the server's next admissible time after a read budget expires. */
export class ReadRetryError extends Error {
  constructor(
    cause: Error,
    readonly notBeforeMs: number,
  ) {
    super(cause.message, { cause });
    this.name = cause.name;
  }
}

/** A transport deadline cannot roll back a mutation already accepted by the server. */
export class MutationOutcomeUnknown extends Error {
  constructor(cause: unknown) {
    super(tr('操作结果尚未确认，请核对同步后的状态，避免重复提交。'), { cause });
    this.name = 'MutationOutcomeUnknown';
  }
}

interface RequestOptions extends RequestInit {
  /** Rebuildable playback leases retain their transport errors for bounded retries. */
  operation?: 'mutation' | 'session';
}
function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
      } else resolve();
    };
    const timer = setTimeout(finish, Math.min(milliseconds, 15000));
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
export async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const { operation = 'mutation', ...options } = init ?? {};
  const read = ['GET', 'HEAD'].includes(init?.method?.toUpperCase() ?? 'GET');
  if (init?.signal?.aborted) throw init.signal.reason;
  const controller = new AbortController();
  const cancel = (): void => controller.abort(init?.signal?.reason);
  init?.signal?.addEventListener('abort', cancel, { once: true });
  if (init?.signal?.aborted) cancel();
  const deadline = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    read ? 15000 : 30000,
  );
  let notBeforeMs = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(path, {
          ...options,
          signal: controller.signal,
          credentials: 'same-origin',
        });
        if (!response.ok) {
          let message = tr('请求失败（{{v0}}）', { v0: response.status });
          let reason: string | undefined;
          try {
            const body = (await response.json()) as { error?: string; reason?: string };
            if (body.error) message = body.error;
            reason = typeof body.reason === 'string' ? body.reason : undefined;
          } catch {
            /* Keep a bounded public status message. */
          }
          const retry = response.headers.get('retry-after');
          const retryAfterMs =
            retry === null
              ? 0
              : /^\d+(?:\.\d+)?$/.test(retry)
                ? Number(retry) * 1000
                : Math.max(0, Date.parse(retry) - Date.now()) || 0;
          throw new ApiError(message, response.status, reason, retryAfterMs);
        }
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      } catch (error) {
        const transient =
          error instanceof TypeError ||
          (error instanceof ApiError &&
            (error.status === 429 || (error.status === 503 && error.message === 'archive_busy')));
        if (read && transient && error instanceof ApiError)
          notBeforeMs = Math.max(notBeforeMs, error.notBeforeMs);
        if (!read || !transient || attempt >= 2 || controller.signal.aborted) throw error;
        // All attempts and their wait share the original deadline. A long
        // Retry-After is interrupted by that budget, never shortened to retry early.
        await waitForRetry(
          Math.max(250 * 2 ** attempt, error instanceof ApiError ? error.retryAfterMs : 0),
          controller.signal,
        );
      }
    }
  } catch (error) {
    if (read && error instanceof Error && error.name === 'TimeoutError' && notBeforeMs > Date.now())
      throw new ReadRetryError(error, notBeforeMs);
    if (
      !read &&
      operation === 'mutation' &&
      (!(error instanceof ApiError) || (error.status >= 500 && error.message !== 'archive_busy'))
    )
      throw new MutationOutcomeUnknown(error);
    throw error;
  } finally {
    clearTimeout(deadline);
    init?.signal?.removeEventListener('abort', cancel);
  }
}
