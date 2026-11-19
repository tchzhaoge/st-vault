import { expect, it } from 'vitest';
import { metadataLane, metadataMutations, metadataStatementReads } from './metadata-policy.js';

it('admits only audited single-statement or memory reads without an outer read transaction', () => {
  expect([...metadataStatementReads].sort()).toEqual(
    [
      'source',
      'init',
      'media',
      'head',
      'heads',
      'hasMedia',
      'knownObjects',
      'liveObjects',
      'unverifiedObjects',
      'pendingGc',
      'list',
      'findSubject',
      'subject',
      'subjectPreview',
      'personalRevision',
      'favoriteSubject',
      'favoriteSubjects',
      'settingGet',
      'storageStatus',
      'identity',
    ].sort(),
  );
  for (const method of metadataStatementReads) expect(metadataMutations.has(method)).toBe(false);
});
it('retains consistent multi-query snapshots and control admission', () => {
  for (const method of [
    'eventMeta',
    'events',
    'personal',
    'sourceCheckpoint',
    'timeline',
    'coverage',
    'snapshotPages',
    'mediaSelection',
    'unitRange',
  ]) {
    expect(metadataStatementReads.has(method), method).toBe(false);
  }
  for (const method of metadataMutations) expect(metadataLane(method)).toBe('control');
  expect(metadataLane('media')).toBe('playback');
  expect(metadataLane('list')).toBe('read');
});
