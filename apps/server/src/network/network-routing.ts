import { z } from 'zod';
import type { CdnProbeStatus, NetworkRoutesStatus } from '@st-vault/api-schema';
import type { ArchivePort } from '../ports.js';
import { type SiteRoutes } from '../provider/site-routes.js';
import { createLiveSource, type LiveSourceOptions } from '../provider/live-source.js';
import { ProviderError } from '../provider/http.js';
import { DEFAULT_HLS_EDGE, HLS_EDGES } from '../provider/media-origins.js';

const preferencesSchema = z
  .object({
    cdnHost: z.enum(HLS_EDGES),
  })
  .strict();
const patchSchema = preferencesSchema
  .strict()
  .partial()
  .refine((value) => Object.keys(value).length > 0);
type Preferences = NetworkRoutesStatus['preferences'];

/** Only HLS CDN preferences; the account owns the website origin. */
export class NetworkRouting {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly controller = new AbortController();
  private probe?: Promise<void>;
  private cdnProbe: CdnProbeStatus = {
    running: false,
    completed: 0,
    total: HLS_EDGES.length,
    testingHost: null,
    error: null,
    results: {},
  };
  private readonly listeners = new Set<() => void>();
  private readonly cdnListeners = new Set<() => void>();
  private readonly detachSites: () => void;
  private readonly active = new Map<string, string>();
  private constructor(
    private readonly archive: Pick<ArchivePort, 'getSetting' | 'setSetting'>,
    readonly sites: SiteRoutes,
    private preferences: Preferences,
    private readonly options: Pick<LiveSourceOptions, 'fetch' | 'keyLookup'>,
  ) {
    this.detachSites = sites.subscribe(() => this.changed());
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeCdn(listener: () => void): () => void {
    this.cdnListeners.add(listener);
    return () => this.cdnListeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  static async open(
    archive: Pick<ArchivePort, 'getSetting' | 'setSetting'>,
    sites: SiteRoutes,
    options: Pick<LiveSourceOptions, 'fetch' | 'keyLookup'> = {},
  ): Promise<NetworkRouting> {
    const stored = await archive.getSetting('network.routes');
    const previous = stored
      ? preferencesSchema
          .extend({ cdnHost: z.enum(HLS_EDGES).nullish() })
          .strip()
          .parse(JSON.parse(stored) as unknown)
      : {};
    const preferences = { cdnHost: previous.cdnHost ?? DEFAULT_HLS_EDGE };
    if (stored && stored !== JSON.stringify(preferences))
      await archive.setSetting('network.routes', JSON.stringify(preferences));
    return new NetworkRouting(archive, sites, preferences, options);
  }
  status(): NetworkRoutesStatus {
    return {
      preferences: { ...this.preferences },
      sites: this.sites.status(),
      cdnHosts: [...HLS_EDGES],
      cdnProbe: { ...this.cdnProbe, results: { ...this.cdnProbe.results } },
      activeCdns: Object.fromEntries(this.active),
    };
  }
  preferredCdn = (): string => this.preferences.cdnHost;
  selectedCdn = (id: number, host: string): void => {
    const previous = this.active.get(`stripchat:${id}`);
    this.active.delete(`stripchat:${id}`);
    this.active.set(`stripchat:${id}`, host);
    if (this.active.size > 256) this.active.delete(this.active.keys().next().value!);
    if (previous !== host) this.changed();
  };
  stoppedCdn = (id: number): void => {
    if (this.active.delete(`stripchat:${id}`)) this.changed();
  };
  async update(patch: unknown): Promise<NetworkRoutesStatus> {
    const parsed = patchSchema.parse(patch);
    const operation = this.queue.then(async () => {
      const next = preferencesSchema.parse({ ...this.preferences, ...parsed });
      if (next.cdnHost === this.preferences.cdnHost) return this.status();
      await this.archive.setSetting('network.routes', JSON.stringify(next));
      this.preferences = next;
      this.active.clear();
      for (const listener of this.cdnListeners) listener();
      this.changed();
      return this.status();
    });
    // Preserve queue admission after a rejected write; return the rejection to its caller.
    this.queue = operation.catch(() => undefined);
    return await operation;
  }
  probeSites(): void {
    void this.sites.probe();
  }
  probeCdns(providerId?: number): void {
    const lifetime = this.controller.signal;
    if (this.probe || lifetime.aborted) return;
    const progress: CdnProbeStatus = {
      running: true,
      completed: 0,
      total: HLS_EDGES.length,
      testingHost: null,
      error: null,
      results: {},
    };
    this.cdnProbe = progress;
    this.probe = Promise.resolve()
      .then(async () => {
        const id = providerId ?? (await this.publicProbeRooms(lifetime))[0];
        const source = createLiveSource(this.options);
        // Sequential samples avoid competing for the same connection bandwidth.
        for (const host of HLS_EDGES) {
          if (lifetime.aborted) break;
          progress.testingHost = host;
          this.changed();
          const signal = AbortSignal.any([lifetime, AbortSignal.timeout(15000)]);
          try {
            const resolved = await source.resolve(id, signal, undefined, {
              preferredCdn: host,
              announce: false,
            });
            const segments = resolved.playlist.segments;
            const segment = segments[Math.max(0, segments.length - 2)];
            const address = source.segmentUrl(resolved, segment.address);
            const started = performance.now();
            const bytes = await source.sample(address, signal);
            if (!bytes.length) throw new ProviderError('empty-media-sample');
            progress.results[host] = {
              bytesPerSecond: Math.round(
                (bytes.length * 1000) / Math.max(1, performance.now() - started),
              ),
              bitrate: resolved.quality.bandwidth || null,
              error: null,
            };
          } catch (error) {
            if (lifetime.aborted) break;
            progress.results[host] = {
              bytesPerSecond: null,
              bitrate: null,
              error: signal.aborted
                ? 'request-deadline'
                : error instanceof ProviderError
                  ? error.code
                  : 'probe-failed',
            };
          }
          progress.completed++;
        }
      })
      .catch((error: unknown) => {
        if (!lifetime.aborted)
          progress.error =
            error instanceof ProviderError ? error.code : 'probe-room-discovery-failed';
      })
      .finally(() => {
        this.probe = undefined;
        progress.running = false;
        progress.testingHost = null;
        this.changed();
      });
    this.changed();
  }
  private publicProbeRooms(signal: AbortSignal): Promise<number[]> {
    return this.sites.read(
      '/api/front/models?limit=8&offset=0&primaryTag=girls',
      (text) => {
        const body = JSON.parse(text) as { models?: unknown };
        if (!Array.isArray(body.models)) throw new ProviderError('invalid-upstream-json');
        const ids = body.models.flatMap((value: unknown) => {
          if (!value || typeof value !== 'object') return [];
          const item = value as Record<string, unknown>;
          return item.isLive === true &&
            item.status === 'public' &&
            typeof item.id === 'number' &&
            Number.isSafeInteger(item.id) &&
            item.id > 0
            ? [item.id]
            : [];
        });
        if (!ids.length) throw new ProviderError('no-public-probe-room');
        return ids;
      },
      signal,
    );
  }
  async keySample(
    key: { name: string; value: string },
    signal: AbortSignal,
  ): Promise<{ name: string; address: string } | undefined> {
    const ids = await this.publicProbeRooms(signal);
    for (const id of ids.slice(0, 3)) {
      if (signal.aborted) return undefined;
      let sample: { name: string; address: string } | undefined;
      const source = createLiveSource({
        ...this.options,
        preferredCdn: this.preferredCdn,
        keyLookup: (name) => (name === key.name ? key.value : undefined),
        onKeySample: (name, address) => {
          sample = { name, address };
        },
      });
      try {
        await source.resolve(id, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
      }
      if (!signal.aborted && sample) return sample;
    }
    return undefined;
  }
  async close(): Promise<void> {
    this.controller.abort();
    this.detachSites();
    this.listeners.clear();
    this.cdnListeners.clear();
    await Promise.all([this.queue, this.probe]);
  }
}
