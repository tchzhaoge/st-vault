import type { UnitSeenEvidence } from '@st-vault/api-schema';
import type {
  MediaSelection,
  MediaSelectionMode,
  MediaSelectionOptions,
  MediaSelectionPatch,
  MediaSelectionResult,
} from '@st-vault/api-schema';
import type { BackgroundTask, MediaDeletionJob, MediaDeletionTarget } from '@st-vault/api-schema';
import type {
  AccountSyncConfig,
  AccountSyncResult,
  AccountSyncStatus,
  CaptureState,
  CoverageResponse,
  EventMeta,
  EventsResponse,
  GapPolicy,
  PublicStatus,
  RunHistoryResponse,
  Segment,
  SourceCheckpoint,
  StatusHistoryResponse,
  Subject,
  TimelineResponse,
  TimeBasis,
} from '@st-vault/api-schema';
import type {
  FavoriteRemovalResult,
  MediaTimeRange,
  MediaDeletePlan,
  PersonalTimeline,
  SnapshotPagesResponse,
  SnapshotItem,
  SnapshotJobsStatus,
} from '@st-vault/api-schema';

export const ARCHIVE_MEDIA_BATCH_LIMIT = 600;

export interface SubjectInput {
  id: string;
  providerId: number;
  handle: string;
  previewSourceUrl?: string;
  avatarSourceUrl?: string;
}
export interface CommitInput {
  subjectId: string;
  sourceEpoch: string;
  sourceSequence: string;
  init: Uint8Array | null;
  bytes: Uint8Array;
  durationSeconds: number;
  wallStartMs: number | null;
  timeBasis: TimeBasis;
  uncertaintyMs: number | null;
  discontinuity: boolean;
}
export interface MediaObject {
  path: string;
  bytes: number;
  contentType: string;
}
export type MediaChange =
  | { kind: 'commit'; segment: Segment }
  | { kind: 'delete'; subjectId: string; fromMs: number; toMs: number };
