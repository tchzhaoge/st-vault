import { expect, it, vi } from 'vitest';
import { DerivativeDiagnostics } from './derivative-diagnostics.js';
import { ProviderError } from '../provider/http.js';

it('distinguishes image hosts and HTTP statuses without logging source paths', () => {
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const diagnostics = new DerivativeDiagnostics();
  try {
    for (const status of [403, 404])
      diagnostics.record(
        'cover_refresh_failed',
        new ProviderError('upstream-http', status),
        'warn',
        'static-cdn.strpst.com',
      );
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toMatchObject([
      { sourceHost: 'static-cdn.strpst.com', status: 403 },
      { sourceHost: 'static-cdn.strpst.com', status: 404 },
    ]);
  } finally {
    diagnostics.close();
    logs.mockRestore();
  }
});

it('preserves error severity for the first report and shutdown summaries', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const diagnostics = new DerivativeDiagnostics(() => 0);
    for (let n = 0; n < 3; n++)
      diagnostics.record('screenshot_worker_failed', new Error('failure'), 'error');
    diagnostics.close();
    expect(error).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
    error.mockRestore();
  }
});

it('reports first errors immediately, aggregates by event/code and flushes remaining counts on close', () => {
  let now = 0;
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const errors = new DerivativeDiagnostics(() => now);
  try {
    const error = Object.assign(new Error('partial write root cause'), { code: 'EIO' });
    for (let n = 0; n < 1000; n++) errors.record('derivative_write_failed', error);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logs.mock.calls[0][0]))).toMatchObject({
      event: 'derivative_write_failed',
      code: 'EIO',
      occurrences: 1,
      error: { message: 'partial write root cause' },
    });
    now = 10000;
    errors.record('derivative_write_failed', error);
    expect(JSON.parse(String(logs.mock.calls[1][0]))).toMatchObject({
      occurrences: 1000,
      summary: 'window',
    });
    errors.record('derivative_write_failed', error);
    errors.close();
    expect(logs).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(logs.mock.calls[2][0]))).toMatchObject({
      occurrences: 1,
      summary: 'close',
    });
    errors.close();
    expect(logs).toHaveBeenCalledTimes(3);
  } finally {
    logs.mockRestore();
  }
});

it('bounds distinct diagnostic keys and preserves a real directory ENOENT error', () => {
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const errors = new DerivativeDiagnostics(() => 0);
  try {
    errors.record(
      'derivative_open_failed',
      Object.assign(new Error('parent directory disappeared'), { code: 'ENOENT' }),
    );
    expect(JSON.parse(String(logs.mock.calls[0][0]))).toMatchObject({ code: 'ENOENT' });
    for (let n = 0; n < 1000; n++)
      errors.record(
        `unknown_operation_${n}`,
        Object.assign(new Error('synthetic'), { code: `CUSTOM_${n}` }),
      );
    expect(logs.mock.calls.length).toBeLessThanOrEqual(64);
    errors.close();
    expect(logs.mock.calls.length).toBeLessThanOrEqual(65);
  } finally {
    logs.mockRestore();
  }
});
