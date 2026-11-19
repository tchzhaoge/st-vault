/** Shared by admission and the worker: writes cannot accidentally enter a read lane. */
export const metadataMutations = new Set([
  'markUnitsSeen',
  'prepareAccountSubjects',
  'activateAccountSubjects',
  'discardAccountPreparation',
  'stageSelectionPatch',
  'selectionMaintenance',
  'materializeFavorites',
  'beginMediaSelection',
  'buildMediaSelection',
  'favoriteMediaSelection',
  'beginSelectedDeletionPlan',
  'buildRecordingUnits',
  'beginDeletionPlan',
  'buildDeletionPlan',
  'enqueueMediaDeletion',
  'admitDeletionIntent',
  'prepareDeletionIntent',
  'retryDeletionIntent',
  'nextMediaDeletion',
  'advanceMediaDeletion',
  'retryMediaDeletion',
  'upsert',
  'policy',
  'policies',
  'globalRecording',
  'observation',
  'ackEvents',
  'startRun',
  'heartbeatRun',
  'stopRun',
  'settingSet',
  'apply',
  'beginSession',
  'verified',
  'gcDone',
]);

/** Resumable steps may yield between durable barriers. Admission and recording
 * commits remain foreground; per-subject command order is owned by their stores. */
export const metadataBackgroundMutations = new Set([
  'buildRecordingUnits',
  'selectionMaintenance',
  'materializeFavorites',
  'prepareDeletionIntent',
  'retryDeletionIntent',
  'nextMediaDeletion',
  'advanceMediaDeletion',
  'retryMediaDeletion',
  'gcDone',
]);

/** A single PostgreSQL statement already owns a consistent MVCC snapshot.
 * Keep multi-statement reads (including eventMeta) in the repeatable-read lane.
 */
export const metadataStatementReads = new Set([
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
]);

const playbackReads = new Set(['hasMedia', 'locate', 'media', 'unitSource', 'unitRange']);
const ordinaryReads = new Set([
  'list',
  'findSubject',
  'subjectPreview',
  'identity',
  'personalRevision',
  'personal',
  'eventMeta',
  'events',
  'runHistory',
  'statusHistory',
  'timeline',
  'coverage',
  'snapshotPages',
  'snapshotUnit',
  'snapshotForSegment',
  'snapshotUnits',
  'unitBounds',
  'unitFavoriteQuery',
  'storageStatus',
  'unitIndexStatus',
  'mediaDeletionJobs',
  'pendingDeletionIntent',
  'knownObjects',
  'acceptedMediaDeletion',
  'mediaSelection',
  'deletionPlan',
  'prepareSnapshotLayout',
  'accountActivation',
  'favoriteMaterializationStatus',
  'favoriteSubject',
  'favoriteSubjects',
]);
export type MetadataLane = 'control' | 'read' | 'playback' | 'background';
export function metadataLane(method: string, explicitRead = false): MetadataLane {
  if (metadataMutations.has(method)) return 'control';
  if (playbackReads.has(method)) return 'playback';
  return explicitRead || ordinaryReads.has(method) ? 'read' : 'control';
}