export interface ArchivePort {
  /** Background source/maintenance reads must not consume playback execution reserves. */
  withBackgroundReads?<T>(action: () => Promise<T>): Promise<T>;
  admitDeletion?(
    subjectId: string,
    commandId: string,
    target: MediaDeletionTarget,
  ): Promise<MediaDeletionJob>;
  prepareMediaSelection?(
    subjectId: string,
    window: MediaTimeRange,
    mode: MediaSelectionMode,
    signal?: AbortSignal,
    options?: MediaSelectionOptions,
  ): Promise<MediaSelection>;
  favoriteMediaSelection?(
    subjectId: string,
    selectionId: string,
    liked: boolean,
    revision: number,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaSelectionResult>;
  planMediaSelectionDeletion?(
    subjectId: string,
    selectionId: string,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaDeletePlan>;
  backgroundTasks?(): Promise<BackgroundTask[]>;
  deletionJobs?(): Promise<MediaDeletionJob[]>;
  resumeDeletions?(): Promise<void>;
  resumeFavorites?(): Promise<void>;
  planDeletion?(subjectId: string, ranges: MediaTimeRange[]): Promise<MediaDeletePlan>;
  deleteSelection?(
    subjectId: string,
    planId: string,
    personalRevision: number,
  ): Promise<MediaDeletionJob>;
  unitFavorites?(
    subjectId: string,
    unitIds: string[],
    liked: boolean,
    revision: number,
  ): Promise<PersonalTimeline & FavoriteRemovalResult>;
  unitFavoriteQuery?(subjectId: string, unitIds: string[]): Promise<PersonalTimeline>;
  markUnitsSeen?(subjectId: string, evidence: UnitSeenEvidence[]): Promise<{ changed: number }>;
  unitBounds?(
    subjectId: string,
    fromMs: number,
    toMs: number,
  ): Promise<(MediaTimeRange & { openUnitId?: string }) | null>;
  unitRange?(
    subjectId: string,
    unitId: string,
  ): Promise<(MediaTimeRange & { open: boolean }) | null>;
  planUnitDeletion?(
    subjectId: string,
    unitIds: string[],
    signal?: AbortSignal,
  ): Promise<MediaDeletePlan>;
  snapshotUnit?(subjectId: string, atMs: number, unitId?: string): Promise<SnapshotItem | null>;
  unitSource?(subjectId: string, unitId: string, atMs: number): Promise<Segment | null>;
  snapshotForSegment?(subjectId: string, segmentId: string): Promise<SnapshotItem | null>;
  snapshotUnits?(
    subjectId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: SnapshotItem[]; cursor: string | null }>;
  snapshotPages?(
    subjectId: string,
    atMs: number,
    page: number | undefined,
    limit: number | undefined,
    window: MediaTimeRange,
    followLive?: boolean,
    signal?: AbortSignal,
    unitId?: string,
  ): Promise<SnapshotPagesResponse>;
  subscribeMedia?(listener: (change: MediaChange) => void): () => void;
  subjectPreview?(subjectId: string): Promise<string | null>;
  upsertSubjects(subjects: SubjectInput[], options?: { syncAccount?: boolean }): Promise<void>;
  prepareAccountSubjects(subjects: SubjectInput[], generation: string): Promise<void>;
  activateAccountSubjects(generation: string): Promise<void>;
  accountActivation(): Promise<string | null>;
  discardAccountPreparation(generation: string): Promise<void>;
  listSubjects(): Promise<Subject[]>;
  setGlobalRecording(enabled: boolean): Promise<void>;
  getSubject(id: string): Promise<Subject | null>;
  setPolicy(
    id: string,
    patch: { monitorEnabled?: boolean; autoRecord?: boolean },
  ): Promise<Subject>;
  setPolicies(
    ids: string[],
    patch: { monitorEnabled?: boolean; autoRecord?: boolean },
  ): Promise<number>;
  setObservation(
    id: string,
    status: PublicStatus,
    observedAtMs: number,
    leaseMs?: number,
    transitionAtMs?: number,
  ): Promise<void>;
  statusHistory(
    id: string,
    fromMs: number,
    toMs: number,
    buckets?: number,
  ): Promise<StatusHistoryResponse>;
  events(options?: { after?: number; before?: number; limit?: number }): Promise<EventsResponse>;
  eventMeta(): Promise<EventMeta>;
  ackEvents(cursor: number): Promise<EventMeta>;
  startRun(atMs?: number): Promise<string>;
  heartbeatRun(runId: string, atMs?: number): Promise<void>;
  stopRun(runId: string, outcome: 'normal' | 'abnormal', atMs?: number): Promise<void>;
  runHistory(fromMs: number, toMs: number): Promise<RunHistoryResponse>;
  commit(input: CommitInput): Promise<Segment>;
  timeline(
    subjectId: string,
    fromMs: number,
    toMs: number,
    limit?: number,
    cursor?: string,
  ): Promise<TimelineResponse>;
  sourceCheckpoint(subjectId: string): Promise<SourceCheckpoint | null>;
  coverage(
    subjectId: string,
    fromMs: number,
    toMs: number,
    buckets?: number,
    includeProtection?: boolean,
  ): Promise<CoverageResponse>;
  deleteUnlocated(subjectId: string): Promise<{ deletedSegments: number; reclaimedBytes: number }>;
  pruneBefore(cutoffMs: number): Promise<{ deletedSegments: number; reclaimedBytes: number }>;
  scrub?(options?: {
    limit?: number;
    delayMs?: number;
    cursor?: string;
  }): Promise<{ checked: number; nextCursor: string | null }>;
  locate(subjectId: string, targetUtcMs: number, gapPolicy: GapPolicy): Promise<Segment | null>;
  media(objectId: string): Promise<MediaObject | null>;
  hasMedia(objectIds: string[]): Promise<boolean>;
  deleteRange(
    subjectId: string,
    fromMs: number,
    toMs: number,
  ): Promise<{ deletedSegments: number; reclaimedBytes: number }>;
  getSetting(key: string): Promise<string | null>;
  identity(): Promise<{ instanceId: string; userId: string; timelineStartMs: number }>;
  personal(subjectId: string, fromMs: number, toMs: number): Promise<PersonalTimeline>;
  removeFavorite(id: string): Promise<void>;
  personalRevision(): Promise<number>;
  setSetting(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
export interface CaptureSink {
  commit(input: CommitInput): Promise<Segment>;
}
export interface AccountSyncPort {
  subscribe?(listener: () => void): () => void;
  status(): AccountSyncStatus;
  avatar?(signal?: AbortSignal): Promise<Uint8Array>;
  configure(config: AccountSyncConfig, signal?: AbortSignal): Promise<AccountSyncResult>;
  refresh(signal?: AbortSignal): Promise<AccountSyncResult>;
  disconnect(): Promise<AccountSyncConfig | null>;
  close(): Promise<void>;
}
export interface PreviewsPort {
  backgroundTasks?(): Promise<BackgroundTask[]>;
  jobs?(): Promise<SnapshotJobsStatus | null>;
  snapshotPages?(
    subjectId: string,
    atMs: number,
    page: number | undefined,
    limit: number | undefined,
    signal: AbortSignal | undefined,
    window: MediaTimeRange,
    followLive?: boolean,
    unitId?: string,
  ): Promise<SnapshotPagesResponse>;
  cover(subjectId: string, signal?: AbortSignal, cachedOnly?: boolean): Promise<Uint8Array>;
  avatar?(subjectId: string, signal?: AbortSignal): Promise<Uint8Array>;
  snapshotPoint(
    subjectId: string,
    atMs: number,
    signal?: AbortSignal,
  ): Promise<SnapshotItem | null>;
  snapshot(
    subjectId: string,
    atMs: number,
    signal?: AbortSignal,
    toMs?: number,
    unitId?: string,
  ): Promise<Uint8Array>;
  warmCovers?(subjectIds?: string[]): Promise<void>;
  observeCover?(subjectId: string, source: string | null): void;
  close(): Promise<void>;
}
export interface ProviderPort {
  importList(cookiesText: string, signal?: AbortSignal): Promise<SubjectInput[]>;
  importAccount?(
    cookiesText: string,
    signal?: AbortSignal,
  ): Promise<{
    subjects: SubjectInput[];
    profile: { username: string; followingCount: number; avatarSourceUrl: string | null };
  }>;
  status(providerId: number, signal?: AbortSignal): Promise<PublicStatus>;
  capture(subject: Subject, sink: CaptureSink, signal: AbortSignal): Promise<void>;
}
export interface SupervisorPort {
  requestRecording?(ids: string[], requestedAtMs?: number): Promise<void>;
  subscribe?(listener: () => void): () => void;
  reconcile(): Promise<void>;
  states(): Record<string, CaptureState>;
  diagnostics?(): Record<string, { error: string | null; lastSuccessMs: number | null }>;
  close(): Promise<void>;
}
