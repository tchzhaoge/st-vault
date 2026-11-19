import { ProviderError } from '../provider/http.js';

interface Failure {
  event: string;
  code: string;
  count: number;
  reportedAt: number;
  level: 'warn' | 'error';
  sourceHost?: string;
  status?: number;
}
export function ioCode(error: unknown): string {
  const value =
    error instanceof Error && 'code' in error
      ? error.code
      : error instanceof Error
        ? error.name
        : 'unknown';
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : 'unknown';
}
/** Source-level aggregation only; the existing runtime logger owns redaction and rotation. */
export class DerivativeDiagnostics {
  private readonly failures = new Map<string, Failure>();
  constructor(private readonly now = () => performance.now()) {}
  record(
    event: string,
    error: unknown,
    level: 'warn' | 'error' = 'warn',
    sourceHost?: string,
  ): void {
    let code = ioCode(error);
    let status = error instanceof ProviderError ? error.status : undefined;
    let key = `${event}:${code}:${sourceHost ?? ''}:${status ?? ''}`;
    if (!this.failures.has(key) && this.failures.size >= 63) {
      event = 'derivative_error_overflow';
      code = 'other';
      key = event;
      sourceHost = undefined;
      status = undefined;
    }
    let failure = this.failures.get(key);
    const now = this.now();
    if (!failure) {
      failure = { event, code, count: 0, reportedAt: now, level, sourceHost, status };
      this.failures.set(key, failure);
      console[level](
        JSON.stringify({
          event,
          code,
          sourceHost,
          status,
          occurrences: 1,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message.slice(0, 512) }
              : undefined,
        }),
      );
      return;
    }
    failure.count++;
    if (now - failure.reportedAt >= 10000) this.emit(failure, 'window', now);
  }
  private emit(failure: Failure, reason: 'window' | 'close', now: number): void {
    if (!failure.count) return;
    console[failure.level](
      JSON.stringify({
        event: failure.event,
        code: failure.code,
        sourceHost: failure.sourceHost,
        status: failure.status,
        occurrences: failure.count,
        summary: reason,
        windowMs: Math.max(0, now - failure.reportedAt),
      }),
    );
    failure.count = 0;
    failure.reportedAt = now;
  }
  close(): void {
    const now = this.now();
    for (const failure of this.failures.values()) this.emit(failure, 'close', now);
    this.failures.clear();
  }
}
