import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
it.each([
  'favorite-token',
  'remove-favorite',
  'unit-preview',
  'token-preview',
  'confirm-delete',
] as const)(
  'drains an already admitted %s across graceful close without re-entering public admission',
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-admitted-media-'));
    let archive = await openArchive({ root });
    try {
      await archive.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'admitted' }]);
      const ids: string[] = [];
      for (const minute of [1, 2])
        ids.push(
          (
            await archive.commit({
              subjectId: 'stripchat:1',
              sourceEpoch: 'e',
              sourceSequence: String(minute),
              init: null,
              bytes: new Uint8Array([1]),
              durationSeconds: 2,
              wallStartMs: minute * 60000,
              timeBasis: 'source-pdt',
              uncertaintyMs: 0,
              discontinuity: false,
            })
          ).id,
        );
      if (mode === 'remove-favorite')
        await archive.unitFavorites!('stripchat:1', [ids[0]], true, 0);
      const selection = await archive.prepareMediaSelection!(
        'stripchat:1',
        { fromMs: 0, toMs: 180000 },
        'all',
      );
      const preview =
        mode === 'confirm-delete' ? await archive.planUnitDeletion!('stripchat:1', [ids[0]]) : null;
      const actions: Record<typeof mode, () => Promise<unknown>> = {
        'favorite-token': () =>
          archive.favoriteMediaSelection!(
            'stripchat:1',
            selection.id,
            true,
            selection.personalRevision,
            { excludeUnitIds: [ids[1]] },
          ),
        'remove-favorite': () => archive.removeFavorite(ids[0]),
        'unit-preview': () => archive.planUnitDeletion!('stripchat:1', [ids[0]]),
        'token-preview': () =>
          archive.planMediaSelectionDeletion!('stripchat:1', selection.id, {
            excludeUnitIds: [ids[1]],
          }),
        'confirm-delete': () =>
          archive.deleteSelection!('stripchat:1', preview!.id, preview!.personalRevision),
      };
      const operation = actions[mode](),
        closing = archive.close();
      const result = await operation;
      await closing;
      archive = await openArchive({ root });
      if (mode === 'favorite-token')
        expect(
          (await archive.personal('stripchat:1', 0, 180000)).favorites.map((x) => x.id),
        ).toEqual([ids[0]]);
      if (mode === 'remove-favorite')
        expect((await archive.personal('stripchat:1', 0, 180000)).favorites).toEqual([]);
      if (mode === 'unit-preview' || mode === 'token-preview')
        expect(result).toMatchObject({ total: 1 });
      if (mode === 'confirm-delete')
        expect((await archive.deletionJobs!()).some((job) => job.id === preview!.id)).toBe(true);
    } finally {
      await archive.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
