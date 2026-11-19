import { libraryIndexPath } from '../library/paths.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTestDatabase } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openArchive } from './index.js';
import type { ArchiveHandle } from './index.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

const subject = { id: 'stripchat:123', providerId: 123, handle: 'fixture' };
let root: string, archive: ArchiveHandle;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'stv-snapshot-pages-'));
  archive = await openArchive({ root });
  await archive.upsertSubjects([subject]);
});
afterEach(async () => {
  await archive.close();
  await rm(root, { recursive: true, force: true });
});
const commit = (sequence: number, at: number, durationSeconds = 1, epoch = 'first') =>
  archive.commit({
    subjectId: subject.id,
    sourceEpoch: epoch,
    sourceSequence: String(sequence),
    init: null,
    bytes: new Uint8Array([1, 2, 3]),
    durationSeconds,
    wallStartMs: at,
    timeBasis: 'source-pdt',
    uncertaintyMs: null,
    discontinuity: false,
  });

describe('broadcast snapshot metadata', () => {
  it('publishes growing-unit presentation without inventing a waiting tile or widening media bounds', async () => {
    await commit(1, 1000, 4);
    const first = await archive.snapshotPages!(
      subject.id,
      20000,
      1,
      30,
      { fromMs: 0, toMs: 20000 },
      true,
    );
    expect(first).toMatchObject({ total: 1, slotCount: 1 });
    expect(first.items[0]).toMatchObject({ open: true, slotFromMs: 1000, slotToMs: 5000 });
    const rollover = await archive.snapshotPages!(
      subject.id,
      65000,
      1,
      30,
      { fromMs: 0, toMs: 65000 },
      true,
    );
    expect(rollover.cells?.at(-1)).toMatchObject({ kind: 'pending', fromMs: 60000 });
    await commit(2, 61000, 2);
    const next = await archive.snapshotPages!(
      subject.id,
      65000,
      1,
      30,
      { fromMs: 0, toMs: 65000 },
      true,
    );
    expect(next.cells?.map((cell) => cell.kind)).toEqual(['unit', 'unit']);
    expect(next.items[0]).toMatchObject({ open: false, slotToMs: 5000 });
    expect(next.items[1]).toMatchObject({ open: true, slotToMs: 63000 });
  });
  it('contracts live boundaries to one page without changing whole units or replay pagination', async () => {
    for (let i = 0; i < 48; i++) await commit(i, 1000 + i * 60000, 1, `restart-${i}`);
    const window = { fromMs: 0, toMs: 48 * 60000 + 1000 };
    const live = await archive.snapshotPages!(subject.id, window.toMs - 1, 1, 30, window, true);
    expect(live).toMatchObject({ page: 1, pages: 1, occupiedPages: [1], slotCount: 30, total: 29 });
    expect(live.items).toHaveLength(29);
    expect(live.session?.selectionFromMs).toBe(live.items[0].slotFromMs);
    expect(live.displayWindow).toEqual({ fromMs: live.items[0].slotFromMs, toMs: window.toMs });
    const full = await archive.snapshotPages!(subject.id, window.toMs - 1, 99, 120, window, true);
    expect(full.items).toEqual(live.items);
    const replay = await archive.snapshotPages!(subject.id, window.toMs - 1, 2, 30, window);
    expect(replay).toMatchObject({ total: 48, pages: 2 });
    expect(replay.items.at(-1)?.unitId).toBe(live.items.at(-1)?.unitId);
  });
  it('does not populate a selection that has no overlapping recording unit', async () => {
    await commit(1, 1000, 2);
    expect(
      await archive.snapshotPages!(subject.id, 1000, 1, 30, { fromMs: 40000, toMs: 50000 }),
    ).toMatchObject({ total: 0, items: [], occupiedPages: [] });
  });
  it('keeps one complete fragment identity across live, clipped replay and advancing tail queries', async () => {
    await commit(1, 1000, 180);
    const live = await archive.snapshotPages!(subject.id, 100000, 1, 30, {
      fromMs: 1000,
      toMs: 170000,
    });
    const replay = await archive.snapshotPages!(subject.id, 100000, 1, 30, {
      fromMs: 15000,
      toMs: 165000,
    });
    expect(live.items.map((item) => [item.slotFromMs, item.slotToMs])).toEqual([[1000, 181000]]);
    expect(replay.items.map((item) => [item.slotFromMs, item.slotToMs])).toEqual(
      live.items.map((item) => [item.slotFromMs, item.slotToMs]),
    );
    expect(replay.items[0].atMs).toBe(1000);
    expect(replay.items[0].url).toBe(live.items[0].url);
    expect(replay.items[0].unitId).toBe(live.items[0].unitId);
    const canonical = await archive.snapshotUnit!(subject.id, 65000);
    expect(canonical).toMatchObject({ atMs: 1000, slotFromMs: 1000, slotToMs: 181000 });
  });
  it('keeps a long source fragment whole instead of synthesizing minute screenshots', async () => {
    await commit(1, 1000, 1900);
    const range = { fromMs: 30000, toMs: 1830000 };
    const first = await archive.snapshotPages!(subject.id, 30000, 1, 30, range);
    const second = await archive.snapshotPages!(subject.id, 30000, 2, 30, range);
    expect(first).toMatchObject({ total: 1, pages: 1, occupiedPages: [1] });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ atMs: 1000, slotFromMs: 1000, slotToMs: 1901000 });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toEqual(first.items[0]);
  });
  it('compresses long holes to finite placeholders without creating empty pages', async () => {
    await commit(1, 60000, 2);
    await commit(2, 5 * 1800000 + 120000, 2);
    const range = { fromMs: 0, toMs: 6 * 1800000 };
    const first = await archive.snapshotPages!(subject.id, 60000, 1, 30, range);
    expect(first).toMatchObject({ total: 2, occupiedPages: [1], slotCount: 9 });
    const scrolling = await archive.snapshotPages!(subject.id, 60000, 1, 120, range);
    expect(scrolling.occupiedPages).toEqual(first.occupiedPages);
    const last = await archive.snapshotPages!(subject.id, 60000, 6, 30, range);
    expect(last.items.map((item) => item.slotFromMs)).toEqual([60000, 5 * 1800000 + 120000]);
    expect(last.cells?.filter((cell) => cell.kind === 'gap')).toHaveLength(7);
  });
  it('includes whole overlapping units so selecting every screenshot cannot leave partial footage behind', async () => {
    for (let i = 0; i < 100; i++) await commit(i, 1000 + i * 2000, 2);
    const window = { fromMs: 70000, toMs: 190000 };
    const page = await archive.snapshotPages!(subject.id, 70000, 1, 30, window);
    expect(page.items.map((item) => item.slotFromMs)).toEqual([61000, 121000, 181000]);
    expect(page.items[0].atMs).toBe(61000);
    const plan = await archive.planDeletion!(
      subject.id,
      page.items.map((item) => ({
        fromMs: Math.max(window.fromMs, item.slotFromMs),
        toMs: Math.min(window.toMs, item.slotToMs),
      })),
    );
    await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision);
    expect((await archive.snapshotPages!(subject.id, 70000, 1, 30, window)).items).toEqual([]);
    await archive.resumeDeletions!();
  }, 10000);
  it('keeps surviving unit sample identities when deleting the first recording unit', async () => {
    await commit(1, 1000, 60);
    await commit(2, 65000, 120);
    const window = { fromMs: 1000, toMs: 185000 };
    const before = await archive.snapshotPages!(subject.id, 65000, 1, 30, window);
    const plan = await archive.planDeletion!(subject.id, [{ fromMs: 1000, toMs: 61000 }]);
    await archive.deleteSelection!(subject.id, plan.id, plan.personalRevision);
    // Contraction changes layout positions, never the remaining unit identity
    // or its representative image URL.
    const after = await archive.snapshotPages!(subject.id, 65000, 1, 30, window);
    expect(after.deletionRevision).toBeGreaterThan(before.deletionRevision);
    expect(after.items[0]).toMatchObject({ atMs: 65000, slotFromMs: 65000, slotToMs: 185000 });
    expect(after.items).toEqual(
      before.items.filter((item) => item.atMs >= 65000).map((item) => ({ ...item, gridIndex: 1 })),
    );
    await archive.resumeDeletions!();
  });
  it('keeps only finite head and tail placeholders around sparse footage', async () => {
    await commit(1, 35 * 60000, 1);
    const window = { fromMs: 0, toMs: 60 * 60000 };
    const first = await archive.snapshotPages!(subject.id, 35 * 60000, 1, 30, window);
    expect(first).toMatchObject({ total: 1, page: 1, pages: 1, slotCount: 7 });
    const second = await archive.snapshotPages!(subject.id, 35 * 60000, 2, 30, window);
    expect(second.items.map((item) => item.atMs)).toEqual([35 * 60000]);
  });
  it('bounds counts and pages to intersecting units and follows additions without resampling', async () => {
    await commit(1, 1000, 2);
    await commit(2, 61000, 2);
    const first = await archive.snapshotPages!(subject.id, 61000, 99, 30, {
      fromMs: 60000,
      toMs: 120000,
    });
    expect(first).toMatchObject({ total: 1, page: 1, pages: 1 });
    expect(first.items.map((item) => item.atMs)).toEqual([61000]);
    const shifted = await archive.snapshotPages!(subject.id, 61000, 1, 30, {
      fromMs: 60001,
      toMs: 120001,
    });
    // Moving a view edge cannot change a favorite's unit identity.
    expect(shifted.items[0].atMs).toBe(first.items[0].atMs);
    expect(shifted.items[0].slotFromMs).toBe(61000);
    await commit(3, 121000, 2);
    const next = await archive.snapshotPages!(subject.id, 121000, 1, 30, {
      fromMs: 120000,
      toMs: 180000,
    });
    expect(next.items.map((item) => item.atMs)).toEqual([121000]);
    expect(
      await archive.snapshotPages!(subject.id, 61000, 1, 30, { fromMs: 60000, toMs: 61000 }),
    ).toMatchObject({ total: 0, items: [] });
    const all = await archive.snapshotPages!(subject.id, 121000, 99, 1, {
      fromMs: 0,
      toMs: 180000,
    });
    expect(all).toMatchObject({ total: 3, page: 3, pages: 3 });
  });
  it('uses recorded footage inside a conflicting OFFLINE interval without merging neighboring sessions', async () => {
    await archive.setObservation(subject.id, 'PUBLIC', 1000, 600000);
    await commit(1, 2000);
    await archive.setObservation(subject.id, 'OFFLINE', 62000, 600000);
    await commit(2, 63000, 1);
    await commit(3, 180000, 10);
    await archive.setObservation(subject.id, 'PUBLIC', 182000, 600000);
    await commit(4, 183000, 1, 'next-session');
    const conflict = await archive.snapshotPages!(subject.id, 63500, 1, 30, {
      fromMs: 63000,
      toMs: 182000,
    });
    expect(conflict).toMatchObject({
      total: 2,
      session: { fromMs: 63000, toMs: 182000, startBasis: 'recorded-media', ended: true },
    });
    expect(conflict.items.map((item) => item.atMs)).toEqual([63000, 180000]);
    expect(conflict.items[1].slotToMs).toBe(190000);
    expect(conflict.items[1].unitId).toBeTruthy();
    const previous = await archive.snapshotPages!(subject.id, 2000, 1, 30, {
        fromMs: 0,
        toMs: 62000,
      }),
      next = await archive.snapshotPages!(subject.id, 183000, 1, 30, {
        fromMs: 182000,
        toMs: 243000,
      });
    expect(previous).toMatchObject({ total: 1, session: { toMs: 62000, ended: true } });
    expect(next).toMatchObject({
      total: 1,
      session: { fromMs: 182000, startBasis: 'observed-online', ended: false },
    });
    expect(next.items[0].atMs).toBe(180000);
    await archive.deleteRange(subject.id, 63000, 182000);
    expect(
      await archive.snapshotPages!(subject.id, 63500, 1, 30, { fromMs: 63000, toMs: 182000 }),
    ).toMatchObject({
      total: 0,
      session: null,
    });
  });

  it('retains the observed online start when recording begins later', async () => {
    await archive.setObservation(subject.id, 'OFFLINE', 1000, 600000);
    await archive.setObservation(subject.id, 'PUBLIC', 2000, 600000);
    await commit(1, 182500);
    const result = await archive.snapshotPages!(subject.id, 182500, 1, 30, {
      fromMs: 2000,
      toMs: 242000,
    });
    expect(result).toMatchObject({
      total: 1,
      session: { fromMs: 2000, startBasis: 'observed-online', ended: false },
    });
    expect(result.items[0]).toMatchObject({ atMs: 182500, slotFromMs: 182500, slotToMs: 183500 });
  });

  it('keeps an expired online lease within the session and returns no session before any recorded media', async () => {
    await archive.setObservation(subject.id, 'PUBLIC', 1000, 600000);
    expect(
      await archive.snapshotPages!(subject.id, 2000, 1, 30, { fromMs: 0, toMs: 62000 }),
    ).toMatchObject({
      session: null,
      total: 0,
      items: [],
    });
    await commit(1, 2000);
    await archive.setObservation(subject.id, 'PRIVATE', 900000, 600000);
    await commit(2, 901000, 1, 'new-quality');
    expect(
      await archive.snapshotPages!(subject.id, 901000, 1, 30, { fromMs: 2000, toMs: 962000 }),
    ).toMatchObject({
      total: 2,
      session: { fromMs: 2000, ended: false, startBasis: 'recorded-media' },
    });
    await expect(archive.setObservation(subject.id, 'PUBLIC', 1000000, 600001)).rejects.toThrow(
      'INVALID_OBSERVATION',
    );
  });
  it('retains observed session context while representing short holes and epoch switches by unit cells', async () => {
    await archive.setObservation(subject.id, 'OFFLINE', 1000, 1000);
    await archive.setObservation(subject.id, 'PUBLIC', 2000, 60000);
    await archive.setObservation(subject.id, 'PRIVATE', 62000, 60000);
    await archive.setObservation(subject.id, 'PUBLIC', 122000, 60000);
    for (let i = 0; i < 32; i++)
      await commit(i, 2500 + i * 120000, 1, i > 15 ? 'quality-switch' : 'first');
    await archive.setObservation(subject.id, 'OFFLINE', 4000000, 60000);
    const first = await archive.snapshotPages!(subject.id, 130000, 1, 30, {
      fromMs: 2000,
      toMs: 4000000,
    });
    expect(first).toMatchObject({
      total: 32,
      page: 1,
      pages: 3,
      session: { fromMs: 2000, toMs: 4000000, startBasis: 'observed-online' },
    });
    expect(first.items).toHaveLength(15);
    expect(first.items[1]).toMatchObject({ atMs: 122500, slotFromMs: 122500, slotToMs: 123500 });
    const middle = await archive.snapshotPages!(subject.id, 130000, 2, 30, {
      fromMs: 2000,
      toMs: 4000000,
    });
    expect(middle.items).toHaveLength(15);
    const last = await archive.snapshotPages!(subject.id, 130000, 3, 30, {
      fromMs: 2000,
      toMs: 4000000,
    });
    expect(last.items.map((item) => item.atMs)).toEqual([3602500, 3722500]);
    const scrolling = await archive.snapshotPages!(subject.id, 130000, 1, 60, {
      fromMs: 2000,
      toMs: 4000000,
    });
    expect(scrolling.items).toHaveLength(30);
    expect(scrolling.items).toEqual([...first.items, ...middle.items]);
    expect(
      (await archive.snapshotPages!(subject.id, 4000010, 1, 30, { fromMs: 4000000, toMs: 4060000 }))
        .session,
    ).toBeNull();
  });

  it('counts an overlapping unit once, excludes previous sessions, and refreshes after deletion', async () => {
    await commit(1, 1000);
    await archive.setObservation(subject.id, 'OFFLINE', 10000, 1000);
    await commit(2, 123456, 61);
    const page = await archive.snapshotPages!(subject.id, 150000, 1, 30, {
      fromMs: 10000,
      toMs: 245000,
    });
    expect(page).toMatchObject({
      total: 1,
      session: { fromMs: 123456, startBasis: 'recorded-media' },
    });
    expect(page.items.map((item) => item.atMs)).toEqual([123456]);
    await archive.deleteRange(subject.id, 123456, 184456);
    expect(
      await archive.snapshotPages!(subject.id, 150000, 1, 30, { fromMs: 10000, toMs: 245000 }),
    ).toMatchObject({
      total: 0,
      session: null,
      items: [],
    });
  });

  it('clamps an expired last page', async () => {
    for (let i = 0; i < 40; i++) await commit(i, 1001 + i * 120000);
    expect(
      await archive.snapshotPages!(subject.id, 1001, 99, 30, { fromMs: 1000, toMs: 5000000 }),
    ).toMatchObject({
      total: 40,
      page: 3,
      pages: 3,
    });
  });

  it('rebuilds a missing derived index without modifying settings', async () => {
    await commit(1, 123456, 61);
    await archive.setSetting('password_hash', 'synthetic-only');
    await archive.close();
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      await db.exec(`DELETE FROM unit_segments; DELETE FROM recording_units;
        UPDATE unit_index SET revision=-1,segment='',ready=0 WHERE id=1;`);
    } finally {
      await db.close();
    }
    archive = await openArchive({ root });
    expect(
      (await archive.snapshotPages!(subject.id, 150000, 1, 30, { fromMs: 10000, toMs: 245000 }))
        .total,
    ).toBe(1);
    expect(await archive.getSetting('password_hash')).toBe('synthetic-only');
  });

  it('does not resample stable unit images when coverage summaries are rebuilt', async () => {
    await commit(1, 123456, 1);
    const before = await archive.snapshotPages!(subject.id, 150000, 1, 30, {
      fromMs: 10000,
      toMs: 245000,
    });
    await archive.close();
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      // Coverage is a derived timeline projection. Its row shape and revision
      // must not serve as the screenshot's identity or sampling origin.
      await db
        .prepare('UPDATE coverage_minutes SET spans=?,starts=?,ends=? WHERE subject=?')
        .run('[[4456,5456]]', '[4456]', '[5456]', subject.id);
      await db.exec('UPDATE counters SET revision=revision+1 WHERE id=1');
    } finally {
      await db.close();
    }
    archive = await openArchive({ root });
    const result = await archive.snapshotPages!(subject.id, 150000, 1, 30, {
      fromMs: 10000,
      toMs: 245000,
    });
    expect(result.items).toEqual(before.items);
  });
});
