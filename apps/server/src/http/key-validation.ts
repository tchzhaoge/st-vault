import type { KeyVault, AddressKey } from './key-vault.js';
import { ProviderError } from '../provider/http.js';

interface Sample {
  name: string;
  address: string;
}

export function createKeyValidation(
  vault: KeyVault,
  sample?: (key: AddressKey, signal: AbortSignal) => Promise<Sample | undefined>,
) {
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  function cancel(): void {
    clearTimeout(retry);
    controller?.abort();
    controller = undefined;
  }
  function start(force = false): void {
    cancel();
    const key = vault.key;
    if (!key || !sample || (!force && vault.status() !== 'pending')) return;
    const attempt = new AbortController();
    controller = attempt;
    active = (async () => {
      try {
        const result = await sample(
          key,
          AbortSignal.any([attempt.signal, AbortSignal.timeout(22000)]),
        );
        if (result && !attempt.signal.aborted && vault.key === key)
          vault.observeSample(result.name, result.address);
      } catch (error) {
        if (!attempt.signal.aborted)
          console.warn(
            JSON.stringify({
              event: 'key_sample_unavailable',
              code: error instanceof ProviderError ? error.code : 'unexpected_error',
            }),
          );
      } finally {
        if (controller === attempt) {
          controller = undefined;
          if (vault.key === key && vault.status() === 'pending')
            retry = setTimeout(start, 60000).unref();
        }
      }
    })();
  }
  return {
    start,
    get checking(): boolean {
      return controller !== undefined;
    },
    async close(): Promise<void> {
      cancel();
      await active;
    },
  };
}
