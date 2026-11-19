import { expect, it } from 'vitest';
import type { Subject } from '@st-vault/api-schema';
import { reconcileSubjects, subjectCounts, visibleSubjects } from './subjects';
it('reuses unchanged subject identities but preserves field, name and order changes', () => {
  const first = { id: '1', handle: 'A', formerNames: ['Old'], providerStatus: 'PUBLIC' } as Subject;
  const second = { id: '2', handle: 'B', providerStatus: 'OFFLINE' } as Subject;
  const previous = [first, second];
  expect(reconcileSubjects(previous, [{ ...first, formerNames: ['Old'] }, { ...second }])).toBe(
    previous,
  );
  const changed = reconcileSubjects(previous, [{ ...second }, { ...first, autoRecord: true }]);
  expect(changed[0]).toBe(second);
  expect(changed[1]).not.toBe(first);
  expect(changed[1].autoRecord).toBe(true);
  expect(reconcileSubjects(previous, [{ ...first, formerNames: ['Other'] }])[0]).not.toBe(first);
  expect(reconcileSubjects(previous, [{ ...first, formerNames: undefined }])[0]).not.toBe(first);
});
it('keeps confirmed online membership through expired or failed polls, until confirmed offline', () => {
  const rows = [
    { id: '1', handle: 'A', providerStatus: 'UNKNOWN', lastKnownStatus: 'PUBLIC' },
    { id: '2', handle: 'B', providerStatus: 'UNKNOWN', lastKnownStatus: 'PRIVATE' },
    { id: '3', handle: 'C', providerStatus: 'OFFLINE', lastKnownStatus: 'PUBLIC' },
    { id: '4', handle: 'D', providerStatus: 'UNKNOWN' },
    { id: '5', handle: 'E', providerStatus: 'UNKNOWN', lastKnownStatus: 'PUBLIC', archived: true },
  ] as Subject[];
  expect(subjectCounts(rows)).toEqual({ ONLINE: 2, OFFLINE: 2, ARCHIVED: 1 });
  expect(visibleSubjects(rows, 'ONLINE').map((row) => row.id)).toEqual(['1', '2']);
});
it('partitions online, offline and archived without duplicates and counts the same membership', () => {
  const subjects = [
    { id: '1', handle: 'Z', providerStatus: 'OFFLINE' },
    { id: '2', handle: 'A', providerStatus: 'UNKNOWN' },
    { id: '3', handle: 'Model 10', providerStatus: 'PUBLIC' },
    { id: '4', handle: 'Model 2', providerStatus: 'PUBLIC', monitorEnabled: false },
    { id: '5', handle: 'B', providerStatus: 'PRIVATE' },
    { id: '6', handle: 'Archived live', providerStatus: 'PUBLIC', archived: true },
    { id: '7', handle: 'Archived offline', providerStatus: 'OFFLINE', archived: true },
  ] as Subject[];
  expect(subjectCounts(subjects)).toEqual({ ONLINE: 3, OFFLINE: 2, ARCHIVED: 2 });
  expect(visibleSubjects(subjects, 'ONLINE').map((subject) => subject.id)).toEqual(['4', '3', '5']);
  expect(subjects.map((subject) => subject.id)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  expect(visibleSubjects(subjects, 'OFFLINE').map((s) => s.id)).toEqual(['1', '2']);
  expect(visibleSubjects(subjects, 'ARCHIVED').map((s) => s.id)).toEqual(['6', '7']);
});
it('orders offline subjects by existing recording first, then online history and deterministic ties', () => {
  const subjects = [
    { id: '8', handle: 'Z', providerStatus: 'OFFLINE' },
    { id: '7', handle: 'A', providerStatus: 'UNKNOWN', lastRecordedAtMs: 3000 },
    {
      id: '6',
      handle: 'B',
      providerStatus: 'OFFLINE',
      lastRecordedAtMs: 2000,
      lastOnlineAtMs: 8000,
    },
    {
      id: '5',
      handle: 'A',
      providerStatus: 'OFFLINE',
      lastRecordedAtMs: 2000,
      lastOnlineAtMs: 9000,
    },
    { id: '4', handle: 'C', providerStatus: 'OFFLINE', lastOnlineAtMs: 10000 },
    { id: '3', handle: 'A', providerStatus: 'OFFLINE', lastOnlineAtMs: 7000 },
    { id: '2', handle: 'Z', providerStatus: 'OFFLINE' },
    {
      id: '1',
      handle: 'A',
      providerStatus: 'UNKNOWN',
      lastCapturedAtMs: 99999,
      observedAtMs: 99999,
    },
  ] as Subject[];
  const expected = ['7', '5', '6', '4', '3', '2', '8', '1'];
  expect(visibleSubjects(subjects, 'OFFLINE').map((s) => s.id)).toEqual(expected);
  expect(visibleSubjects([...subjects].reverse(), 'OFFLINE').map((s) => s.id)).toEqual(expected);
});
it('treats missing, invalid and zero activity as absent rather than inventing recency', () => {
  const subjects = [
    { id: '3', handle: 'B', providerStatus: 'OFFLINE', lastRecordedAtMs: NaN },
    { id: '2', handle: 'A', providerStatus: 'OFFLINE', lastRecordedAtMs: -1 },
    {
      id: '1',
      handle: 'A',
      providerStatus: 'OFFLINE',
      lastRecordedAtMs: 0,
      lastOnlineAtMs: Infinity,
    },
  ] as Subject[];
  expect(visibleSubjects(subjects, 'OFFLINE').map((s) => s.id)).toEqual(['1', '2', '3']);
});
