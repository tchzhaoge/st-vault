import { z } from 'zod';
export { allowsCredentialUrl, allowsPlainHttp } from './access-transport.js';
export { recordingLayout, recordingDisplayEnd } from './recording-layout.js';

/** Read-only task snapshots; absent totals are intentionally indeterminate. */
export interface BackgroundTask {
  id: string;
  group: 'sync' | 'processing' | 'protection';
  state: 'running' | 'idle' | 'waiting' | 'retrying' | 'paused' | 'error' | 'disabled';
  lastRunAtMs?: number | null;
  lastSuccessAtMs?: number | null;
  nextRunAtMs?: number | null;
  processed?: number;
  total?: number;
  pending?: number;
  active?: number;
  limit?: number;
  failed?: number;
  error?: string | null;
  detail?: string;
  /** Optional public endpoint label; never a credential, media URL or filesystem path. */
  target?: string;
}

export interface SiteRoutesStatus {
  lastProbeAtMs?: number | null;
  /** Observations from normal anonymous reads, never login-time benchmarks. */
  access?: {
    origin: string;
    checkedAtMs: number | null;
    lastSuccessAtMs: number | null;
    error: string | null;
  };
  probeProgress?: { completed: number; total: number; failed?: number };
  selectedOrigin: string | null;
  probing?: boolean;
  candidates: {
    origin: string;
    latencyMs: number | null;
    failures: number;
    checkedAtMs: number;
    testing?: boolean;
    error?: string | null;
  }[];
}

export interface CdnProbeStatus {
  running: boolean;
  completed: number;
  total: number;
  testingHost: string | null;
  error: string | null;
  results: Record<
    string,
    { bytesPerSecond: number | null; bitrate: number | null; error: string | null }
  >;
}
export interface NetworkRoutesStatus {
  preferences: { cdnHost: string };
  sites: SiteRoutesStatus;
  cdnHosts: string[];
  cdnProbe: CdnProbeStatus;
  activeCdns: Record<string, string>;
}

export interface ArchiveHealthStatus {
  error:
    | 'archive_checking'
    | 'archive_unavailable'
    | 'archive_timeout'
    | 'archive_recovery_required'
    | 'archive_worker_unavailable'
    | null;
  checkedAtMs: number;
  failures: number;
  recovery: 'none' | 'retrying' | 'restart-requested';
}

export type PublicStatus = 'PUBLIC' | 'PRIVATE' | 'OFFLINE' | 'UNKNOWN';
/** Time spent in each observed state; UNKNOWN includes expired leases and unobserved gaps. */
export interface StatusHistoryBucket {
  fromMs: number;
  toMs: number;
  durationsMs: Record<PublicStatus, number>;
}
export interface StatusHistoryResponse {
  subjectId: string;
  fromMs: number;
  toMs: number;
  buckets: StatusHistoryBucket[];
}
interface EventBase {
  id: number;
  atMs: number;
  occurredAtMs: number;
}
export type ArchiveEvent = EventBase &
  (
    | {
        kind: 'status_changed';
        subjectId: string;
        handle: string;
        fromStatus: PublicStatus;
        toStatus: PublicStatus;
        reason: 'observation' | 'lease_expired';
      }
    | {
        kind: 'run_started' | 'run_stopped' | 'run_abnormal';
        runId: string;
        startedAtMs: number;
        lastHeartbeatAtMs: number;
        stoppedAtMs: number | null;
        uncertainUntilMs: number | null;
      }
  );
