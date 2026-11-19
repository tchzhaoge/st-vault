import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Metadata } from './metadata.js';

function fixture(): Metadata {
  const worker = new Worker(
    `
    const {parentPort: port} = require('node:worker_threads');
    const held = [];
    port.on('message', ({id, method, input}) => {
      if (method === 'hold' || input?.hold) held.push({id,executionMs:input.executionMs});
      else if (method === 'exit') process.exit(1);
      else {
        if(method === 'release') for(const request of held.splice(0)) port.postMessage({...request,value:true});
        port.postMessage({id,value:input});
      }
    });
    port.postMessage({ready:true});
  `,
    { eval: true },
  );
  return new Metadata('/unused-synthetic-root', worker);
}

it('demotes background playback-shaped reads without consuming foreground playback admission', async () => {
  const metadata = fixture();
  const background = Array.from({ length: 32 }, () =>
    metadata.withBackgroundReads(() => metadata.call('unitSource', { hold: true })),
  );
  const playback = Array.from({ length: 16 }, () => metadata.call('unitSource', { hold: true }));
  try {
    await expect(metadata.call('unitSource', { hold: true })).rejects.toThrow('METADATA_READ_BUSY');
    await metadata.call('release');
    await Promise.all([...background, ...playback]);
    expect(metadata.stats()).toMatchObject({ pending: 0, readPending: 0 });
  } finally {
    await metadata.terminate();
    await Promise.allSettled([...background, ...playback]);
  }
});

it('demotes known statement reads called through control-shaped helpers but never writes', async () => {
  const metadata = fixture();
  const read = metadata.withBackgroundReads(() => metadata.call('pendingGc', { hold: true }));
  const write = metadata.withBackgroundReads(() => metadata.call('apply', { hold: true }));
  try {
    await metadata.call('write');
    expect(metadata.stats()).toMatchObject({ pending: 2, readPending: 1 });
    await metadata.call('release');
    await Promise.all([read, write]);
  } finally {
    await metadata.terminate();
    await Promise.allSettled([read, write]);
  }
});

it('bounds explicit reads without rejecting accepted writes and releases capacity after replies', async () => {
  const metadata = fixture();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const reads = Array.from({ length: 64 }, () => metadata.read('hold'));
  try {
    const overflow = expect(metadata.read('hold')).rejects.toThrow('METADATA_READ_BUSY');
    await expect(metadata.call('write', { revision: 1 })).resolves.toEqual({ revision: 1 });
    expect(metadata.stats()).toMatchObject({ pending: 64, readPending: 64 });
    await Promise.all([metadata.call('release'), overflow]);
    await Promise.all(reads);
    expect(metadata.stats()).toMatchObject({ pending: 0, readPending: 0 });
    await expect(metadata.read('read', { value: 1 })).resolves.toEqual({ value: 1 });
  } finally {
    await metadata.terminate();
    await Promise.allSettled(reads);
    warning.mockRestore();
  }
});

it('classifies playback reads centrally and reserves capacity independently of workbench reads', async () => {
  const metadata = fixture();
  const ordinary = Array.from({ length: 64 }, () => metadata.read('hold'));
  const playback = Array.from({ length: 16 }, () => metadata.call('hasMedia', { hold: true }));
  try {
    await expect(metadata.call('hasMedia', { hold: true })).rejects.toThrow('METADATA_READ_BUSY');
    await expect(metadata.call('list', { hold: true })).rejects.toThrow('METADATA_READ_BUSY');
    await expect(metadata.call('write', { accepted: true })).resolves.toEqual({ accepted: true });
    expect(metadata.stats()).toMatchObject({ pending: 80, readPending: 80 });
    await metadata.call('release');
    await Promise.all([...ordinary, ...playback]);
    expect(metadata.stats()).toMatchObject({ pending: 0, readPending: 0 });
  } finally {
    await metadata.terminate();
    await Promise.allSettled([...ordinary, ...playback]);
  }
});

it('rejects all accepted requests if the worker exits', async () => {
  const metadata = fixture();
  const reads = [metadata.read('hold'), metadata.call('hold')];
  const results = Promise.allSettled(reads);
  try {
    await expect(metadata.call('exit')).rejects.toThrow('METADATA_WORKER_UNAVAILABLE');
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    await expect(metadata.read('read')).rejects.toThrow('METADATA_WORKER_UNAVAILABLE');
  } finally {
    await metadata.terminate();
  }
});

it('releases admission when a request cannot be cloned', async () => {
  const metadata = fixture();
  try {
    await expect(metadata.read('read', () => undefined)).rejects.toThrow();
    expect(metadata.stats()).toMatchObject({ pending: 0, readPending: 0 });
    await expect(metadata.call('write', 1)).resolves.toBe(1);
  } finally {
    await metadata.terminate();
  }
});

it('preserves startup failure and drains the failed worker', async () => {
  const worker = new Worker(
    `const {parentPort:port}=require('node:worker_threads');port.postMessage({ready:false,error:'SYNTHETIC_START_FAILED'});port.close();`,
    { eval: true },
  );
  const metadata = new Metadata('/unused-synthetic-root', worker);
  await expect(metadata.call('read')).rejects.toThrow('SYNTHETIC_START_FAILED');
  await metadata.terminate();
});

it.each([0, 550])(
  'separates worker execution %sms from the RPC non-execution remainder',
  async (executionMs) => {
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now),
      warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      metadata = fixture();
    const held = metadata.call('hold', { executionMs, privateValue: 'never log request input' });
    try {
      await metadata.call('write');
      now = 700;
      await metadata.call('release');
      await held;
      expect(warning).toHaveBeenCalledTimes(1);
      const diagnostic = JSON.parse(String(warning.mock.calls[0][0])) as Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        event: 'metadata_rpc_slow',
        method: 'hold',
        rpcElapsedMs: 600,
        workerExecutionMs: executionMs,
        rpcNonExecutionMs: 600 - executionMs,
      });
      expect(JSON.stringify(diagnostic)).not.toContain('privateValue');
      expect(JSON.stringify(diagnostic)).not.toContain('never log request input');
      // Another slow reply in the same diagnostic window remains sampled out.
      const second = metadata.call('hold', { executionMs });
      await metadata.call('write');
      now = 1300;
      await metadata.call('release');
      await second;
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      await metadata.terminate();
      clock.mockRestore();
      warning.mockRestore();
    }
  },
);

it('includes worker-local execution timing for success, failure and clean close replies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-metadata-timing-'));
  const worker = new Worker(new URL('./metadata-worker.mjs', import.meta.url), {
    workerData: { root },
    execArgv: [],
  });
  const replies: { id?: number; executionMs?: number }[] = [];
  worker.on('message', (reply: { id?: number; executionMs?: number }) => {
    if (reply.id !== undefined) replies.push(reply);
  });
  const metadata = new Metadata(root, worker);
  try {
    await expect(metadata.call('mediaDeletionJobs')).resolves.toEqual([]);
    await expect(metadata.call('unknownMethod')).rejects.toThrow('UNKNOWN_METADATA_METHOD');
    await metadata.call('close', { clean: true });
    expect(replies).toHaveLength(3);
    for (const reply of replies) {
      expect(reply.executionMs).toEqual(expect.any(Number));
      expect(reply.executionMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(reply.executionMs)).toBe(true);
    }
  } finally {
    await metadata.terminate();
    await rm(root, { recursive: true, force: true });
  }
});
