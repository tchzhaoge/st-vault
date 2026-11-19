import { expect, it, vi } from 'vitest';
import { runBackground } from './background.js';
it('reports rejected background work without leaking a signed source URL', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    runBackground(
      Promise.reject(new Error('fetch https://cdn.example/video?token=private-value')),
      'reconcile_failed',
    );
    await Promise.resolve();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('reconcile_failed');
    expect(String(log.mock.calls[0][0])).not.toContain('private-value');
  } finally {
    log.mockRestore();
  }
});