export interface EventMeta {
  latestCursor: number;
  readCursor: number;
  oldestCursor: number;
  unreadCount: number;
  revision: number;
  retentionDays: number;
  maxEvents: number;
}
export interface EventsResponse {
  items: ArchiveEvent[];
  nextCursor: number;
  hasMore: boolean;
  cursorExpired: boolean;
  meta: EventMeta;
}
export interface ProgramRun {
  runId: string;
  startedAtMs: number;
  lastHeartbeatAtMs: number;
  stoppedAtMs: number | null;
  outcome: 'running' | 'normal' | 'abnormal';
  detectedAtMs: number | null;
}
export interface RunHistoryResponse {
  fromMs: number;
  toMs: number;
  runs: ProgramRun[];
  gaps: { runId: string; fromMs: number; toMs: number; kind: 'stopped' | 'uncertain' }[];
  truncated: boolean;
}
export type CaptureState = 'IDLE' | 'QUEUED' | 'RESOLVING' | 'CAPTURING' | 'BACKOFF' | 'STOPPING';
export type TimeBasis = 'source-pdt' | 'estimated' | 'unknown';
export interface Subject {
  id: string;
  providerId: number;
  handle: string;
  /** Previous website names observed on successful list syncs, excluding the current name. */
  formerNames?: string[];
  monitorEnabled: boolean;
  autoRecord: boolean;
  /** Previously imported from account favorites, absent from the latest complete sync. */
  archived?: boolean;
  providerStatus: PublicStatus;
  /** Last confirmed state for list presentation, not fresh evidence for capture or history. */
  lastKnownStatus?: Exclude<PublicStatus, 'UNKNOWN'>;
  observedAtMs: number | null;
  /** Latest located, non-deleted recording's wall-clock end; not capture diagnostics. */
  lastRecordedAtMs?: number | null;
  /** Start of the most recent confirmed PUBLIC or PRIVATE interval. */
  lastOnlineAtMs?: number | null;
  captureState?: CaptureState;
  captureError?: string | null;
  lastCapturedAtMs?: number | null;
}
export interface Segment {
  /** Read-model identity for archive navigation; not inferred from wall clock. */
  recordingUnitId?: string;
  id: string;
  subjectId: string;
  sourceEpoch: string;
  sourceSequence: string;
  mediaObjectId: string;
  initObjectId: string | null;
  durationSeconds: number;
  wallStartMs: number | null;
  wallEndMs: number | null;
  timeBasis: TimeBasis;
  uncertaintyMs: number | null;
  discontinuity: boolean;
}
export interface TimelineResponse {
  subjectId: string;
  fromMs: number;
  toMs: number;
  segments: Segment[];
  unlocatedCount: number;
  truncated: boolean;
  revision: number;
  nextCursor?: string | null;
}
export interface SourceCheckpoint {
  epoch: string;
  highestSequence: string;
  lastWallStartMs: number | null;
}
export interface CoverageBucket {
  fromMs: number;
  toMs: number;
  coveredMs: number;
  segmentCount: number;
  /** Exact occupied edges, omitted for empty buckets. Internal gaps are resolved on release. */
  mediaFromMs?: number;
  mediaToMs?: number;
}
export interface CoverageResponse {
  /** Opt-in protection mask during unliked deletion; absent on ordinary timeline reads. Never selection boundaries. */
  protectedSpans?: MediaTimeRange[];
  subjectId: string;
  fromMs: number;
  toMs: number;
  buckets: CoverageBucket[];
  unlocatedCount: number;
  revision: number;
  /** Bounded display spans. Mixed subpixel buckets remain unread. Not deletion bounds. */
  seenSpans?: MediaTimeRange[];
}
export interface RecordingBoundsResponse {
  subjectId: string;
  fromMs: number | null;
  toMs: number | null;
}
export type GapPolicy = 'report' | 'next' | 'previous';
export interface PlaybackResponse {
  openUnitId?: string;
  sessionId: string;
  manifestUrl: string;
  requestedAtMs: number;
  actualAtMs: number;
  seekOffsetSeconds: number;
  timeBasis: TimeBasis;
  uncertaintyMs: number | null;
  segments: Segment[];
  nextAtMs?: number | null;
  windowEndMs?: number;
  hasGapAfter?: boolean;
  rangeFromMs?: number;
  rangeToMs?: number;
}
export interface SessionInfo {
  /** Deployment IANA timezone; stored media timestamps remain UTC. */
  timeZone?: string;
  authenticated: boolean;
  setupRequired: boolean;
  credential?: 'pin' | 'password';
  setupAuthorized?: boolean;
  instanceId?: string;
  userId?: string;
  timelineStartMs?: number;
}
export interface FavoriteRange {
  id: string;
  subjectId: string;
  /** Screenshot anchor; retention and rendering always use fromMs/toMs. */
  atMs: number;
  createdAtMs: number;
  fromMs: number;
  toMs: number;
}
export interface MediaTimeRange {
  fromMs: number;
  toMs: number;
}
/** Request payload bound for unit IDs, independent of the number of video files. */
export const MAX_SNAPSHOT_SELECTION = 100000;
export interface FavoriteRemovalResult {
  removed: number;
  revision: number;
}
export interface MediaDeletePlan {
  id: string;
  subjectId: string;
  ranges: MediaTimeRange[];
  total: number;
  fromMs: number | null;
  toMs: number | null;
  bytes: number;
  favoriteSegments: number;
  personalRevision: number;
}
export interface PersonalTimeline {
  subjectId: string;
  fromMs: number;
  toMs: number;
  favorites: FavoriteRange[];
  revision: number;
  truncated: boolean;
}
export interface LivePlaybackResponse {
  sessionId: string;
  manifestUrl: string;
  expiresAtMs: number;
  quality: { height: number; bandwidth: number };
}
export interface LiveProgress {
  phase:
    | 'queued'
    | 'checking'
    | 'resolving'
    | 'buffering'
    | 'ready'
    | 'reconnecting'
    | 'ended'
    | 'stopped';
  reason?: 'offline' | 'private' | 'status-unknown' | 'network' | 'keys' | 'source' | 'timeout';
}
export const MAX_SNAPSHOT_PAGE_SIZE = 1000;
/** Frozen coverage represented when a screenshot was displayed. */
export interface UnitSeenEvidence {
  unitId: string;
  toMs: number;
}
export interface SnapshotItem {
  /** Persistent media-unit identity; sample time is not its identity. */
  unitId: string;
  open?: boolean;
  gridIndex?: number;
  imageToMs?: number;
  atMs: number;
  url: string;
  timeBasis: TimeBasis;
  uncertaintyMs: number | null;
  /** Whole-unit boundaries, independent of display clipping and playback mode. */
  slotFromMs: number;
  slotToMs: number;
}
/** Frozen whole-unit range for bounded background commands. */
export interface MediaSelection extends MediaTimeRange {
  id: string;
  subjectId: string;
  count: number;
  personalRevision: number;
  deletionRevision: number;
}
export interface MediaSelectionPatch {
  includeUnitIds?: string[];
  excludeUnitIds?: string[];
}
export type MediaSelectionMode = 'unliked' | 'all' | 'explicit';
export interface MediaSelectionOptions extends MediaSelectionPatch {
  baseSelectionId?: string;
}
export interface MediaSelectionResult {
  subjectId: string;
  revision: number;
  count: number;
}
export interface SnapshotCell {
  index: number;
  kind: 'unit' | 'gap' | 'pending';
  fromMs: number;
  toMs: number;
  unitId?: string;
  part?: number;
  parts?: number;
}
export interface SnapshotSession {
  selectionFromMs?: number;
  selectionToMs?: number;
  selectionOpen?: boolean;
  fromMs: number;
  toMs: number;
  startBasis: 'observed-online' | 'recorded-media';
  ended: boolean;
}
export interface SnapshotJobsStatus {
  running?: boolean;
  active?: number;
  limit?: number;
  lastCompletedAtMs?: number | null;
  /** Unfinished jobs, including active attempts. */
  pending: number;
  failed: number;
  completed: number;
  mode: 'initializing' | 'realtime' | 'catching-up' | 'paused' | 'unavailable';
  averageMs: number;
  error?: string;
}
export interface SnapshotPagesResponse {
  /** Exact archive unit page; null means this unit is outside the current layout. */
  playbackUnitPage?: number | null;
  /** Effective presentation window; live left edge contracts to fit 30 cells. */
  displayWindow?: MediaTimeRange;
  pageOffset?: number;
  cells?: SnapshotCell[];
  slotCount?: number;
  pageAnchors?: number[];
  subjectId: string;
  /** Subject deletion generation, including accepted jobs and retention tombstones. */
  deletionRevision: number;
  session: SnapshotSession | null;
  /** Recorded units in the entire requested interval, excluding presentation gaps. */
  total: number;
  page: number;
  /** Pages of compressed unit/gap cells at the requested fetch limit. */
  pages: number;
  /** Navigable 30-cell presentation pages, independent of the fetch limit. */
  occupiedPages: number[];
  /** Number of presentation cells per fetch, including bounded gap cells. */
  limit: number;
  items: SnapshotItem[];
}
export interface AccountProfile {
  username: string;
  followingCount: number;
  avatarUrl: string | null;
}
export interface MediaDeletionJob {
  id: string;
  subjectId: string;
  state: 'preparing' | 'queued' | 'running' | 'retry' | 'completed' | 'failed';
  phase?: 'units' | 'extras' | 'plan' | 'delete';
  scannedUnits?: number;
  selectedUnits?: number;
  deletionRevision?: number;
  total: number;
  processed: number;
  reclaimedBytes: number;
  fromMs: number | null;
  toMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  error: string | null;
}
export type MediaDeletionTarget = MediaTimeRange &
  (
    | { kind: 'units'; unitIds: string[] }
    | { kind: 'selection'; selectionId: string; patch?: MediaSelectionPatch }
    | {
        kind: 'range';
        mode: 'all' | 'unliked';
        baseSelectionId?: string;
        patch?: MediaSelectionPatch;
      }
  );
