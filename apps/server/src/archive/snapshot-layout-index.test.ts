import { expect, it } from 'vitest';
import {
  recordingGapParts,
  recordingLayout,
} from '../../../../packages/api-schema/src/recording-layout.js';
import { SnapshotLayoutIndex } from './snapshot-layout-index.js';
import type { RecordingUnit } from './recording-units.js';
const makeRows = (count: number): RecordingUnit[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i).padStart(6, '0'),
    subject: 's',
    start: i * 1000,
    end: i * 1000 + 500,
    sample: i * 1000,
    last_start: i * 1000,
    created_revision: i,
    closed: 1,
    deleted: 0,
  }));
const pageOf =
  (rows: RecordingUnit[]) =>
  (_subject: string, _window: unknown, seek: [number, string], limit = 256) =>
    Promise.resolve(
      rows
        .filter((row) => row.start > seek[0] || (row.start === seek[0] && row.id > seek[1]))
        .slice(0, limit),
    );
it('matches every shared compressed-layout cell across block and page boundaries', async () => {
  const rows = makeRows(777);
  let at = 200000;
  for (let i = 0; i < rows.length; i++) {
    at += i % 11 === 0 ? 300000 : i % 7 === 0 ? 90000 : i % 3 === 0 ? 40000 : 1000;
    Object.assign(rows[i], {
      start: at,
      end: at + (i % 13 === 0 ? 200000 : 500),
      sample: at,
      last_start: at,
    });
  }
  let reads = 0;
  const source = {
    page: async (...args: Parameters<ReturnType<typeof pageOf>>) => {
      reads++;
      return await pageOf(rows)(...args);
    },
  };
  const view = { fromMs: 0, toMs: at + 600000 },
    expected = recordingLayout(rows, view),
    index = new SnapshotLayoutIndex(source, recordingGapParts);
  let builds = 0;
  while (!(await index.prepare('s', view, 'v1'))) builds++;
  expect(builds).toBe(3);
  for (const limit of [30, 1000])
    for (let p = 1; p <= Math.ceil(expected.length / limit); p++) {
      const before = reads,
        packet = await index.page('s', view, 'v1', p, limit);
      expect(packet.cells).toEqual(expected.slice((p - 1) * limit, p * limit));
      expect(packet.slotCount).toBe(expected.length);
      expect(reads - before).toBeLessThanOrEqual(Math.ceil((limit + 256) / 256));
    }
  await expect(index.page('s', view, 'v2', 1, 30)).rejects.toThrow('SNAPSHOT_LAYOUT_STALE');
  await index.close();
});
it('omits empty and trailing gap-only pages without losing a partial gap', async () => {
  for (const count of [0, 1, 29, 30, 31]) {
    const rows = makeRows(count),
      window = { fromMs: 0, toMs: 600000 },
      index = new SnapshotLayoutIndex({ page: pageOf(rows) }, recordingGapParts);
    expect(await index.prepare('s', window, 'v')).toBe(true);
    expect((await index.page('s', window, 'v', 1, 1000)).cells).toEqual(
      recordingLayout(rows, window),
    );
    await index.close();
  }
});
it('finishes a frozen cold read despite appends, while destructive changes immediately retire it', async () => {
  const rows = makeRows(300);
  let opened = 0,
    closed = 0;
  const index = new SnapshotLayoutIndex({ page: pageOf(rows) }, recordingGapParts, () => {
    opened++;
    const frozen = rows.map((row) => ({ ...row }));
    return Promise.resolve({
      reader: {
        page: pageOf(frozen),
        items: () => Promise.resolve([]),
        get: (_s: string, id: string) => Promise.resolve(frozen.find((row) => row.id === id)),
      },
      close: () => {
        closed++;
        return Promise.resolve();
      },
    });
  });
  const window = { fromMs: 0, toMs: 400000 };
  expect(await index.prepare('s', window, 'v')).toBe(false);
  index.invalidate('s', 600000, 601000);
  expect(opened).toBe(1);
  rows.push({ ...rows[299], id: '000300', start: 300000, end: 300500 });
  index.invalidate('s', 300000, 300500);
  expect(await index.prepare('s', window, 'v')).toBe(true);
  expect((await index.page('s', window, 'v', 1, 30)).total).toBe(300);
  expect(closed).toBe(1);
  while (!(await index.prepare('s', window, 'v'))) {
    /* bounded cold preparation */
  }
  expect((await index.page('s', window, 'v', 1, 30)).total).toBe(301);
  index.invalidate('s', 0, 1000, true);
  await expect(index.page('s', window, 'v', 1, 30)).rejects.toThrow('SNAPSHOT_LAYOUT_STALE');
  await index.close();
  expect(closed).toBe(2);
});
it('locates an explicit unit among pages with identical timestamp anchors', async () => {
  const rows = makeRows(90).map((row) => ({
    ...row,
    start: 1000,
    end: 2000,
    sample: 1000,
    last_start: 1000,
  }));
  const source = {
    page: pageOf(rows),
    get: (_subject: string, id: string) => Promise.resolve(rows.find((row) => row.id === id)),
  };
  const index = new SnapshotLayoutIndex(source, recordingGapParts),
    window = { fromMs: 0, toMs: 3000 };
  expect(await index.prepare('s', window, 'v')).toBe(true);
  expect(await index.locate('s', window, '000040')).toBe(2);
  expect(await index.locate('s', window, '000080')).toBe(3);
  await index.close();
});
it('serializes concurrent cold preparation without reading the same block twice', async () => {
  const rows = makeRows(600);
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const source = {
    page: async (...args: Parameters<ReturnType<typeof pageOf>>) => {
      calls++;
      if (calls === 1) {
        entered();
        await gate;
      }
      return await pageOf(rows)(...args);
    },
  };
  const index = new SnapshotLayoutIndex(source, recordingGapParts),
    window = { fromMs: 0, toMs: 600000 };
  const first = index.prepare('s', window, 'v');
  await ready;
  const second = index.prepare('s', window, 'v');
  await Promise.resolve();
  expect(calls).toBe(1);
  release();
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(await index.prepare('s', window, 'v')).toBe(true);
  expect((await index.page('s', window, 'v', 1, 30)).total).toBe(600);
  await index.close();
});
it('retires an in-flight snapshot immediately and releases it after its reader finishes', async () => {
  let release!: () => void,
    entered!: () => void,
    closed = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const rows = makeRows(1),
    index = new SnapshotLayoutIndex({ page: pageOf(rows) }, recordingGapParts, () =>
      Promise.resolve({
        reader: {
          page: async (...args: Parameters<ReturnType<typeof pageOf>>) => {
            entered();
            await gate;
            return await pageOf(rows)(...args);
          },
          items: () => Promise.resolve([]),
          get: () => Promise.resolve(undefined),
        },
        close: () => {
          closed++;
          return Promise.resolve();
        },
      }),
    );
  const window = { fromMs: 0, toMs: 1000 },
    preparing = index.prepare('s', window, 'v');
  await ready;
  index.invalidate('s', 0, 1000, true);
  expect(closed).toBe(0);
  release();
  await expect(preparing).rejects.toThrow('SNAPSHOT_LAYOUT_STALE');
  await index.close();
  expect(closed).toBe(1);
});
it('does not publish a snapshot whose creation was invalidated before it resolved', async () => {
  let release!: () => void,
    entered!: () => void,
    closed = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const rows = makeRows(1),
    index = new SnapshotLayoutIndex({ page: pageOf(rows) }, recordingGapParts, async () => {
      entered();
      await gate;
      return {
        reader: {
          page: pageOf(rows),
          items: () => Promise.resolve([]),
          get: () => Promise.resolve(undefined),
        },
        close: () => {
          closed++;
          return Promise.resolve();
        },
      };
    });
  const window = { fromMs: 0, toMs: 1000 },
    preparing = index.prepare('s', window, 'v');
  await ready;
  index.invalidate('s', 0, 1000, true);
  release();
  await expect(preparing).rejects.toThrow('SNAPSHOT_LAYOUT_STALE');
  await index.close();
  expect(closed).toBe(1);
});
