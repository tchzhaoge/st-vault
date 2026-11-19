import { createHttp, aborted, pause, ProviderError, waitFor } from './http.js';
import { attributes, parseMaster, parsePlaylist } from './hls.js';
import type { Playlist } from './hls.js';
import { decryptAddress } from './mouflon.js';
import { rankedVariants } from './quality.js';
import { HLS_DOMAINS, HLS_EDGES, mediaHost } from './media-origins.js';

export interface LiveSourceOptions {
  preferredCdn?: () => string | null;
  onCdnSelected?: (id: number, host: string) => void;
  fetch?: typeof globalThis.fetch;
  hlsEdges?: readonly string[];
  allowedMediaHosts?: readonly string[];
  keyLookup?: (
    name: string,
    signal?: AbortSignal,
  ) => string | undefined | Promise<string | undefined>;
  onKeySample?: (name: string, address: string) => void;
  now?: () => number;
}
export interface LiveSource {
  edge: string;
  url: string;
  secret: string | undefined;
  key: string;
  playlist: Playlist;
  quality: { height: number; bandwidth: number };
}
export function createLiveSource(options: LiveSourceOptions) {
  // Cache the edge, never expiring playlist URLs or decryption material.
  const preferredEdges = new Map<number, string>();
  const hosts = options.allowedMediaHosts ?? HLS_DOMAINS;
  const allowed = (url: URL): boolean =>
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === '443') &&
    mediaHost(url, hosts);
  const trackedClient = (timeoutMs = 10000) => {
    const requests: Promise<unknown>[] = [];
    const http = createHttp({
      allow: allowed,
      timeoutMs,
      fetch: (input, init) => {
        const pending = (async () => {
          const response = await (options.fetch ?? globalThis.fetch)(input, init);
          if (init?.signal?.aborted) {
            await response.body?.cancel();
            throw new ProviderError('cancelled');
          }
          return response;
        })();
        requests.push(pending);
        return pending;
      },
    });
    return {
      http,
      drain: async () => {
        await Promise.allSettled(requests);
      },
    };
  };
  const full = async (
    address: string,
    signal: AbortSignal,
    client: ReturnType<typeof createHttp>,
  ): Promise<{ url: string; playlist: Playlist }> => {
    const url = new URL(address);
    url.searchParams.delete('_HLS_skip');
    let body = await client.text(url.href, signal);
    if (body.includes('#EXT-X-SKIP:')) {
      url.searchParams.delete('_HLS_msn');
      url.searchParams.delete('_HLS_part');
      url.searchParams.set('stv_full', String((options.now ?? Date.now)()));
      body = await client.text(url.href, signal);
    }
    if (
      body
        .split(/\r?\n/)
        .some(
          (line) =>
            line.startsWith('#EXT-X-BYTERANGE:') ||
            (line.startsWith('#EXT-X-KEY:') && attributes(line.slice(11)).METHOD !== 'NONE'),
        )
    )
      throw new ProviderError('unsupported-live-encryption');
    return { url: url.href, playlist: parsePlaylist(body, url.href) };
  };
  const decoded = (source: Pick<LiveSource, 'playlist' | 'secret'>, address: string): string => {
    const result = source.playlist.protectedMode
      ? source.secret
        ? decryptAddress(address, source.secret)
        : ''
      : address;
    if (!result || !allowed(new URL(result))) throw new ProviderError('upstream-url-denied');
    return result;
  };
  const activate = (id: number, source: LiveSource): void => {
    options.onCdnSelected?.(id, source.edge);
    preferredEdges.delete(id);
    preferredEdges.set(id, source.edge);
    if (preferredEdges.size > 256) preferredEdges.delete(preferredEdges.keys().next().value!);
  };
  const resolve = async (
    id: number,
    signal: AbortSignal,
    failedUrl?: string,
    route?: { preferredCdn: string | null; announce?: boolean },
  ): Promise<LiveSource> => {
    aborted(signal);
    let retryable = false;
    let missingKey = false;
    const observeFailure = (error: unknown): void => {
      if (
        error instanceof ProviderError &&
        (['request-deadline', 'upstream-request'].includes(error.code) ||
          (error.code === 'upstream-http' &&
            ([408, 425, 429].includes(error.status ?? 0) ||
              (error.status !== undefined && error.status >= 500 && error.status <= 599))))
      )
        retryable = true;
    };
    const allEdges = options.hlsEdges ?? HLS_EDGES;
    const manual = route ? route.preferredCdn : options.preferredCdn?.();
    if (manual && !allEdges.includes(manual)) throw new ProviderError('upstream-url-denied');
    const configuredEdges = manual ? [manual] : allEdges;
    // A failed media host must not keep winning the next manifest race.
    const failedSuffix = failedUrl
      ? new URL(failedUrl).hostname.replace(/^(?:edge|media)-hls\./, '')
      : '';
    const preferred = preferredEdges.get(id);
    if (failedSuffix && preferred?.replace(/^edge-hls\./, '') === failedSuffix)
      preferredEdges.delete(id);
    const affinity = preferredEdges.get(id);
    const edges = [...configuredEdges].sort(
      (a, b) =>
        Number(a.replace(/^edge-hls\./, '') === failedSuffix) -
          Number(b.replace(/^edge-hls\./, '') === failedSuffix) ||
        Number(b === affinity) - Number(a === affinity),
    );
    aborted(signal);
    const controller = new AbortController(),
      cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    let next = 0,
      winner: LiveSource | undefined,
      winnerEdge: string | undefined;
    const candidate = async (edge: string): Promise<LiveSource | undefined> => {
      const started = Date.now();
      let phase = 'master';
      const report = (error: unknown): void => {
        if (
          controller.signal.aborted ||
          (error instanceof ProviderError && error.code === 'cancelled')
        )
          return;
        console.warn(
          JSON.stringify({
            event: 'live_source_candidate_failed',
            providerId: id,
            edge,
            phase,
            elapsedMs: Date.now() - started,
            code: error instanceof ProviderError ? error.code : 'unexpected_error',
            status: error instanceof ProviderError ? error.status : undefined,
          }),
        );
      };
      const attemptSignal = controller.signal,
        tracked = trackedClient(),
        client = tracked.http;
      try {
        const masterUrl = new URL(
          `/hls/${id}/master/${id}_auto.m3u8?playlistType=lowLatency`,
          `https://${edge}`,
        ).href;
        const master = parseMaster(await client.text(masterUrl, attemptSignal), masterUrl);
        phase = 'playlist';
        const variants = rankedVariants(master.variants);
        const candidates: { name: string; psch: string; secret?: string }[] = [];
        for (const key of master.keys.slice(0, 128)) {
          const secret =
            (await waitFor(options.keyLookup?.(key.name, attemptSignal), attemptSignal)) ??
            (await waitFor(options.keyLookup?.('*', attemptSignal), attemptSignal));
          if (secret) candidates.push({ ...key, secret });
        }
        if (!master.keys.length) candidates.push({ name: '', psch: '' });
        else if (!candidates.length && variants.length) missingKey = true;
        for (const variant of variants)
          for (const candidate of candidates) {
            try {
              const url = new URL(variant.url);
              url.searchParams.set('playlistType', 'lowLatency');
              if (candidate.name) url.searchParams.set('pkey', candidate.name);
              if (candidate.psch) url.searchParams.set('psch', candidate.psch);
              const loaded = await full(url.href, attemptSignal, client);
              if (!loaded.playlist.segments.length) continue;
              const source: LiveSource = {
                edge,
                ...loaded,
                secret: candidate.secret,
                key: candidate.name,
                quality: { height: variant.height, bandwidth: variant.bandwidth },
              };
              const address = source.playlist.segments[0].address;
              if (source.key && source.playlist.protectedMode)
                options.onKeySample?.(source.key, address);
              decoded(source, address);
              return source;
            } catch (error) {
              report(error);
              observeFailure(error);
              await tracked.drain();
              aborted(attemptSignal);
            }
          }
        return undefined;
      } catch (error) {
        report(error);
        observeFailure(error);
        aborted(attemptSignal);
        return undefined;
      } finally {
        await tracked.drain();
      }
    };
    const primaryCount =
      edges.filter((edge) => edge.replace(/^edge-hls\./, '') !== failedSuffix).length ||
      edges.length;
    const worker = async (limit: number): Promise<void> => {
      while (!controller.signal.aborted && next < limit) {
        const edge = edges[next++];
        const source = await candidate(edge);
        if (source && !winner && !controller.signal.aborted) {
          winner = source;
          winnerEdge = edge;
          controller.abort();
        }
      }
    };
    try {
      await Promise.allSettled(
        Array.from({ length: Math.min(2, primaryCount) }, async (_, index) => {
          // Hedge a slow preferred edge; a fast successful edge needs no race.
          if (affinity && index) await pause(750, controller.signal);
          await worker(primaryCount);
        }),
      );
      // A fast manifest from a failed media host must not beat every healthy alternative.
      // Retry that host only if all alternatives fail; manual single-host mode still works.
      if (!winner && !controller.signal.aborted) await worker(edges.length);
    } finally {
      controller.abort();
      signal.removeEventListener('abort', cancel);
    }
    aborted(signal);
    if (winner && winnerEdge) {
      if (route?.announce !== false) activate(id, winner);
      return winner;
    }
    if (missingKey) throw new ProviderError('live-key-required');
    throw new ProviderError('live-source-unavailable', undefined, retryable);
  };
  const readBytes = async (
    url: string,
    maxBytes: number,
    signal: AbortSignal,
    timeoutMs?: number,
    prefix = false,
  ): Promise<Uint8Array> => {
    const tracked = trackedClient(timeoutMs);
    try {
      return await tracked.http.bytes(url, { signal, maxBytes, media: true, prefix });
    } finally {
      await tracked.drain();
    }
  };
  return {
    activate,
    resolve,
    reload: async (
      source: LiveSource,
      signal: AbortSignal,
      timeoutMs?: number,
    ): Promise<LiveSource> => {
      const tracked = trackedClient(timeoutMs);
      try {
        return { ...source, ...(await full(source.url, signal, tracked.http)) };
      } finally {
        await tracked.drain();
      }
    },
    segmentUrl: (source: LiveSource, address: string): string => decoded(source, address),
    bytes: (url: string, maxBytes: number, signal: AbortSignal, timeoutMs?: number) =>
      readBytes(url, maxBytes, signal, timeoutMs),
    sample: (url: string, signal: AbortSignal) =>
      readBytes(url, 2 * 1024 * 1024, signal, 5000, true),
  };
}