export interface AccountSyncStatus {
  /** Account imports and anonymous profile/status queries share this locked origin. */
  origin?: string;
  stage?: 'validating' | 'syncing' | 'saving';
  warmingCovers?: boolean;
  connected: boolean;
  running: boolean;
  needsReconnect: boolean;
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  nextAttemptMs: number | null;
  lastImportedCount: number | null;
  error: string | null;
  profile?: AccountProfile | null;
}
export interface AccountSyncResult {
  imported: number | null;
  status: AccountSyncStatus;
}
/** Returned only by an authenticated, explicit disconnect; never by status/SSE. */
export interface AccountDisconnectResult {
  draft: AccountSyncConfig | null;
  status: AccountSyncStatus;
}
export const accountSyncConfigSchema = z
  .object({
    cookiesText: z.string().min(1).max(65536),
    origin: z.string().url().max(2048).optional(),
  })
  .strict();
export type AccountSyncConfig = z.infer<typeof accountSyncConfigSchema>;
export const policySchema = z
  .object({ monitorEnabled: z.boolean().optional(), autoRecord: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const playbackSchema = z
  .object({
    subjectId: z.string().regex(/^stripchat:[1-9]\d*$/),
    targetUtcMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    gapPolicy: z.enum(['report', 'next', 'previous', 'next-or-previous']).default('report'),
    fromMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    toMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    openUnitId: z.string().uuid().optional(),
    unitId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.fromMs === undefined && value.toMs === undefined) ||
      (value.fromMs !== undefined &&
        value.toMs !== undefined &&
        value.toMs > value.fromMs &&
        value.toMs - value.fromMs <= 9 * 86400000 &&
        value.targetUtcMs >= value.fromMs &&
        value.targetUtcMs < value.toMs),
  );
export const timelineSchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().positive(),
    limit: z.coerce.number().int().min(1).max(2000).default(1000),
  })
  .refine((v) => v.to > v.from && v.to - v.from <= 9 * 86400000);
