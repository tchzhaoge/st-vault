import { recordingLayout } from '../../../build/packages/api-schema/src/recording-layout.js';

/** Synthetic units use the same shared layout rule as metadata-worker. No media is fetched. */
export function unitPacket(template, items, range, { page = 1, limit = 30, follow = false } = {}) {
  let rows = items.filter((item) => item.slotFromMs < range.toMs && item.slotToMs > range.fromMs);
  const cells = recordingLayout(
    rows.map((item) => ({
      id: item.unitId,
      start: item.slotFromMs,
      end: item.slotToMs,
      closed: item.open === true ? 0 : 1,
    })),
    range,
    follow,
  );
  if (follow) {
    const retained = new Set(
      cells.filter((cell) => cell.kind === 'unit').map((cell) => cell.unitId),
    );
    rows = rows.filter((row) => retained.has(row.unitId));
  }
  const offset = (p, size) => (p - 1) * size;
  const pages = Math.ceil(cells.length / limit);
  const current = page === 'last' ? Math.max(1, pages) : Math.min(page, Math.max(1, pages));
  const pageOffset = offset(current, limit);
  const selected = cells.slice(pageOffset, pageOffset + limit);
  const byId = new Map(rows.map((item) => [item.unitId, item]));
  const pageAnchors = Array.from({ length: Math.ceil(cells.length / 30) }, (_, index) => {
    const start = offset(index + 1, 30);
    return cells.slice(start, start + 30).find((cell) => cell.kind === 'unit').fromMs;
  });
  return {
    ...template,
    displayWindow: {
      fromMs: follow && rows.length ? rows[0].slotFromMs : range.fromMs,
      toMs: range.toMs,
    },
    session:
      template.session && rows.length
        ? {
            ...template.session,
            selectionFromMs: rows[0].slotFromMs,
            selectionToMs: rows.at(-1).slotToMs,
          }
        : template.session,
    total: rows.length,
    page: current,
    pages,
    limit,
    pageOffset,
    slotCount: cells.length,
    pageAnchors,
    occupiedPages: pageAnchors.map((_, index) => index + 1),
    cells: selected,
    items: selected
      .filter((cell) => cell.kind === 'unit')
      .map((cell) => ({ ...byId.get(cell.unitId), gridIndex: cell.index })),
  };
}

export function unitRequest(route) {
  const params = new URL(route.request().url()).searchParams;
  return {
    range: { fromMs: Number(params.get('from')), toMs: Number(params.get('to')) },
    options: {
      page: params.get('page') === 'last' ? 'last' : Number(params.get('page') || 1),
      limit: Number(params.get('limit') || 30),
      follow: params.get('follow') === '1',
    },
  };
}

export const unitId = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
