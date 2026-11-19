import type { MediaTimeRange, SnapshotCell, SnapshotItem } from '@st-vault/api-schema';
import type { RecordingUnit, RecordingUnits } from './recording-units.js';
interface Block {
  cells: number;
  cursor: number;
  seek: [number, string];
}
type LayoutReader = Pick<RecordingUnits, 'page'> & Partial<Pick<RecordingUnits, 'items' | 'get'>>;
interface SnapshotSource {
  reader: LayoutReader;
  close: () => Promise<void>;
}
interface LayoutState {
  subject: string;
  window: MediaTimeRange;
  version: string;
  blocks: Block[];
  anchors: number[];
  seek: [number, string];
  cursor: number;
  cells: number;
  total: number;
  ready: boolean;
  first?: RecordingUnit;
  last?: RecordingUnit;
  touched: number;
  created: number;
  dirty: boolean;
  source: LayoutReader;
  release?: () => Promise<void>;
  opened: boolean;
  active: number;
  retired: boolean;
}
interface LayoutPage {
  cells: SnapshotCell[];
  page: number;
  pages: number;
  pageOffset: number;
  total: number;
  slotCount: number;
  pageAnchors: number[];
  occupiedPages: number[];
  first?: RecordingUnit;
  last?: RecordingUnit;
  items?: SnapshotItem[];
}
/** Sparse bounded index; a key has one owner while asynchronous database reads are in flight. */
export class SnapshotLayoutIndex {
  private readonly entries = new Map<string, LayoutState>();
  private readonly owners = new Map<string, Promise<unknown>>();
  private readonly releases = new Set<Promise<void>>();
  private readonly releaseErrors: unknown[] = [];
  private closing = false;
  private closeWork: Promise<void> | undefined;
  private lastReleaseErrorAt = -Infinity;
  constructor(
    private readonly units: Pick<RecordingUnits, 'page'>,
    private readonly gaps: (from: number, to: number) => number,
    private readonly snapshot?: () => Promise<SnapshotSource>,
  ) {}
  private release(state: LayoutState): void {
    if (!state.retired || state.active || !state.release) return;
    const release = state.release;
    state.release = undefined;
    const work = Promise.resolve()
      .then(release)
      .catch((error: unknown) => {
        if (this.releaseErrors.length < 4) this.releaseErrors.push(error);
        if (Date.now() - this.lastReleaseErrorAt >= 10000) {
          this.lastReleaseErrorAt = Date.now();
          console.error('snapshot_read_release_failed', error);
        }
      });
    this.releases.add(work);
    void work.then(() => this.releases.delete(work));
  }
  private retire(key: string, state: LayoutState): void {
    if (this.entries.get(key) === state) this.entries.delete(key);
    state.retired = true;
    this.release(state);
  }
  expire(): void {
    for (const [key, state] of this.entries)
      if (Date.now() - state.created >= 15000) this.retire(key, state);
  }
  invalidateAll(): void {
    for (const [key, state] of this.entries) this.retire(key, state);
  }
  close(): Promise<void> {
    this.closeWork ??= this.drain();
    return this.closeWork;
  }
  private async drain(): Promise<void> {
    this.closing = true;
    for (const [key, state] of this.entries) this.retire(key, state);
    await Promise.allSettled([...this.owners.values()]);
    await Promise.all([...this.releases]);
    if (this.releaseErrors.length)
      throw new AggregateError(this.releaseErrors, 'SNAPSHOT_RELEASE_FAILED');
  }
  invalidate(subject: string, from: number, to: number, destructive = false): void {
    this.expire();
    for (const [key, state] of this.entries)
      if (state.subject === subject && from < state.window.toMs && to > state.window.fromMs) {
        if (destructive || state.ready) this.retire(key, state);
        else state.dirty = true;
      }
  }
  private key(subject: string, window: MediaTimeRange): string {
    return `${subject}:${window.fromMs}:${window.toMs}`;
  }
  private run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const invoke = () => {
      if (this.closing) throw Error('SNAPSHOT_LAYOUT_CLOSED');
      return action();
    };
    // A failed request must not poison ownership for the next request. The
    // original returned promise still reports that failure to its caller.
    const work = (this.owners.get(key) ?? Promise.resolve()).then(invoke, invoke);
    this.owners.set(key, work);
    const clear = () => {
      if (this.owners.get(key) === work) this.owners.delete(key);
    };
    void work.then(clear, clear);
    return work;
  }
  private current(key: string, state: LayoutState): void {
    if (state.retired || this.entries.get(key) !== state) throw Error('SNAPSHOT_LAYOUT_STALE');
  }
  private async use<T>(key: string, state: LayoutState, action: () => Promise<T>): Promise<T> {
    state.active++;
    try {
      this.current(key, state);
      return await action();
    } catch (error) {
      this.retire(key, state);
      throw error;
    } finally {
      state.active--;
      this.release(state);
    }
  }
  prepare(subject: string, window: MediaTimeRange, version: string): Promise<boolean> {
    const key = this.key(subject, window);
    return this.run(key, async () => {
      this.expire();
      let state = this.entries.get(key);
      if (state?.version !== version) {
        if (!state && this.entries.size >= 4) {
          const oldest = [...this.entries]
            .filter(([, entry]) => entry.ready || Date.now() - entry.touched > 15000)
            .sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!oldest) throw Error('METADATA_READ_BUSY');
          this.retire(oldest[0], oldest[1]);
        }
        if (state) this.retire(key, state);
        state = {
          subject,
          window: { ...window },
          version,
          blocks: [],
          anchors: [],
          seek: [-1, ''],
          cursor: window.fromMs,
          cells: 0,
          total: 0,
          ready: false,
          touched: Date.now(),
          created: Date.now(),
          dirty: false,
          source: this.units,
          opened: !this.snapshot,
          active: 0,
          retired: false,
        };
        // Reserve before opening the snapshot: invalidation during connection
        // acquisition must retire this generation rather than publish it later.
        this.entries.set(key, state);
      }
      const entry = state;
      return this.use(key, entry, async () => {
        if (!entry.opened) {
          const frozen = await this.snapshot!();
          entry.source = frozen.reader;
          entry.release = frozen.close;
          entry.opened = true;
          this.current(key, entry);
        }
        entry.touched = Date.now();
        if (entry.ready) return true;
        const block = {
          cells: entry.cells,
          cursor: entry.cursor,
          seek: [...entry.seek] as [number, string],
        };
        const rows = await entry.source.page(subject, window, entry.seek);
        this.current(key, entry);
        entry.blocks.push(block);
        for (const row of rows) {
          entry.cells += this.gaps(entry.cursor, row.start);
          entry.anchors[Math.floor(entry.cells / 30)] ??= row.start;
          entry.cells++;
          entry.total++;
          entry.first ??= row;
          entry.last = row;
          entry.cursor = Math.max(entry.cursor, row.end);
          entry.seek = [row.start, row.id];
        }
        if (rows.length < 256) {
          if (entry.total)
            entry.cells += Math.min(
              this.gaps(entry.cursor, window.toMs),
              Math.ceil(entry.cells / 30) * 30 - entry.cells,
            );
          entry.ready = true;
        }
        return entry.ready;
      });
    });
  }
  page(
    subject: string,
    window: MediaTimeRange,
    version: string,
    requested: number,
    limit: number,
  ): Promise<LayoutPage> {
    const key = this.key(subject, window);
    return this.run(key, async () => {
      const state = this.entries.get(key);
      if (!state?.ready || state.version !== version) throw Error('SNAPSHOT_LAYOUT_STALE');
      return this.use(key, state, async () => {
        state.touched = Date.now();
        const pages = Math.ceil(state.cells / limit),
          page = Math.min(requested, Math.max(1, pages));
        const offset = (page - 1) * limit,
          end = Math.min(offset + limit, state.cells),
          cells: SnapshotCell[] = [];
        let lo = 0,
          hi = state.blocks.length;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >>> 1;
          if (state.blocks[mid].cells <= offset) lo = mid;
          else hi = mid;
        }
        let { cursor, seek } = state.blocks[lo],
          position = state.blocks[lo].cells;
        const gap = (to: number) => {
          const parts = this.gaps(cursor, to);
          for (let part = 0; part < parts; part++, position++)
            if (position >= offset && position < end)
              cells.push({ index: position, kind: 'gap', fromMs: cursor, toMs: to, part, parts });
        };
        while (position < end) {
          const rows = await state.source.page(subject, window, seek);
          this.current(key, state);
          for (const row of rows) {
            gap(row.start);
            if (position >= offset && position < end)
              cells.push({
                index: position,
                kind: 'unit',
                unitId: row.id,
                fromMs: row.start,
                toMs: row.end,
              });
            position++;
            cursor = Math.max(cursor, row.end);
            seek = [row.start, row.id];
            if (position >= end) break;
          }
          if (rows.length < 256) {
            gap(window.toMs);
            break;
          }
        }
        const items = await state.source.items?.(
          subject,
          cells.flatMap((cell) => (cell.kind === 'unit' ? [cell.unitId!] : [])),
        );
        this.current(key, state);
        const result = {
          cells,
          page,
          pages,
          pageOffset: offset,
          total: state.total,
          slotCount: state.cells,
          pageAnchors: state.anchors,
          occupiedPages: state.anchors.map((_, index) => index + 1),
          first: state.first,
          last: state.last,
          items,
        };
        if (state.dirty) this.retire(key, state);
        return result;
      });
    });
  }
  locate(subject: string, window: MediaTimeRange, unitId: string): Promise<number | null> {
    const key = this.key(subject, window);
    return this.run(key, async () => {
      const state = this.entries.get(key);
      if (!state?.ready) throw Error('SNAPSHOT_LAYOUT_STALE');
      return this.use(key, state, async () => {
        const target = await state.source.get?.(subject, unitId);
        this.current(key, state);
        if (!target || target.start >= window.toMs || target.end <= window.fromMs) return null;
        let lo = 0,
          hi = state.blocks.length;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >>> 1,
            seek = state.blocks[mid].seek;
          if (seek[0] < target.start || (seek[0] === target.start && seek[1] < target.id)) lo = mid;
          else hi = mid;
        }
        const block = state.blocks[lo];
        let position = block.cells,
          cursor = block.cursor;
        const rows = await state.source.page(subject, window, block.seek);
        this.current(key, state);
        for (const row of rows) {
          position += this.gaps(cursor, row.start);
          if (row.id === unitId) return Math.floor(position / 30) + 1;
          position++;
          cursor = Math.max(cursor, row.end);
        }
        return null;
      });
    });
  }
}
