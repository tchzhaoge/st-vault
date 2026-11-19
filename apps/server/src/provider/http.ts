/** A request budget covers headers, redirects and every body byte. */
export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  allow: (url: URL) => boolean;
  account?: boolean;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly challenge = false,
  ) {
    super(code);
  }
}

export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('cancelled');
}

/** Cancellation also bounds injected asynchronous key lookups that ignore their signal. */
export async function waitFor<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  aborted(signal);
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = (): void => reject(new ProviderError('cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(value), stopped]);
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new ProviderError('cancelled'));
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function createHttp(options: HttpOptions): {
  bytes(
    url: string,
    config?: {
      signal?: AbortSignal;
      maxBytes?: number;
      cookie?: string;
      authorization?: string;
      media?: boolean;
      range?: boolean;
      /** Return at most maxBytes and cancel the body; only explicit throughput sampling uses this. */
      prefix?: boolean;
    },
  ): Promise<Uint8Array>;
  text(url: string, signal?: AbortSignal, cookie?: string, authorization?: string): Promise<string>;
} {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new ProviderError('invalid-timeout');
  const bytes = async (
    address: string,
    config: {
      signal?: AbortSignal;
      maxBytes?: number;
      cookie?: string;
      authorization?: string;
      media?: boolean;
      range?: boolean;
      /** Return at most maxBytes and cancel the body; only explicit throughput sampling uses this. */
      prefix?: boolean;
    } = {},
  ): Promise<Uint8Array> => {
    aborted(config.signal);
    if ((config.cookie || config.authorization) && !options.account)
      throw new ProviderError('anonymous-credentials-denied');
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    config.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    let cancelPending: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelPending = (): void =>
        reject(new ProviderError(config.signal?.aborted ? 'cancelled' : 'request-deadline'));
      controller.signal.addEventListener('abort', cancelPending, { once: true });
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let url = new URL(address);
      const firstOrigin = url.origin;
      const maxBytes = config.maxBytes ?? 2 * 1024 * 1024;
      for (let redirects = 0; redirects <= 4; redirects++) {
        if ((config.cookie || config.authorization) && url.origin !== firstOrigin)
          throw new ProviderError('account-redirect-denied');
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          (url.port && url.port !== '443') ||
          !options.allow(url)
        )
          throw new ProviderError('upstream-url-denied');
        const headers: Record<string, string> = {
          Accept: '*/*',
          'User-Agent': 'ST-Vault/3 public-client',
        };
        if (config.cookie) headers.Cookie = config.cookie;
        if (config.authorization) headers.Authorization = config.authorization;
        if (config.range) headers.Range = 'bytes=0-4095';
        const response = await Promise.race([
          request(url.toString(), {
            method: 'GET',
            headers,
            credentials: 'omit',
            redirect: 'manual',
            signal: controller.signal,
          }),
          cancelled,
        ]);
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          const location = response.headers.get('location');
          if (!location || redirects === 4) throw new ProviderError('redirect-limit');
          url = new URL(location, url);
          continue;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const after = response.headers.get('retry-after');
          const delay =
            after === null
              ? NaN
              : /^\d+$/.test(after)
                ? Number(after) * 1000
                : Date.parse(after) - Date.now();
          throw new ProviderError(
            'upstream-http',
            response.status,
            false,
            Number.isFinite(delay) ? Math.min(30000, Math.max(0, delay)) : undefined,
            response.status === 403 &&
              (response.headers.get('cf-mitigated') === 'challenge' ||
                /^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')),
          );
        }
        if (config.range && response.status !== 206) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('range-not-supported');
        }
        if (
          config.media &&
          !/^(?:video\/[^;]+|application\/octet-stream)(?:;|$)/i.test(
            response.headers.get('content-type') ?? '',
          )
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('invalid-media-type');
        }
        const declared = response.headers.get('content-length');
        if (
          declared &&
          (!/^\d+$/.test(declared) || (!config.prefix && Number(declared) > maxBytes))
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError('body-too-large');
        }
        if (!response.body) return new Uint8Array();
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const item = await Promise.race([reader.read(), cancelled]);
          if (item.done) break;
          if (config.prefix && length + item.value.byteLength >= maxBytes) {
            chunks.push(item.value.subarray(0, maxBytes - length));
            length = maxBytes;
            await Promise.race([reader.cancel(), cancelled]);
            break;
          }
          length += item.value.byteLength;
          if (length > maxBytes) throw new ProviderError('body-too-large');
          chunks.push(item.value);
        }
        aborted(config.signal);
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      }
      throw new ProviderError('redirect-limit');
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted)
        throw new ProviderError(config.signal?.aborted ? 'cancelled' : 'request-deadline');
      throw new ProviderError('upstream-request');
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', cancel);
      if (cancelPending) controller.signal.removeEventListener('abort', cancelPending);
      if (reader) void reader.cancel().catch(() => undefined);
    }
  };
  return {
    bytes,
    text: async (url, signal, cookie, authorization) => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(
          await bytes(url, { signal, cookie, authorization }),
        );
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('invalid-utf8');
      }
    },
  };
}
