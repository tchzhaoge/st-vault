import { EventEmitter } from 'node:events';
import { ServerResponse, type IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createSyncHub, type SyncTopic } from './sync.js';
import { SyncClock } from '../runtime/sync-clock.js';
const values = (): Record<SyncTopic, string> => ({
  subjects: 's',
  timeline: 't',
  events: 'e',
  account: 'a',
  keys: 'k',
  system: 'd',
  personal: 'p',
  playback: 'l',
});
class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  frames: string[] = [];
  writeHead(): void {
    /* inspect actual frames instead */
  }
  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}
it('publishes server clock ticks for all clients without creating another polling timer', async () => {
  vi.useFakeTimers();
  const clock = new SyncClock({ intervalMs: () => 2000 }),
    read = vi.fn(() => Promise.resolve(values()));
  const hub = createSyncHub({ clock, read, authorized: () => true }),
    client = new Response();
  try {
    hub.open('owner', client as unknown as ServerResponse);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const count = read.mock.calls.length;
    hub.notify('subjects');
    expect(client.frames.at(-1)).toContain('"topics":["subjects"]');
    expect(read).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(1);
    hub.notify(['subjects', 'timeline']);
    expect(client.frames.at(-1)).toContain('"topics":["subjects","timeline"]');
    expect(read).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(count + 1);
    expect(
      client.frames.some(
        (frame) => frame.includes('event: clock') && frame.includes('"intervalMs":2000'),
      ),
    ).toBe(true);
    await hub.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(count + 1);
  } finally {
    await hub.close();
    await clock.close();
    vi.useRealTimers();
  }
});
it('shares one serialized snapshot loop across clients, bounds owners, and destroys revoked streams', async () => {
  vi.useFakeTimers();
  const read = vi.fn(() => Promise.resolve(values())),
    allowed = new Set(['A', 'B']);
  const hub = createSyncHub({ read, authorized: (owner) => allowed.has(owner) });
  const clients = Array.from({ length: 5 }, () => new Response());
  try {
    for (const client of clients.slice(0, 4))
      expect(hub.open('A', client as unknown as ServerResponse)).toBe(true);
    expect(hub.open('A', clients[4] as unknown as ServerResponse)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    allowed.delete('A');
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients.slice(0, 4).every((client) => client.destroyed)).toBe(true);
    const count = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(count);
  } finally {
    await hub.close();
    vi.useRealTimers();
  }
});
it('destroys real backpressured sockets instead of releasing accounting while writes remain buffered', async () => {
  const hub = createSyncHub({ read: () => Promise.resolve(values()), authorized: () => true }),
    sockets: Duplex[] = [];
  try {
    for (let index = 0; index < 6; index++) {
      const socket = new Duplex({
        writableHighWaterMark: 1,
        read() {
          /* deliberately no consumer */
        },
        write() {
          /* deliberately no completion */
        },
      });
      sockets.push(socket);
      const response = new ServerResponse({ method: 'GET' } as IncomingMessage);
      response.assignSocket(socket as Socket);
      hub.open('owner', response);
      expect(response.destroyed).toBe(true);
      expect(socket.destroyed).toBe(true);
    }
  } finally {
    await hub.close();
    for (const socket of sockets) socket.destroy();
  }
});
it('drains an in-flight shared read before shutdown', async () => {
  let resolve: (value: Record<SyncTopic, string>) => void = () => undefined;
  const hub = createSyncHub({
    read: () =>
      new Promise((ready) => {
        resolve = ready;
      }),
    authorized: () => true,
  });
  const response = new Response();
  hub.open('owner', response as unknown as ServerResponse);
  let closed = false;
  const closing = hub.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(response.destroyed).toBe(true);
  resolve(values());
  await closing;
  expect(closed).toBe(true);
});
