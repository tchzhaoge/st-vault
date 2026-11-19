import { expect, it } from 'vitest';
import { recordingLayout } from './recording-layout.js';
it('preserves limited gaps, compresses long gaps and never generates empty navigation pages', () => {
  const units = [
    { id: 'a', start: 60000, end: 120000 },
    { id: 'b', start: 240000, end: 300000 },
    { id: 'c', start: 1800000, end: 1860000 },
  ];
  const cells = recordingLayout(units, { fromMs: 0, toMs: 1920000 });
  expect(cells.filter((c) => c.kind === 'unit').map((c) => c.unitId)).toEqual(['a', 'b', 'c']);
  expect(cells.filter((c) => c.kind === 'gap')).toHaveLength(7);
  expect(cells.filter((c) => c.fromMs === 300000)).toHaveLength(3);
  expect(recordingLayout([], { fromMs: 0, toMs: 86400000 })).toEqual([]);
});
it('does not create a pending cell beyond an outward-snapped recording end', () => {
  const units = [{ id: 'u', start: 58000, end: 62000 }];
  expect(recordingLayout(units, { fromMs: 60000, toMs: 61000 }, true)).toEqual([
    { index: 0, kind: 'unit', unitId: 'u', fromMs: 58000, toMs: 62000 },
  ]);
});
it('does not turn the growing tail of an open unit into a second pending cell', () => {
  const unit = { id: 'open', start: 1000, end: 5000, closed: 0 };
  const normal = recordingLayout([unit], { fromMs: 0, toMs: 20000 }, true);
  expect(normal).toEqual([{ index: 0, kind: 'unit', unitId: 'open', fromMs: 1000, toMs: 5000 }]);
  const rollover = recordingLayout([unit], { fromMs: 0, toMs: 65000 }, true);
  expect(rollover.at(-1)).toMatchObject({ kind: 'pending', fromMs: 60000, toMs: 65000 });
  const closedUnit = { ...unit, closed: 1 };
  expect(recordingLayout([closedUnit], { fromMs: 0, toMs: 20000 }, true).at(-1)).toMatchObject({
    kind: 'pending',
    fromMs: 5000,
  });
  expect(recordingLayout([unit], { fromMs: 0, toMs: 20000 }).at(-1)?.kind).toBe('unit');
});
it('keeps live units and bounded gaps within one 30-cell page, starting at a complete unit', () => {
  const units = Array.from({ length: 45 }, (_, i) => ({
    id: `u${i}`,
    start: i * 2000,
    end: i * 2000 + 1000,
  }));
  const cells = recordingLayout(units, { fromMs: 0, toMs: 92000 }, true);
  expect(cells).toHaveLength(30);
  expect(cells[0]).toMatchObject({ index: 0, kind: 'unit', unitId: 'u16', fromMs: 32000 });
  expect(cells.at(-1)?.kind).toBe('pending');
  expect(recordingLayout(units, { fromMs: 0, toMs: 92000 }).length).toBe(45);
});
