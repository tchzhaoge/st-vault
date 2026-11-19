import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import type { CoverageResponse, StatusHistoryResponse } from '@st-vault/api-schema';
import { openArchive } from '../archive/index.js';
import { registerWorkbench } from './workbench.js';
import { registerEvents } from './events.js';
it('keeps complete Shanghai calendar windows, including pre-deployment midnight and future empty days', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-calendar-')),
    archive = await openArchive({ root }),
    app = Fastify();
  const day = 86400000,
    start = Math.floor((Date.now() + 8 * 3600000) / day) * day - 8 * 3600000;
  try {
    await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'synthetic' }]);
    await archive.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'calendar',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: start + 1000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    registerWorkbench(app, archive);
    registerEvents(app, archive);
    // A seven-calendar-day view can span 169 actual hours at DST fall-back.
    for (const days of [1, 2, 3, 7, 7 + 1 / 24]) {
      const to = start + days * day,
        response = await app.inject(
          '/api/workbench?ids=stripchat:1&from=' + start + '&to=' + to + '&buckets=24',
        );
      expect(response.statusCode).toBe(200);
      const row = response.json<{
        rows: { coverage: CoverageResponse; status: StatusHistoryResponse }[];
      }>().rows[0];
      expect(row.coverage.fromMs).toBe(start);
      expect(row.coverage.toMs).toBe(to);
      expect(row.coverage.buckets.reduce((sum, b) => sum + b.coveredMs, 0)).toBe(1000);
      expect(row.status.fromMs).toBe(start);
      expect(row.status.toMs).toBe(to);
      expect((await app.inject('/api/events/runs?from=' + start + '&to=' + to)).statusCode).toBe(
        200,
      );
    }
    const from = start + 7 * day,
      to = from + 7 * day,
      response = await app.inject(
        '/api/workbench?ids=stripchat:1&from=' + from + '&to=' + to + '&buckets=24',
      );
    expect(response.statusCode).toBe(200);
    const row = response.json<{
      rows: { coverage: CoverageResponse; status: StatusHistoryResponse }[];
    }>().rows[0];
    expect(row.coverage.buckets).toEqual([]);
    expect(row.status.buckets.reduce((sum, b) => sum + b.durationsMs.PUBLIC, 0)).toBe(0);
    expect(row.status.toMs).toBe(to);
  } finally {
    await app.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
