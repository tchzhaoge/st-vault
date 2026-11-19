import type { ServerResponse } from 'node:http';
import type { SyncClock } from '../runtime/sync-clock.js';

export type SyncTopic =
  'subjects' | 'timeline' | 'events' | 'account' | 'keys' | 'system' | 'personal' | 'playback';
interface Client {
  owner: string;
  response: ServerResponse;
  lastWrite: number;
  dispose: () => void;
}
/** One shared local read loop, regardless of the number of visible browser tabs. */
export function createSyncHub(options: {
  clock?: SyncClock;
  read: () => Promise<Record<SyncTopic, string>>;
  authorized: (owner: string) => boolean;
  now?: () => number;
  intervalMs?: number;
}) {
  const clients = new Set<Client>(),
    fingerprints = new Map<SyncTopic, string>(),
    sentAt = new Map<SyncTopic, number>();
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | undefined,
    running = false,
    closed = false,
    pending: Promise<void> | undefined;
  let lastRunAtMs: number | null = null,
    lastSuccessAtMs: number | null = null,
    failed = false;
  const minimum: Record<SyncTopic, number> = {
    subjects: 1000,
    timeline: 5000,
    events: 1000,
    account: 1000,
    keys: 1000,
    system: 15000,
    personal: 1000,
    playback: 1000,
  };
  const closeClient = (client: Client): void => {
    client.dispose();
    client.response.destroy();
  };
  const write = (client: Client, data: string): void => {
    if (client.response.destroyed || client.response.writableEnded) {
      client.dispose();
      return;
    }
    try {
      if (!client.response.write(data)) closeClient(client);
      else client.lastWrite = now();
    } catch {
      closeClient(client);
    }
  };
  const tick = async (): Promise<void> => {
    if (running || closed || !clients.size) return;
    for (const client of clients) if (!options.authorized(client.owner)) closeClient(client);
    if (!clients.size) return;
    running = true;
    lastRunAtMs = now();
    try {
      if (options.clock)
        for (const client of clients)
          write(
            client,
            `event: clock\ndata: ${JSON.stringify({ atMs: now(), intervalMs: options.clock.intervalMs() })}\n\n`,
          );
      const values = await options.read(),
        topics: SyncTopic[] = [];
      if (closed) return;
      for (const topic of Object.keys(values) as SyncTopic[]) {
        if (
          values[topic] !== fingerprints.get(topic) &&
          (options.clock || now() - (sentAt.get(topic) ?? -Infinity) >= minimum[topic])
        ) {
          fingerprints.set(topic, values[topic]);
          sentAt.set(topic, now());
          topics.push(topic);
        }
      }
      for (const client of clients) {
        if (topics.length)
          write(client, `event: change\ndata: ${JSON.stringify({ topics, atMs: now() })}\n\n`);
        else if (now() - client.lastWrite >= 15000) write(client, ': heartbeat\n\n');
      }
      failed = false;
      lastSuccessAtMs = now();
    } catch {
      failed = true;
      for (const client of clients) closeClient(client);
    } finally {
      running = false;
    }
  };
  const poll = (): void => {
    pending ??= tick().finally(() => {
      pending = undefined;
    });
  };
  const detachClock = options.clock?.subscribe('ui-sync', async () => {
    poll();
    await pending;
  });
  const detachHeartbeat = options.clock?.subscribe(
    'sse-heartbeat',
    () => {
      for (const client of clients)
        if (now() - client.lastWrite >= 15000) write(client, ': heartbeat\n\n');
    },
    { everyPulse: true },
  );
  return {
    status: () => ({ clients: clients.size, running, failed, lastRunAtMs, lastSuccessAtMs }),
    open(owner: string, response: ServerResponse): boolean {
      if (
        closed ||
        !options.authorized(owner) ||
        clients.size >= 32 ||
        [...clients].filter((client) => client.owner === owner).length >= 4
      )
        return false;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, private',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      const client: Client = {
        owner,
        response,
        lastWrite: now(),
        dispose: () => {
          clients.delete(client);
          response.removeListener('close', client.dispose);
          response.removeListener('error', client.dispose);
          if (!clients.size && timer) {
            clearInterval(timer);
            timer = undefined;
          }
        },
      };
      clients.add(client);
      response.once('close', client.dispose);
      response.once('error', client.dispose);
      write(client, 'retry: 3000\nevent: ready\ndata: {}\n\n');
      if (!clients.has(client)) return true;
      if (!timer && !options.clock) {
        timer = setInterval(poll, options.intervalMs ?? 1000);
        timer.unref();
      }
      poll();
      return true;
    },
    invalidate(topic: SyncTopic): void {
      fingerprints.delete(topic);
    },
    notify(topic: SyncTopic | SyncTopic[]): void {
      if (closed) return;
      const topics = [...new Set(Array.isArray(topic) ? topic : [topic])];
      for (const item of topics) fingerprints.delete(item);
      for (const client of clients) {
        if (!options.authorized(client.owner)) closeClient(client);
        else write(client, `event: change\ndata: ${JSON.stringify({ topics, atMs: now() })}\n\n`);
      }
    },
    closeOwner(owner: string): void {
      for (const client of clients) if (client.owner === owner) closeClient(client);
    },
    async close(): Promise<void> {
      closed = true;
      detachClock?.();
      detachHeartbeat?.();
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const client of clients) closeClient(client);
      await pending;
    },
  };
}
