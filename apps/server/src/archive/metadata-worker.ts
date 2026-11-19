import type { UnitSeenEvidence } from '@st-vault/api-schema';
import type * as MetadataPolicyModule from './metadata-policy.js';
import type {
  MediaSelectionMode,
  MediaSelectionOptions,
  MediaSelectionPatch,
} from '@st-vault/api-schema';
import type * as UnitsModule from './recording-units.js';
import type * as FavoriteCommandsModule from './favorite-commands.js';
import type * as SelectionModule from './media-selection-store.js';
import type * as SnapshotLayoutModule from './snapshot-layout-index.js';
import type * as AccountSubjectsModule from './account-subjects.js';
import type * as LayoutModule from '../../../../packages/api-schema/src/recording-layout.js';
// The worker owns archive database access. No filesystem payload or secret is returned to HTTP.
import { parentPort, workerData } from 'node:worker_threads';
import { SqlDatabase } from '../database/sql.js';
import { initializeBaseSchema } from '../database/catalog-schema.js';
import { FileLease } from '../database/file-lease.js';
import type { SQLInputValue } from '../database/sql.js';
import { join } from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';
import type { DeletionStore } from './deletion-store.js';
import type * as DeletionModule from './deletion-store.js';
import type * as DeletionIntentModule from './deletion-intents.js';
import type { MediaDeletionTarget } from '@st-vault/api-schema';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  CoverageResponse,
  CoverageBucket,
  GapPolicy,
  PublicStatus,
  Segment,
  SourceCheckpoint,
  StatusHistoryResponse,
  Subject,
  MediaTimeRange,
} from '@st-vault/api-schema';
import type { SubjectInput } from '../ports.js';
import type { SnapshotItem, SnapshotPagesResponse, SnapshotSession } from '@st-vault/api-schema';
import type { JournalRecord, ObjectRecord } from './index.js';
import type { EventStore as EventStoreType } from './events-store.js';
import type * as EventsModule from './events-store.js';
import type { PersonalStore as PersonalStoreType } from './personal-store.js';
import type * as PersonalModule from './personal-store.js';
import type { LibraryStorage } from '../library/storage.js';
import type { PrivateSettings } from '../library/settings.js';
import type * as LibraryModule from '../library/storage.js';
import type * as SettingsModule from '../library/settings.js';
import type * as RpcModule from '../library/worker-rpc.js';
import type * as ObjectQueriesModule from './object-queries.js';
const { hasMediaSql, liveObjectsSql } = (await import(
  new URL(
    import.meta.url.endsWith('.ts') ? './object-queries.ts' : './object-queries.js',
    import.meta.url,
  ).href
)) as typeof ObjectQueriesModule;
const subjectSelect = `SELECT s.*,
  CASE WHEN EXISTS(SELECT 1 FROM media_deletions WHERE subject=s.id AND state IN ('preparing','queued','running','retry'))
    THEN (SELECT "end" FROM visible_segments WHERE subject=s.id AND deleted=0 AND start IS NOT NULL AND "end" IS NOT NULL ORDER BY "end" DESC LIMIT 1)
    ELSE (SELECT minute+(spans::json->-1->>1)::double precision FROM coverage_minutes WHERE subject=s.id AND covered_ms>0 ORDER BY minute DESC LIMIT 1)
  END AS last_recorded,
  (SELECT start FROM status_intervals WHERE subject=s.id AND status IN ('PUBLIC','PRIVATE') ORDER BY start DESC LIMIT 1) AS last_online,
  (SELECT coalesce(json_agg(handle)::text,'[]') FROM
    (SELECT handle FROM subject_name_history WHERE subject=s.id AND handle<>s.handle ORDER BY changed_at DESC,handle)) AS former_names,
  h.valid_until AS status_valid_until,a.following AS account_following,e.status AS last_known_status
  FROM subjects s LEFT JOIN status_heads h ON s.id=h.subject LEFT JOIN account_subjects a ON a.subject=s.id
  LEFT JOIN status_event_states e ON e.subject=s.id`;
interface SubjectRow {
  id: string;
  provider_id: number;
  handle: string;
  former_names?: string;
  monitor: number;
  auto_record: number;
  status: PublicStatus;
  last_known_status?: PublicStatus;
  observed: number | null;
  last_recorded: number | null;
  last_online: number | null;
  unlocated: number;
  deletion_revision: number;
  status_valid_until?: number | null;
  account_following?: number | null;
}
interface ObjectRow {
  id: string;
  subject: string;
  filename: string;
  bytes: number;
  hash: string;
  kind: 'init' | 'fragment';
  deleted: number;
}
interface SegmentRow {
  id: string;
  subject: string;
  media: string;
  init: string | null;
  start: number | null;
  json: string;
  deleted: number;
}
interface RequestInput {
  includeProtection?: boolean;
  enabled: boolean;
  excludedSubjects?: string[];
  commandId?: string;
  deletionTarget?: MediaDeletionTarget;
  generation?: string;
  selectionId?: string;
  selectionMode?: MediaSelectionMode;
  selectionOptions?: MediaSelectionOptions;
  selectionPatch?: MediaSelectionPatch;
  liked?: boolean;
  followLive?: boolean;
  unitId?: string;
  unitIds?: string[];
  seenEvidence?: UnitSeenEvidence[];
  planId?: string;
  personalRevision?: number;
  processed?: number;
  reclaimedBytes?: number;
  window: MediaTimeRange;
  ranges?: MediaTimeRange[];
  segmentIds?: string[];
  syncAccount?: boolean;
  id: string;
  subjects: SubjectInput[];
  patch: {
    monitorEnabled?: boolean;
    autoRecord?: boolean;
  };
  status: PublicStatus;
  at: number;
  leaseMs: number;
  transitionAt?: number;
  key: string;
  value: string;
  record: JournalRecord;
  subjectId: string;
  segmentId?: string;
  epoch: string;
  sequence: string;
  hash: string;
  after: string;
  from: number;
  to: number;
  limit: number;
  page: number;
  target: number;
  policy: GapPolicy;
  cursor?: string;
  buckets: number;
  ids: string[];
  unlocated?: boolean;
  cutoff?: number;
  recovery?: boolean;
  clean?: boolean;
  eventAfter: number;
  eventBefore?: number;
  readCursor: number;
  outcome: 'normal' | 'abnormal';
}
interface Minute {
  minute: number;
  spans: string;
  starts: string;
  ends: string;
  count: number;
}
interface MinuteSummary {
  minute: number;
  count: number;
  covered_ms: number;
  start_count: number;
  end_count: number;
}
interface Cursor {
  subject: string;
  from: number;
  to: number;
  limit: number;
  revision: number;
  deletion: number;
  start: number;
  id: string;
  unlocated: number;
}
const port = parentPort;
if (!port) throw new Error('WORKER_PORT_REQUIRED');
const data: unknown = workerData;
if (typeof data !== 'object' || data === null || !('root' in data) || typeof data.root !== 'string')
  throw new Error('INVALID_WORKER_ROOT');
const root = data.root;
const mediaRoot =
  'mediaRoot' in data && typeof data.mediaRoot === 'string' ? data.mediaRoot : join(root, 'media');
const MINUTE = 60000;
let db!: SqlDatabase;
let instance!: FileLease;
let mediaInstance: FileLease | undefined;
let library!: LibraryStorage;
let privateSettings!: PrivateSettings;
let portableSetting!: typeof SettingsModule.portableSetting;
let libraryReady = false;
let summariesReady = false;
let eventStore!: EventStoreType;
let personalStore!: PersonalStoreType;
let deletionStore!: DeletionStore;
let deletionIntents!: InstanceType<typeof DeletionIntentModule.DeletionIntents>;
let units!: InstanceType<typeof UnitsModule.RecordingUnits>;
let favoriteCommands!: InstanceType<typeof FavoriteCommandsModule.FavoriteCommands>;
let selections!: InstanceType<typeof SelectionModule.MediaSelectionStore>;
let snapshotLayouts!: InstanceType<typeof SnapshotLayoutModule.SnapshotLayoutIndex>;
let accountSubjects!: InstanceType<typeof AccountSubjectsModule.AccountSubjects>;
let recordingLayout: typeof LayoutModule.recordingLayout;
async function one<T>(sql: string, ...args: SQLInputValue[]): Promise<T | undefined> {
  return db.prepare(sql).get<T>(...args);
}
async function many<T>(sql: string, ...args: SQLInputValue[]): Promise<T[]> {
  return db.prepare(sql).all<T>(...args);
}
async function readSegments(
  rows: {
    json: string;
  }[],
): Promise<Segment[]> {
  const segments = rows.map((row) => JSON.parse(row.json) as Segment);
  if (!segments.length) return [];
  const membership = new Map(
    (
      await many<{
        segment: string;
        unit: string;
      }>(
        'SELECT segment,unit FROM unit_segments WHERE segment IN(SELECT value FROM json_array_elements_text(?::json))',
        JSON.stringify(segments.map((segment) => segment.id)),
      )
    ).map((row) => [row.segment, row.unit]),
  );
  return segments.map((segment) => ({
    ...segment,
    ...(membership.has(segment.id) ? { recordingUnitId: membership.get(segment.id) } : {}),
  }));
}
try {
  instance = await FileLease.acquire(join(root, '.instance.lock'));
  mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(mediaRoot).isSymbolicLink()) throw Error('UNSAFE_ARCHIVE_PATH');
  mediaInstance = await FileLease.acquire(join(mediaRoot, '.instance.lock'));
  const { LibraryStorage } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? '../library/storage.ts' : '../library/storage.js',
      import.meta.url,
    ).href
  )) as typeof LibraryModule;
  const settingsModule = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? '../library/settings.ts' : '../library/settings.js',
      import.meta.url,
    ).href
  )) as typeof SettingsModule;
  portableSetting = settingsModule.portableSetting;
  privateSettings = await settingsModule.PrivateSettings.open(root);
  library = new LibraryStorage(root, mediaRoot);
  db = await SqlDatabase.open(library.indexFile);
  await initializeBaseSchema(db, library.manifest.createdAtMs);
  summariesReady = true;
  if (!(await privateSettings.get('archive.cursor-secret')))
    await privateSettings.set('archive.cursor-secret', randomBytes(32).toString('hex'));
  // Load only after lock/path checks: failed native-TS worker startup must not
  // race module loading against immediate termination on Windows Node 24.
  const { EventStore } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './events-store.ts' : './events-store.js',
      import.meta.url,
    ).href
  )) as typeof EventsModule;
  await transaction(async () => {
    eventStore = new EventStore(db);
    await eventStore.initialize();
  });
  const { PersonalStore } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './personal-store.ts' : './personal-store.js',
      import.meta.url,
    ).href
  )) as typeof PersonalModule;
  await transaction(async () => {
    const origin = (
      await one<{
        value: string;
      }>('SELECT value FROM settings WHERE key=?', 'timeline.deployed-at')
    )?.value;
    if (origin === undefined) {
      throw new Error('INVALID_TIMELINE_ORIGIN');
    }
    const at = Number(origin);
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('INVALID_TIMELINE_ORIGIN');
    personalStore = new PersonalStore(db, at);
    await personalStore.initialize();
  });
  const unitModule = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './recording-units.ts' : './recording-units.js',
      import.meta.url,
    ).href
  )) as typeof UnitsModule;
  units = new unitModule.RecordingUnits(db);
  await units.initialize();
  ({ recordingLayout } = (await import(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../../../../packages/api-schema/src/recording-layout.ts'
        : '../../../../packages/api-schema/src/recording-layout.js',
      import.meta.url,
    ).href
  )) as typeof LayoutModule);
  const { DeletionStore } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './deletion-store.ts' : './deletion-store.js',
      import.meta.url,
    ).href
  )) as typeof DeletionModule;
  await transaction(async () => {
    deletionStore = new DeletionStore(db, async () => await personalStore.revision());
    await deletionStore.initialize();
  });
  await db.exec(`
    CREATE OR REPLACE VIEW visible_segments AS SELECT s.* FROM segments s WHERE NOT EXISTS(
      SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job
      WHERE i.segment=s.id AND d.state IN ('queued','running','retry'))
    AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN recording_units u ON u.id=m.unit WHERE m.segment=s.id AND u.deleted=1);`);
  const { MediaSelectionStore } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './media-selection-store.ts' : './media-selection-store.js',
      import.meta.url,
    ).href
  )) as typeof SelectionModule;
  selections = new MediaSelectionStore(db, currentRevision);
  await selections.initialize();
  const { FavoriteCommands } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './favorite-commands.ts' : './favorite-commands.js',
      import.meta.url,
    ).href
  )) as typeof FavoriteCommandsModule;
  favoriteCommands = new FavoriteCommands(db, selections);
  await favoriteCommands.initialize();
  const { DeletionIntents } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './deletion-intents.ts' : './deletion-intents.js',
      import.meta.url,
    ).href
  )) as typeof DeletionIntentModule;
  await transaction(async () => {
    deletionIntents = new DeletionIntents(
      db,
      deletionStore,
      selections,
      currentRevision,
      async () => await personalStore.revision(),
    );
    await deletionIntents.initialize();
  });
  await db.exec(`
    CREATE OR REPLACE VIEW visible_segments AS SELECT s.* FROM segments s WHERE NOT EXISTS(
      SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job
      WHERE i.segment=s.id AND d.state IN ('queued','running','retry'))
    AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN recording_units u ON u.id=m.unit WHERE m.segment=s.id AND u.deleted=1)
    AND NOT EXISTS(SELECT 1 FROM unit_segments m JOIN deletion_intent_units x ON x.unit=m.unit WHERE m.segment=s.id);`);
  const { SnapshotLayoutIndex } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './snapshot-layout-index.ts' : './snapshot-layout-index.js',
      import.meta.url,
    ).href
  )) as typeof SnapshotLayoutModule;
  const { recordingGapParts } = (await import(
    new URL(
      import.meta.url.endsWith('.ts')
        ? '../../../../packages/api-schema/src/recording-layout.ts'
        : '../../../../packages/api-schema/src/recording-layout.js',
      import.meta.url,
    ).href
  )) as typeof LayoutModule;
  snapshotLayouts = new SnapshotLayoutIndex(units, recordingGapParts, async () => {
    const frozen = await db.snapshot();
    try {
      const reader = new unitModule.RecordingUnits(frozen, false);
      await reader.ready(); // Pin one coherent MVCC snapshot before the first bounded batch.
      return {
        reader,
        close: async () => {
          if (frozen.isOpen) {
            await frozen.close();
          }
        },
      };
    } catch (error) {
      await frozen.close();
      throw error;
    }
  });
  db.onCommittedHookFailure(() => {
    snapshotLayouts.invalidateAll();
    personalStore.clearCoverageCache();
  });
  units.setChangeListener((id, from, to, destructive) =>
    snapshotLayouts.invalidate(id, from, to, destructive),
  );
  const { AccountSubjects } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './account-subjects.ts' : './account-subjects.js',
      import.meta.url,
    ).href
  )) as typeof AccountSubjectsModule;
  accountSubjects = new AccountSubjects(db, addSubject, async (id) => {
    await db.prepare('UPDATE subjects SET auto_record=0 WHERE id=?').run(id);
    await disableStatus(id);
    await units.seal(id);
  });
  await accountSubjects.initialize();
  await library.attach(db);
  libraryReady = true;
  const restoredOrigin = await one<{ value: string }>(
    'SELECT value FROM settings WHERE key=?',
    'timeline.deployed-at',
  );
  if (
    !restoredOrigin ||
    !Number.isSafeInteger(Number(restoredOrigin.value)) ||
    Number(restoredOrigin.value) < 0
  )
    throw Error('INVALID_TIMELINE_ORIGIN');
  personalStore = new PersonalStore(db, Number(restoredOrigin.value));
  await personalStore.initialize();
  await transaction(async () => {
    await eventStore.recover();
    await sealStatusHistory();
    await deletionStore.recover();
  });
  port.postMessage({ ready: true });
} catch (error) {
  console.error('metadata_initialization_failed', error);
  for (const release of [
    () => library?.close(),
    async () => db?.isOpen && (await db.close()),
    async () => await privateSettings?.close(),
    () => mediaInstance?.close(),
    () => instance?.close(),
  ]) {
    try {
      await release();
    } catch (cleanupError) {
      console.error('metadata_initialization_cleanup_failed', cleanupError);
    }
  }
  port.postMessage({
    ready: false,
    error:
      error instanceof Error && 'code' in error && error.code === 'ELOOP'
        ? 'UNSAFE_DATABASE_PATH'
        : error instanceof Error &&
            (error.message.startsWith('LIBRARY_') ||
              [
                'UNSAFE_DATABASE_PATH',
                'UNSAFE_LIBRARY_FILE',
                'UNSUPPORTED_ARCHIVE_VERSION',
                'INVALID_TIMELINE_ORIGIN',
                'UNSUPPORTED_RECORDING_UNITS',
              ].includes(error.message))
          ? error.message === 'UNSAFE_LIBRARY_FILE'
            ? 'UNSAFE_DATABASE_PATH'
            : error.message
          : 'ARCHIVE_LOCKED_OR_DATABASE_UNAVAILABLE',
  });
  port.close();
}
function subject(row: SubjectRow): Subject {
  const now = Date.now();
  return {
    id: row.id,
    providerId: row.provider_id,
    handle: row.handle,
    formerNames: JSON.parse(row.former_names ?? '[]') as string[],
    monitorEnabled: row.monitor === 1 && row.account_following !== 0,
    autoRecord: row.auto_record === 1 && row.account_following !== 0,
    archived: row.account_following === 0,
    providerStatus:
      row.observed !== null &&
      row.observed <= now &&
      row.status_valid_until != null &&
      row.status_valid_until > now
        ? row.status
        : 'UNKNOWN',
    observedAtMs: row.observed,
    ...(row.last_known_status && row.last_known_status !== 'UNKNOWN'
      ? { lastKnownStatus: row.last_known_status }
      : {}),
    lastRecordedAtMs: row.last_recorded,
    lastOnlineAtMs: row.last_online,
  };
}
type CoreSubjectRow = Omit<
  SubjectRow,
  'last_recorded' | 'last_online' | 'former_names' | 'last_known_status' | 'status_valid_until'
>;
/** Internal checks must not calculate directory-only activity/name summaries. */
async function requireSubject(id: string): Promise<CoreSubjectRow> {
  const row = await one<CoreSubjectRow>(
    'SELECT s.*,a.following AS account_following FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id WHERE s.id=?',
    id,
  );
  if (!row) throw new Error('SUBJECT_NOT_FOUND');
  return row;
}
async function requireSubjectDetails(id: string): Promise<SubjectRow> {
  const row = await one<SubjectRow>(`${subjectSelect} WHERE s.id=?`, id);
  if (!row) throw new Error('SUBJECT_NOT_FOUND');
  return row;
}
function transaction<T>(action: () => Promise<T>): Promise<T> {
  if (db.isTransaction) return action();
  if (libraryReady) return library.transaction(db, action);
  return db.transaction(action);
}
async function addSubject(value: SubjectInput, trackNames = false): Promise<void> {
  // Only a successful website-list sync supplies authoritative name changes.
  // Local placeholders and journal replay must not invent former website names.
  const previous = trackNames
    ? await one<{
        handle: string;
      }>(
        'SELECT s.handle FROM subjects s JOIN account_subjects a ON a.subject=s.id WHERE s.id=?',
        value.id,
      )
    : undefined;
  if (previous && previous.handle !== value.handle)
    await db
      .prepare(
        'INSERT INTO subject_name_history VALUES(?,?,?) ON CONFLICT(subject,handle) DO UPDATE SET changed_at=excluded.changed_at',
      )
      .run(value.id, previous.handle, Date.now());
  await db
    .prepare(
      `INSERT INTO subjects(id,provider_id,handle) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET handle=excluded.handle`,
    )
    .run(value.id, value.providerId, value.handle);
  if (value.previewSourceUrl)
    await db
      .prepare(
        'INSERT INTO subject_images VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET preview=excluded.preview',
      )
      .run(value.id, value.previewSourceUrl);
  if (value.avatarSourceUrl)
    await db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value!=excluded.value',
      )
      .run(`preview.avatar-source.${value.id}`, value.avatarSourceUrl);
}
async function head(id: string): Promise<number> {
  return (
    (
      await one<{
        revision: number;
      }>('SELECT revision FROM journal_heads WHERE subject=?', id)
    )?.revision ?? 0
  );
}
function objectRow(value: ObjectRow): ObjectRecord {
  return {
    id: value.id,
    subjectId: value.subject,
    filename: value.filename,
    bytes: value.bytes,
    hash: value.hash,
    kind: value.kind,
  };
}
async function currentRevision(): Promise<number> {
  return (
    (
      await one<{
        revision: number;
      }>('SELECT revision FROM counters WHERE id=1')
    )?.revision ?? 0
  );
}
function mergeSpans(spans: number[][]): number[][] {
  spans.sort((a, b) => a[0] - b[0]);
  const result: number[][] = [];
  for (const span of spans) {
    const last = result.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else result.push([...span]);
  }
  return result;
}
async function putMinute(
  subject: string,
  minute: number,
  spans: number[][],
  starts: number[],
  ends: number[],
  count: number,
): Promise<void> {
  const union = mergeSpans(spans);
  await db
    .prepare(
      `INSERT INTO coverage_minutes(subject,minute,spans,starts,ends,count) VALUES(?,?,?,?,?,?) ON CONFLICT(subject,minute) DO UPDATE SET spans=excluded.spans,starts=excluded.starts,ends=excluded.ends,count=excluded.count`,
    )
    .run(
      subject,
      minute,
      JSON.stringify(union),
      JSON.stringify(starts.sort((a, b) => a - b)),
      JSON.stringify(ends.sort((a, b) => a - b)),
      count,
    );
  if (summariesReady)
    await db
      .prepare(
        'UPDATE coverage_minutes SET covered_ms=?,start_count=?,end_count=? WHERE subject=? AND minute=?',
      )
      .run(
        union.reduce((sum, [s, e]) => sum + e - s, 0),
        starts.length,
        ends.length,
        subject,
        minute,
      );
}
async function addCoverage(
  subject: string,
  start: number | null,
  end: number | null,
): Promise<void> {
  if (start === null || end === null) return;
  for (let minute = Math.floor(start / MINUTE) * MINUTE; minute < end; minute += MINUTE) {
    const row = await one<Minute>(
      'SELECT * FROM coverage_minutes WHERE subject=? AND minute=?',
      subject,
      minute,
    );
    const spans = row ? (JSON.parse(row.spans) as number[][]) : [];
    const starts = row ? (JSON.parse(row.starts) as number[]) : [];
    const ends = row ? (JSON.parse(row.ends) as number[]) : [];
    spans.push([Math.max(start, minute) - minute, Math.min(end, minute + MINUTE) - minute]);
    if (start >= minute) starts.push(start - minute);
    if (end <= minute + MINUTE) ends.push(end - minute);
    await putMinute(subject, minute, spans, starts, ends, (row?.count ?? 0) + 1);
  }
}
async function rebuildMinute(subject: string, minute: number): Promise<void> {
  const rows = await many<{
    start: number;
    end: number;
  }>(
    'SELECT start,"end" FROM segments WHERE subject=? AND deleted=0 AND start>? AND start<? AND "end">?',
    subject,
    minute - 86400000,
    minute + MINUTE,
    minute,
  );
  if (!rows.length) {
    await db
      .prepare('DELETE FROM coverage_minutes WHERE subject=? AND minute=?')
      .run(subject, minute);
    return;
  }
  await putMinute(
    subject,
    minute,
    rows.map((s) => [
      Math.max(s.start, minute) - minute,
      Math.min(s.end, minute + MINUTE) - minute,
    ]),
    rows.filter((s) => s.start >= minute).map((s) => s.start - minute),
    rows.filter((s) => s.end <= minute + MINUTE).map((s) => s.end - minute),
    rows.length,
  );
}
async function saveSource(
  s: Pick<Segment, 'subjectId' | 'sourceEpoch' | 'sourceSequence' | 'wallStartMs'>,
): Promise<void> {
  const previous = await one<{
    epoch: string;
    sequence: string;
  }>('SELECT epoch,sequence FROM source_checkpoints WHERE subject=?', s.subjectId);
  if (previous?.epoch === s.sourceEpoch && BigInt(previous.sequence) >= BigInt(s.sourceSequence))
    return;
  await db
    .prepare(
      `INSERT INTO source_checkpoints VALUES(?,?,?,?) ON CONFLICT(subject) DO UPDATE SET epoch=excluded.epoch,sequence=excluded.sequence,wall=excluded.wall`,
    )
    .run(s.subjectId, s.sourceEpoch, s.sourceSequence, s.wallStartMs);
}
interface StatusHead {
  subject: string;
  start: number;
  last_at: number;
  valid_until: number;
  status: PublicStatus;
  active: number;
}
interface StatusInterval {
  start: number;
  end: number;
  status: PublicStatus;
}
/** Only one active tail per subject is touched. A previous process cannot vouch for downtime. */
async function sealStatusHistory(): Promise<void> {
  await transaction(async () => {
    for await (const raw of db.prepare('SELECT * FROM status_heads WHERE active=1').iterate()) {
      const head = raw as unknown as StatusHead;
      await db
        .prepare('UPDATE status_intervals SET "end"=LEAST("end",?) WHERE subject=? AND start=?')
        .run(head.last_at, head.subject, head.start);
      await db
        .prepare('DELETE FROM status_intervals WHERE subject=? AND start=? AND "end"<=start')
        .run(head.subject, head.start);
    }
    await db.exec(
      "UPDATE status_heads SET valid_until=last_at,active=0 WHERE active=1;UPDATE subjects SET status='UNKNOWN' WHERE status!='UNKNOWN'",
    );
  });
}
async function observeStatus(
  id: string,
  status: PublicStatus,
  at: number,
  leaseMs: number,
  transitionAt = at,
): Promise<void> {
  await transaction(async () => {
    const current = await requireSubject(id);
    // A response already in flight when monitoring was disabled cannot reopen its lease.
    if (!current.monitor || current.account_following === 0) return;
    const head = await one<StatusHead>('SELECT * FROM status_heads WHERE subject=?', id);
    if (head && at < head.last_at) return; // Clock rollback / out-of-order replies never rewrite history.
    if (head && transitionAt < head.last_at) throw new Error('INVALID_TRANSITION_TIME');
    if (!(await eventStore.observation(id, current.handle, status, transitionAt))) return;
    let start = transitionAt;
    if (head?.active && head.status === status && transitionAt <= head.valid_until) {
      start = head.start;
    } else if (head) {
      await db
        .prepare('UPDATE status_intervals SET "end"=LEAST("end",?) WHERE subject=? AND start=?')
        .run(transitionAt, id, head.start);
      await db
        .prepare('DELETE FROM status_intervals WHERE subject=? AND start=? AND "end"<=start')
        .run(id, head.start);
    }
    await db
      .prepare(
        'INSERT INTO status_intervals VALUES(?,?,?,?) ON CONFLICT(subject,start) DO UPDATE SET "end"=excluded."end",status=excluded.status',
      )
      .run(id, start, at + leaseMs, status);
    await db
      .prepare(
        'INSERT INTO status_heads(subject,start,last_at,valid_until,status,active,event_expired) VALUES(?,?,?,?,?,1,0) ON CONFLICT(subject) DO UPDATE SET start=excluded.start,last_at=excluded.last_at,valid_until=excluded.valid_until,status=excluded.status,active=1,event_expired=0',
      )
      .run(id, start, at, at + leaseMs, status);
    await db.prepare('UPDATE subjects SET status=?,observed=? WHERE id=?').run(status, at, id);
  });
}
async function disableStatus(id: string): Promise<void> {
  const head = await one<StatusHead>('SELECT * FROM status_heads WHERE subject=?', id);
  if (head?.active) {
    // Monitoring ends at the policy write; never stretch an already expired lease.
    const end = Math.max(head.last_at, Math.min(head.valid_until, Date.now()));
    await db
      .prepare('UPDATE status_intervals SET "end"=? WHERE subject=? AND start=?')
      .run(end, id, head.start);
    await db.prepare('UPDATE status_heads SET valid_until=?,active=0 WHERE subject=?').run(end, id);
  }
  await db.prepare("UPDATE subjects SET status='UNKNOWN' WHERE id=?").run(id);
}
async function statusHistory(
  id: string,
  from: number,
  to: number,
  count: number,
): Promise<StatusHistoryResponse> {
  await requireSubject(id);
  const buckets = Array.from({ length: count }, (_, index) => {
    const start = from + Math.floor(((to - from) * index) / count),
      end = from + Math.floor(((to - from) * (index + 1)) / count);
    return {
      fromMs: start,
      toMs: end,
      durationsMs: { PUBLIC: 0, PRIVATE: 0, OFFLINE: 0, UNKNOWN: end - start },
    };
  });
  const before = Math.min(to, Date.now());
  // Seek directly to the first overlapping interval, then stream, never materialize observations.
  const first = await one<{
    start: number;
  }>(
    'SELECT start FROM status_intervals WHERE subject=? AND "end">? ORDER BY "end",start LIMIT 1',
    id,
    from,
  );
  if (first)
    for await (const raw of db
      .prepare(
        'SELECT start,"end",status FROM status_intervals WHERE subject=? AND start>=? AND start<? ORDER BY start',
      )
      .iterate(id, first.start, before)) {
      const row = raw as unknown as StatusInterval;
      if (row.status === 'UNKNOWN') continue;
      const start = Math.max(from, row.start),
        end = Math.min(before, row.end);
      if (end <= start) continue;
      let index = Math.max(
        0,
        Math.min(count - 1, Math.floor(((start - from) * count) / (to - from))),
      );
      while (index < count && buckets[index].fromMs < end) {
        const bucket = buckets[index++],
          overlap = Math.max(0, Math.min(end, bucket.toMs) - Math.max(start, bucket.fromMs));
        bucket.durationsMs[row.status] += overlap;
        bucket.durationsMs.UNKNOWN -= overlap;
      }
    }
  return { subjectId: id, fromMs: from, toMs: to, buckets };
}
async function apply(record: JournalRecord, recovery = false): Promise<void> {
  return await transaction(async () => {
    const previous = await head(record.subject.id);
    if (record.revision <= previous) {
      return;
    }
    if (record.revision !== previous + 1) throw new Error('JOURNAL_REVISION_GAP');
    if (!(await db.prepare('SELECT id FROM subjects WHERE id=?').get(record.subject.id)))
      await addSubject(record.subject);
    if (record.kind === 'commit') {
      const s = record.segment;
      const existing = await db
        .prepare('SELECT id FROM segments WHERE subject=? AND epoch=? AND sequence=?')
        .get(s.subjectId, s.sourceEpoch, s.sourceSequence);
      if (existing) throw new Error('JOURNAL_DUPLICATE_SOURCE_IDENTITY');
      for (const o of record.objects) {
        const old = await one<ObjectRow>('SELECT * FROM objects WHERE id=?', o.id);
        if (old) {
          if (
            old.subject !== o.subjectId ||
            old.hash !== o.hash ||
            old.bytes !== o.bytes ||
            old.filename !== o.filename ||
            old.deleted
          )
            throw new Error('JOURNAL_OBJECT_CONFLICT');
        } else {
          await db
            .prepare(
              'INSERT INTO objects(id,subject,filename,bytes,hash,kind,needs_verify) VALUES(?,?,?,?,?,?,?)',
            )
            .run(o.id, o.subjectId, o.filename, o.bytes, o.hash, o.kind, recovery ? 1 : 0);
        }
      }
      await db
        .prepare(
          'INSERT INTO segments(id,subject,epoch,sequence,media,init,start,"end",json,created_revision) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          s.id,
          s.subjectId,
          s.sourceEpoch,
          s.sourceSequence,
          s.mediaObjectId,
          s.initObjectId,
          s.wallStartMs,
          s.wallEndMs,
          JSON.stringify(s),
          (await currentRevision()) + 1,
        );
      await saveSource(s);
      if (recovery) await units.defer();
      else if (await units.ready()) await units.append(s, (await currentRevision()) + 1);
      await addCoverage(s.subjectId, s.wallStartMs, s.wallEndMs);
      if (s.wallStartMs === null)
        await db.prepare('UPDATE subjects SET unlocated=unlocated+1 WHERE id=?').run(s.subjectId);
    } else if (record.kind === 'delete') {
      const minutes = new Set<number>();
      for (const id of record.segmentIds) {
        const s = await one<SegmentRow>(
          'SELECT * FROM segments WHERE id=? AND subject=? AND deleted=0',
          id,
          record.subject.id,
        );
        if (!s) continue;
        const value = JSON.parse(s.json) as Segment;
        if (value.wallStartMs !== null && value.wallEndMs !== null)
          for (
            let m = Math.floor(value.wallStartMs / MINUTE) * MINUTE;
            m < value.wallEndMs;
            m += MINUTE
          )
            minutes.add(m);
        const wasVisible = !!(await db
          .prepare('SELECT 1 FROM visible_segments WHERE id=? AND deleted=0')
          .get(id));
        await db.prepare('UPDATE segments SET deleted=1 WHERE id=?').run(id);
        await units.deleted(id, wasVisible);
        await db.prepare('UPDATE objects SET deleted=1 WHERE id=?').run(s.media);
        if (
          s.init &&
          !(await db
            .prepare('SELECT 1 FROM segments WHERE init=? AND deleted=0 LIMIT 1')
            .get(s.init))
        ) {
          await db.prepare('UPDATE objects SET deleted=1 WHERE id=?').run(s.init);
        }
        if (s.start === null)
          await db.prepare('UPDATE subjects SET unlocated=unlocated-1 WHERE id=?').run(s.subject);
      }
      for (const minute of minutes) await rebuildMinute(record.subject.id, minute);
      await db
        .prepare('UPDATE subjects SET deletion_revision=? WHERE id=?')
        .run((await currentRevision()) + 1, record.subject.id);
    } else throw new Error('INVALID_JOURNAL_KIND');
    await db
      .prepare(
        'INSERT INTO journal_heads VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision',
      )
      .run(record.subject.id, record.revision);
    await db.prepare('UPDATE counters SET revision=revision+1 WHERE id=1').run();
  });
}
async function sign(body: string): Promise<Buffer> {
  const secret = await privateSettings.get('archive.cursor-secret');
  if (!secret) throw new Error('CURSOR_SECRET_UNAVAILABLE');
  return createHmac('sha256', secret).update(body).digest();
}
async function encodeCursor(cursor: Cursor): Promise<string> {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${body}.${(await sign(body)).toString('base64url')}`;
}
async function decodeCursor(token: string): Promise<Cursor> {
  try {
    if (token.length > 4096) throw new Error();
    const [body, signature, extra] = token.split('.');
    const actual = Buffer.from(signature ?? '', 'base64url'),
      expected = await sign(body);
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as Cursor;
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
async function snapshotSession(id: string, at: number): Promise<SnapshotSession | null> {
  const offline = await one<{
    start: number;
    end: number;
  }>(
    'SELECT start,"end" FROM status_intervals WHERE subject=? AND status=\'OFFLINE\' AND start<=? AND "end">? LIMIT 1',
    id,
    at,
    at,
  );
  const previous = await one<{
    end: number;
  }>(
    'SELECT "end" FROM status_intervals WHERE subject=? AND status=\'OFFLINE\' AND "end"<=? ORDER BY "end" DESC LIMIT 1',
    id,
    at,
  );
  const next = await one<{
    start: number;
  }>(
    "SELECT start FROM status_intervals WHERE subject=? AND status='OFFLINE' AND start>? ORDER BY start LIMIT 1",
    id,
    at,
  );
  // A sampled OFFLINE lease cannot invalidate actual PDT footage. Conflicting
  // footage forms a bounded evidence window, never absorbs adjacent broadcasts.
  const lo = offline?.start ?? previous?.end ?? 0,
    hi = offline?.end ?? next?.start ?? Number.MAX_SAFE_INTEGER;
  const earliest = await one<{
    start: number;
  }>(
    `SELECT start FROM visible_segments WHERE subject=? AND deleted=0 AND start>=? AND start<? AND "end">? ORDER BY start,id LIMIT 1`,
    id,
    Math.max(0, lo - 86400000),
    hi,
    lo,
  );
  if (!earliest) return null;
  // Tombstones retain broadcast identity. Deleting its first visible fragment
  // must not shift every surviving minute sample (and invalidate its image URL).
  const origin = (await one<{
    start: number;
  }>(
    'SELECT start FROM segments WHERE subject=? AND start>=? AND start<? AND "end">? ORDER BY start,id LIMIT 1',
    id,
    Math.max(0, lo - 86400000),
    hi,
    lo,
  ))!;
  const online =
    !offline && previous
      ? await one<{
          start: number;
        }>(
          "SELECT start FROM status_intervals WHERE subject=? AND status IN ('PUBLIC','PRIVATE') AND start=? AND start<? LIMIT 1",
          id,
          lo,
          hi,
        )
      : undefined;
  // Only a contiguous observed OFFLINE -> online transition establishes a known
  // start; first monitoring/recording cannot reconstruct the original broadcast.
  const fromMs = online
    ? Math.min(online.start, Math.max(lo, origin.start))
    : Math.max(lo, origin.start);
  const latest = (await one<{
    end: number;
  }>(
    'SELECT "end" FROM visible_segments WHERE subject=? AND deleted=0 AND "end">? AND start<? ORDER BY "end" DESC LIMIT 1',
    id,
    fromMs,
    hi,
  ))!;
  return {
    fromMs,
    toMs: offline?.end ?? next?.start ?? Math.max(Date.now(), at + 1, latest.end),
    startBasis: online ? 'observed-online' : 'recorded-media',
    ended: !!offline || !!next,
  };
}
async function snapshotLayoutVersion(id: string): Promise<string> {
  return `${units.generation(id)}:${(await requireSubject(id)).deletion_revision}`;
}
async function snapshotPages(
  id: string,
  at: number,
  requestedPage: number,
  limit: number,
  window: MediaTimeRange,
  followLive = false,
  playbackUnitId?: string,
): Promise<SnapshotPagesResponse> {
  const subject = await requireSubject(id);
  const session = await snapshotSession(id, at);
  const playbackUnitPage =
    playbackUnitId && !followLive ? await snapshotLayouts.locate(id, window, playbackUnitId) : null;
  let view: Awaited<
    ReturnType<InstanceType<typeof SnapshotLayoutModule.SnapshotLayoutIndex>['page']>
  >;
  if (followLive) {
    const rows = (await units.page(id, window, [window.toMs, ''], 32, true)).reverse();
    const cells = recordingLayout(rows, window, true);
    const retained = new Set(cells.flatMap((c) => (c.kind === 'unit' ? [c.unitId!] : [])));
    const actual = rows.filter((r) => retained.has(r.id));
    view = {
      cells,
      page: 1,
      pages: cells.length ? 1 : 0,
      pageOffset: 0,
      total: actual.length,
      slotCount: cells.length,
      pageAnchors: actual.length ? [actual[0].start] : [],
      occupiedPages: actual.length ? [1] : [],
      first: actual[0],
      last: actual.at(-1),
    };
  } else view = await snapshotLayouts.page(id, window, 'layout', requestedPage, limit);
  if (session && view.first && view.last)
    Object.assign(session, {
      selectionFromMs: view.first.start,
      selectionToMs: view.last.end,
      selectionOpen: !view.last.closed,
    });
  const positions = new Map(
    view.cells.filter((c) => c.kind === 'unit').map((c) => [c.unitId!, c.index]),
  );
  const items = (view.items ?? (await units.items(id, [...positions.keys()]))).map((item) => ({
    ...item,
    gridIndex: positions.get(item.unitId),
  }));
  return {
    subjectId: id,
    displayWindow: {
      fromMs: followLive && view.first ? view.first.start : window.fromMs,
      toMs: window.toMs,
    },
    ...(playbackUnitId
      ? {
          playbackUnitPage: followLive
            ? view.cells.some((cell) => cell.unitId === playbackUnitId)
              ? 1
              : null
            : playbackUnitPage,
        }
      : {}),
    session,
    total: view.total,
    occupiedPages: view.occupiedPages,
    pageAnchors: view.pageAnchors,
    pageOffset: view.pageOffset,
    slotCount: view.slotCount,
    cells: view.cells,
    page: view.page,
    pages: view.pages,
    limit,
    deletionRevision: subject.deletion_revision,
    items,
  };
}
async function snapshotUnit(id: string, at: number, unitId?: string): Promise<SnapshotItem | null> {
  await requireSubject(id);
  const unit = unitId ? await units.get(id, unitId) : await units.at(id, at);
  return unit ? await units.item(unit) : null;
}
function lower(values: number[], target: number, inclusive = false): number {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target || (inclusive && values[mid] === target)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
async function coverage(
  id: string,
  from: number,
  to: number,
  count: number,
): Promise<CoverageResponse> {
  const subject = await requireSubject(id);
  const buckets: CoverageBucket[] = Array.from({ length: count }, (_, i) => ({
    fromMs: from + Math.floor(((to - from) * i) / count),
    toMs: from + Math.floor(((to - from) * (i + 1)) / count),
    coveredMs: 0,
    segmentCount: 0,
  }));
  const occupy = (bucket: CoverageBucket, lo: number, hi: number): void => {
    if (hi <= lo) return;
    bucket.coveredMs += hi - lo;
    bucket.mediaFromMs = Math.min(bucket.mediaFromMs ?? Infinity, lo);
    bucket.mediaToMs = Math.max(bucket.mediaToMs ?? -Infinity, hi);
  };
  if (await deletionStore.pending(id)) {
    // Pending deletion is already absent from the logical archive. Stream the
    // remaining indexed spans until physical GC catches up; never load all IDs.
    let start = -1,
      end = -1;
    const add = (lo: number, hi: number): void => {
      const first = Math.max(
        0,
        Math.min(count - 1, Math.floor(((lo - from) * count) / (to - from))),
      );
      for (let b = first; b < count && buckets[b].fromMs < hi; b++)
        occupy(buckets[b], Math.max(lo, buckets[b].fromMs), Math.min(hi, buckets[b].toMs));
    };
    for await (const raw of db
      .prepare(
        `SELECT s.start,s."end" FROM recording_units u JOIN unit_segments m ON m.unit=u.id
        JOIN segments s ON s.id=m.segment WHERE u.subject=? AND u.deleted=0 AND u.start>? AND u.start<? AND u."end">?
        AND NOT EXISTS(SELECT 1 FROM deletion_intent_units x WHERE x.unit=u.id)
        AND s.deleted=0 AND s.start<? AND s."end">? ORDER BY s.start,s.id`,
      )
      .iterate(id, from - 86460000, to, from, to, from)) {
      const row = raw as {
        start: number;
        end: number;
      };
      const lo = Math.max(from, row.start),
        hi = Math.min(to, row.end);
      const first = Math.max(
        0,
        Math.min(count - 1, Math.floor(((lo - from) * count) / (to - from))),
      );
      for (let b = first; b < count && buckets[b].fromMs < hi; b++) buckets[b].segmentCount++;
      if (start < 0) {
        start = lo;
        end = hi;
      } else if (lo <= end) end = Math.max(end, hi);
      else {
        add(start, end);
        start = lo;
        end = hi;
      }
    }
    if (start >= 0) add(start, end);
    return {
      subjectId: id,
      fromMs: from,
      toMs: to,
      buckets,
      unlocatedCount: subject.unlocated,
      revision: await currentRevision(),
    };
  }
  const startCounts = new Array<number>(count).fill(0),
    endCounts = new Array<number>(count).fill(0);
  let active = 0;
  const rows = await many<
    MinuteSummary & {
      first: number;
      last: number;
    }
  >(
    'SELECT minute,count,covered_ms,start_count,end_count,(spans::json->0->>0)::double precision AS first,(spans::json->-1->>1)::double precision AS last FROM coverage_minutes WHERE subject=? AND minute>=? AND minute<? ORDER BY minute',
    id,
    Math.floor(from / MINUTE) * MINUTE,
    to,
  );
  let bucketIndex = 0;
  for (const row of rows) {
    while (bucketIndex < count && buckets[bucketIndex].toMs <= row.minute) bucketIndex++;
    if (row.minute === from) active = row.count - row.start_count;
    if (
      bucketIndex < count &&
      buckets[bucketIndex].fromMs <= row.minute &&
      buckets[bucketIndex].toMs >= row.minute + MINUTE
    ) {
      buckets[bucketIndex].coveredMs += row.covered_ms;
      if (row.covered_ms > 0) {
        const bucket = buckets[bucketIndex];
        bucket.mediaFromMs = Math.min(bucket.mediaFromMs ?? Infinity, row.minute + row.first);
        bucket.mediaToMs = Math.max(bucket.mediaToMs ?? -Infinity, row.minute + row.last);
      }
      startCounts[bucketIndex] += row.start_count;
      endCounts[bucketIndex] += row.end_count;
      continue;
    }
    const detail = await one<Minute>(
      'SELECT spans,starts,ends FROM coverage_minutes WHERE subject=? AND minute=?',
      id,
      row.minute,
    );
    if (!detail) throw new Error('COVERAGE_INDEX_INCONSISTENT');
    const spans = JSON.parse(detail.spans) as number[][],
      starts = JSON.parse(detail.starts) as number[],
      ends = JSON.parse(detail.ends) as number[];
    if (row.minute < from && row.minute + MINUTE > from)
      active =
        row.count -
        (starts.length - lower(starts, from - row.minute)) -
        lower(ends, from - row.minute, true);
    for (let b = bucketIndex; b < count && buckets[b].fromMs < row.minute + MINUTE; b++) {
      const lo = Math.max(from, buckets[b].fromMs) - row.minute,
        hi = Math.min(to, buckets[b].toMs) - row.minute;
      for (const [s, e] of spans)
        occupy(buckets[b], row.minute + Math.max(s, lo), row.minute + Math.min(e, hi));
      startCounts[b] += lower(starts, hi) - lower(starts, lo);
      endCounts[b] += lower(ends, hi, true) - lower(ends, lo, true);
    }
  }
  for (let b = 0; b < count; b++) {
    buckets[b].segmentCount = active + startCounts[b];
    active += startCounts[b] - endCounts[b];
  }
  return {
    subjectId: id,
    fromMs: from,
    toMs: to,
    buckets,
    unlocatedCount: subject.unlocated,
    revision: await currentRevision(),
  };
}
const unitIndexObservation = {
  processed: 0,
  lastRunAtMs: null as number | null,
  lastSuccessAtMs: null as number | null,
};
async function publishDeletionGeneration(id: string, from: number, to: number): Promise<void> {
  db.afterCommit(() => snapshotLayouts.invalidate(id, from, to, true));
  await db.prepare('UPDATE counters SET revision=revision+1 WHERE id=1').run();
  await db
    .prepare('UPDATE subjects SET deletion_revision=? WHERE id=?')
    .run(await currentRevision(), id);
}
const handlers: Record<string, (input: RequestInput) => unknown> = {
  markUnitsSeen: async ({ id, seenEvidence }) =>
    await transaction(() => personalStore.markSeen(id, seenEvidence!)),
  prepareAccountSubjects: async ({ subjects, generation }) =>
    await transaction(async () => await accountSubjects.prepare(subjects, generation!)),
  activateAccountSubjects: async ({ generation }) =>
    await transaction(async () => await accountSubjects.activate(generation!)),
  discardAccountPreparation: async ({ generation }) =>
    await transaction(async () => await accountSubjects.discard(generation!)),
  accountActivation: async () => await accountSubjects.current(),
  prepareSnapshotLayout: async ({ id, window }) =>
    await snapshotLayouts.prepare(id, window, 'layout'),
  beginMediaSelection: async ({ id, window, selectionMode, selectionOptions }) =>
    await transaction(
      async () => await selections.begin(id, window, selectionMode!, selectionOptions),
    ),
  buildMediaSelection: async ({ id, selectionId }) =>
    await transaction(async () => await selections.build(id, selectionId!)),
  stageSelectionPatch: async ({ id, selectionId, selectionPatch }) =>
    await transaction(
      async () => await selections.patch(id, selectionId!, selectionPatch ?? {}, false),
    ),
  selectionMaintenance: async () =>
    await transaction(async () => (await selections.cleanup()) || (await deletionStore.cleanup())),
  favoriteSubjects: async (input?: RequestInput) =>
    await favoriteCommands.subjects(input?.limit ?? 1, input?.excludedSubjects),
  materializeFavorites: async (input?: RequestInput) =>
    await transaction(async () => await favoriteCommands.step(input?.id)),
  favoriteMaterializationStatus: async () => await favoriteCommands.status(),
  mediaSelection: async ({ id, selectionId }) => await selections.summary(id, selectionId!),
  favoriteMediaSelection: async ({ id, selectionId, liked, personalRevision }) =>
    await transaction(
      async () => await favoriteCommands.accept(id, selectionId!, liked!, personalRevision!),
    ),
  beginSelectedDeletionPlan: async ({ id, selectionId, selectionPatch }) =>
    await transaction(async () => {
      await selections.summary(id, selectionId!);
      const job = await deletionStore.begin(id, [], await currentRevision(), []);
      await selections.copyToDeletion(id, selectionId!, job, selectionPatch ?? {});
      return job;
    }),
  storageStatus: () => library.status(),
  unitIndexStatus: async () => ({ ready: await units.ready(), ...unitIndexObservation }),
  buildRecordingUnits: async ({ limit }) => {
    const building = !(await units.ready());
    if (building) unitIndexObservation.lastRunAtMs = Date.now();
    const more = await transaction(async () => {
      const pending = await units.build(limit ?? 128);
      if (building && !pending)
        await db.exec(
          "UPDATE recording_units SET closed=1 WHERE closed=0 AND subject IN(SELECT id FROM subjects WHERE status IN('OFFLINE','PRIVATE'))",
        );
      return pending;
    });
    if (building) {
      unitIndexObservation.processed++;
      if (!more) unitIndexObservation.lastSuccessAtMs = Date.now();
    }
    return more;
  },
  unitBounds: async ({ id, from, to }) => {
    const selected = await units.bounds(id, { fromMs: from, toMs: to }),
      last = selected.at(-1);
    return selected.length
      ? {
          fromMs: selected[0].start,
          toMs: Math.max(...selected.map((u) => u.end)),
          ...(!last!.closed && (await requireSubject(id)).status === 'PUBLIC'
            ? { openUnitId: last!.id }
            : {}),
        }
      : null;
  },
  unitRange: async ({ id, unitId }) => {
    const unit = await units.get(id, unitId!);
    return unit
      ? {
          fromMs: unit.start,
          toMs: unit.end,
          open: !unit.closed && (await requireSubject(id)).status === 'PUBLIC',
        }
      : null;
  },
  unitSource: async ({ id, unitId, at }) => {
    const row = await one<{
      json: string;
    }>(
      `SELECT s.json FROM visible_recording_units u JOIN unit_segments m ON m.unit=u.id
        JOIN segments s ON s.id=m.segment WHERE u.id=? AND u.subject=? AND s.deleted=0
        AND s."end">? ORDER BY s.start,s.id LIMIT 1`,
      unitId!,
      id,
      at,
    );
    return row ? (await readSegments([row]))[0] : null;
  },
  snapshotForSegment: async ({ id, segmentId }) => {
    const member = await one<{
      unit: string;
    }>('SELECT unit FROM unit_segments WHERE segment=?', segmentId!);
    const unit = member ? await units.get(id, member.unit) : undefined;
    return unit ? await units.item(unit) : null;
  },
  snapshotUnits: async ({ id, cursor, limit }) => {
    await requireSubject(id);
    const seek: unknown = cursor ? JSON.parse(cursor) : [-1, ''];
    if (
      !Array.isArray(seek) ||
      seek.length !== 2 ||
      typeof seek[0] !== 'number' ||
      !Number.isSafeInteger(seek[0]) ||
      typeof seek[1] !== 'string'
    )
      throw Error('INVALID_UNIT_CURSOR');
    const rows = await many<UnitsModule.RecordingUnit>(
      `SELECT u.* FROM visible_recording_units u WHERE subject=?
      AND (created_revision,id)>(?,?)
      ORDER BY created_revision,id LIMIT ?`,
      id,
      seek[0],
      seek[1],
      limit,
    );
    const last = rows.at(-1);
    return {
      items: await units.items(
        id,
        rows.map((unit) => unit.id),
      ),
      cursor: last ? JSON.stringify([last.created_revision, last.id]) : (cursor ?? null),
    };
  },
  unitFavoriteQuery: async ({ id, ids }) => await personalStore.readUnits(id, ids),
  beginDeletionPlan: async ({ id, ranges }) =>
    await transaction(
      async () =>
        await deletionStore.begin(id, await units.snap(id, ranges!), await currentRevision()),
    ),
  buildDeletionPlan: async ({ id }) =>
    await transaction(
      async () => (await selections.copyDeletion(id)) || (await deletionStore.build(id)),
    ),
  deletionPlan: async ({ id }) => await deletionStore.plan(id),
  enqueueMediaDeletion: async ({ id, planId, personalRevision }) =>
    await transaction(async () => {
      const job = await deletionStore.accept(id, planId!, personalRevision!);
      if (!job) return null;
      await publishDeletionGeneration(id, job.fromMs ?? 0, job.toMs ?? Number.MAX_SAFE_INTEGER);
      return job;
    }),
  acceptedMediaDeletion: async ({ id, planId }) => {
    const job = await deletionStore.get(planId!);
    if (job.subjectId !== id) throw Error('STALE_DELETE_PLAN');
    return String(job.state) === 'planned' ? null : job;
  },
  mediaDeletionJobs: async () => await deletionIntents.list(),
  admitDeletionIntent: async ({ id, commandId, deletionTarget }) =>
    await transaction(async () => {
      const existing = await db
        .prepare('SELECT 1 FROM deletion_intents WHERE job=?')
        .get(commandId!);
      const job = await deletionIntents.admit(id, commandId!, deletionTarget!);
      if (existing) return job;
      await publishDeletionGeneration(id, job.fromMs ?? 0, job.toMs ?? Number.MAX_SAFE_INTEGER);
      await db
        .prepare('UPDATE deletion_intents SET revision=? WHERE job=?')
        .run(await currentRevision(), commandId!);
      return await deletionIntents.get(commandId!);
    }),
  prepareDeletionIntent: async (input?: RequestInput) =>
    (await units.ready())
      ? await transaction(async () => {
          const job = await deletionIntents.step(input?.commandId);
          if (job && ['failed', 'queued', 'completed'].includes(job.state)) {
            await publishDeletionGeneration(
              job.subjectId,
              job.fromMs ?? 0,
              job.toMs ?? Number.MAX_SAFE_INTEGER,
            );
          }
          return job;
        })
      : null,
  pendingDeletionIntent: async (input?: RequestInput) =>
    (await units.ready()) ? await deletionIntents.pending(input?.excludedSubjects) : null,
  retryDeletionIntent: async ({ id }) =>
    await transaction(async () => await deletionIntents.retry(id)),
  nextMediaDeletion: async (input?: RequestInput) =>
    await transaction(async () => await deletionStore.next(input?.excludedSubjects)),
  advanceMediaDeletion: async ({ id, processed, reclaimedBytes }) =>
    await transaction(async () => await deletionStore.advance(id, processed!, reclaimedBytes!)),
  retryMediaDeletion: async ({ id }) => await deletionStore.retry(id),
  upsert: async ({ subjects, syncAccount }) =>
    await transaction(async () => await accountSubjects.upsert(subjects, syncAccount)),
  list: async () =>
    (await many<SubjectRow>(`${subjectSelect} ORDER BY s.handle,s.id`)).map(subject),
  findSubject: async ({ id }) => {
    const row = await one<SubjectRow>(`${subjectSelect} WHERE s.id=?`, id);
    return row ? subject(row) : null;
  },
  subject: async ({ id }) => subject(await requireSubjectDetails(id)),
  policy: async ({ id, patch }) =>
    await transaction(async () => {
      await requireSubject(id);
      if (patch.autoRecord === true && (await requireSubjectDetails(id)).account_following === 0)
        throw Error('SUBJECT_ARCHIVED');
      if (patch.monitorEnabled !== undefined)
        await db
          .prepare('UPDATE subjects SET monitor=? WHERE id=?')
          .run(patch.monitorEnabled ? 1 : 0, id);
      if (patch.autoRecord !== undefined)
        await db
          .prepare('UPDATE subjects SET auto_record=? WHERE id=?')
          .run(patch.autoRecord ? 1 : 0, id);
      if (patch.monitorEnabled === false) await disableStatus(id);
      if (patch.monitorEnabled === false || patch.autoRecord === false) await units.seal(id);
      return subject(await requireSubjectDetails(id));
    }),
  globalRecording: async ({ enabled }) =>
    await transaction(async () => {
      // The default and existing policies commit together, serialized with list sync.
      await db
        .prepare(
          "INSERT INTO settings VALUES('recording.default',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(enabled));
      const rows = await many<{ id: string }>(
        'SELECT s.id FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id WHERE a.following IS DISTINCT FROM 0',
      );
      await db
        .prepare(
          'UPDATE subjects SET auto_record=?,monitor=1 WHERE id IN (SELECT s.id FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id WHERE a.following IS DISTINCT FROM 0)',
        )
        .run(enabled ? 1 : 0);
      if (!enabled) for (const { id } of rows) await units.seal(id);
    }),
  policies: async ({ ids, patch }) =>
    await transaction(async () => {
      for (const id of ids) {
        await requireSubject(id);
        if (patch.autoRecord === true && (await requireSubjectDetails(id)).account_following === 0)
          throw Error('SUBJECT_ARCHIVED');
      }
      for (const id of ids) {
        if (patch.monitorEnabled !== undefined)
          await db
            .prepare('UPDATE subjects SET monitor=? WHERE id=?')
            .run(patch.monitorEnabled ? 1 : 0, id);
        if (patch.autoRecord !== undefined)
          await db
            .prepare('UPDATE subjects SET auto_record=? WHERE id=?')
            .run(patch.autoRecord ? 1 : 0, id);
        if (patch.monitorEnabled === false) await disableStatus(id);
        if (patch.monitorEnabled === false || patch.autoRecord === false) await units.seal(id);
      }
      return ids.length;
    }),
  observation: async ({ id, status, at, leaseMs, transitionAt }) => {
    const result = await observeStatus(id, status, at, leaseMs, transitionAt);
    if (status === 'OFFLINE' || status === 'PRIVATE') await units.seal(id);
    return result;
  },
  statusHistory: async ({ id, from, to, buckets }) => await statusHistory(id, from, to, buckets),
  snapshotPages: async ({ id, at, page, limit, window, followLive, unitId }) =>
    await snapshotPages(id, at, page, limit, window, followLive, unitId),
  snapshotUnit: async ({ id, at, unitId }) => await snapshotUnit(id, at, unitId),
  events: async ({ eventAfter, eventBefore, limit }) =>
    await eventStore.list(eventAfter, limit, eventBefore),
  eventMeta: async () => await eventStore.meta(),
  identity: () => personalStore.identity,
  subjectPreview: async ({ id }) =>
    (
      await one<{
        preview: string;
      }>('SELECT preview FROM subject_images WHERE subject=?', id)
    )?.preview ?? null,
  personalRevision: async () => await personalStore.revision(),
  personal: async ({ id, from, to }) => {
    await requireSubject(id);
    return await personalStore.read(id, from, to);
  },
  favoriteSubject: async ({ id }) =>
    (
      await one<{
        subject: string;
      }>('SELECT subject FROM recording_units WHERE id=?', id)
    )?.subject ?? null,
  ackEvents: async ({ readCursor }) =>
    await transaction(async () => await eventStore.ack(readCursor)),
  startRun: async ({ at }) => await transaction(async () => await eventStore.start(at)),
  heartbeatRun: async ({ id, at }) =>
    await transaction(async () => await eventStore.heartbeat(id, at)),
  stopRun: async ({ id, outcome, at }) =>
    await transaction(async () => await eventStore.stop(id, outcome, at)),
  runHistory: async ({ from, to }) => await eventStore.runs(from, to),
  settingGet: async ({ key }) =>
    portableSetting(key)
      ? ((
          await one<{
            value: string;
          }>('SELECT value FROM settings WHERE key=?', key)
        )?.value ?? null)
      : await privateSettings.get(key),
  settingSet: async ({ key, value }) => {
    if (!portableSetting(key)) {
      await privateSettings.set(key, value);
      return;
    }
    await db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  },
  head: async ({ id }) => await head(id),
  heads: async () => await db.prepare('SELECT subject,revision FROM journal_heads').all(),
  apply: async ({ record, recovery }) => await apply(record, recovery),
  beginSession: async () => {
    const clean =
      (
        await one<{
          value: string;
        }>('SELECT value FROM settings WHERE key=?', 'archive.clean')
      )?.value === '1';
    await db
      .prepare(
        "INSERT INTO settings VALUES('archive.clean','0') ON CONFLICT(key) DO UPDATE SET value='0'",
      )
      .run();
    return clean;
  },
  sourceCheckpoint: async ({ id }) => {
    await requireSubject(id);
    const row = await one<{
      epoch: string;
      sequence: string;
      wall: number | null;
    }>('SELECT * FROM source_checkpoints WHERE subject=?', id);
    return row
      ? ({
          epoch: row.epoch,
          highestSequence: row.sequence,
          lastWallStartMs: row.wall,
        } satisfies SourceCheckpoint)
      : null;
  },
  coverage: async ({ id, from, to, buckets, includeProtection }) => ({
    ...(await coverage(id, from, to, buckets)),
    seenSpans: await personalStore.seenCoverage(id, from, to, buckets),
    ...(includeProtection
      ? {
          protectedSpans: await personalStore.protectedCoverage(
            id,
            from,
            to,
            buckets,
            await snapshotLayoutVersion(id),
          ),
        }
      : {}),
  }),
  source: async ({ subjectId, epoch, sequence }) => {
    const row = await one<Pick<SegmentRow, 'json' | 'deleted'>>(
      `SELECT s.json,(s.deleted<>0 OR NOT EXISTS(SELECT 1 FROM visible_segments v WHERE v.id=s.id))::integer deleted FROM segments s WHERE s.subject=? AND s.epoch=? AND s.sequence=?`,
      subjectId,
      epoch,
      sequence,
    );
    return row ? { segment: JSON.parse(row.json) as Segment, deleted: row.deleted === 1 } : null;
  },
  init: async ({ id, hash }) => {
    const row = await one<ObjectRow>(
      "SELECT * FROM objects WHERE subject=? AND kind='init' AND hash=? AND deleted=0 LIMIT 1",
      id,
      hash,
    );
    return row ? objectRow(row) : null;
  },
  media: async ({ id }) => {
    const row = await one<ObjectRow>(
      `SELECT o.* FROM objects o WHERE o.id=? AND o.deleted=0 AND
      (o.kind='init' OR EXISTS(SELECT 1 FROM visible_segments s WHERE s.id=o.id AND s.deleted=0))`,
      id,
    );
    return row ? objectRow(row) : null;
  },
  hasMedia: async ({ ids }) =>
    !ids.length ||
    (
      await one<{
        count: number;
      }>(hasMediaSql, JSON.stringify(ids))
    )?.count === ids.length,
  knownObjects: async ({ ids, subjectId }) =>
    (
      await many<{
        id: string;
      }>(
        'SELECT id FROM objects WHERE subject=? AND id IN (SELECT value FROM json_array_elements_text(?::json))',
        subjectId,
        JSON.stringify(ids),
      )
    ).map((row) => row.id),
  liveObjects: async ({ after }) => (await many<ObjectRow>(liveObjectsSql, after)).map(objectRow),
  unverifiedObjects: async () =>
    (
      await many<ObjectRow>('SELECT * FROM objects WHERE deleted=0 AND needs_verify=1 LIMIT 128')
    ).map(objectRow),
  verified: async ({ id }) => {
    await db.prepare('UPDATE objects SET needs_verify=0 WHERE id=?').run(id);
  },
  pendingGc: async ({ id }) =>
    (
      await many<ObjectRow>(
        'SELECT * FROM objects WHERE subject=? AND deleted=1 AND gc_done=0 ORDER BY id LIMIT 128',
        id,
      )
    ).map(objectRow),
  gcDone: async ({ segmentIds }) =>
    await transaction(async () => {
      const mark = db.prepare('UPDATE objects SET gc_done=1 WHERE id=? AND deleted=1');
      for (const id of segmentIds!) await mark.run(id);
    }),
  timeline: async ({ id, from, to, limit, cursor }) => {
    const s = await requireSubject(id);
    const state = cursor
      ? await decodeCursor(cursor)
      : {
          subject: id,
          from,
          to,
          limit,
          revision: await currentRevision(),
          deletion: s.deletion_revision,
          start: from - 86400000,
          id: '',
          unlocated: s.unlocated,
        };
    if (state.subject !== id || state.from !== from || state.to !== to || state.limit !== limit)
      throw new Error('INVALID_CURSOR');
    if (state.deletion !== s.deletion_revision) throw new Error('CURSOR_STALE');
    // Commit validation caps duration at one day. This lower bound avoids an
    // archive-wide prefix scan for an empty window late in a long recording.
    const rows = await many<{
      json: string;
      start: number;
      id: string;
    }>(
      'SELECT json,start,id FROM visible_segments WHERE subject=? AND deleted=0 AND (start,id)>(?,?) AND start<? AND "end">? AND created_revision<=? ORDER BY start,id LIMIT ?',
      id,
      state.start,
      state.id,
      to,
      from,
      state.revision,
      limit + 1,
    );
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      subjectId: id,
      fromMs: from,
      toMs: to,
      segments: await readSegments(page),
      unlocatedCount: state.unlocated,
      truncated: rows.length > limit,
      revision: state.revision,
      nextCursor:
        rows.length > limit && last
          ? await encodeCursor({ ...state, start: last.start, id: last.id })
          : null,
    };
  },
  locate: async ({ id, target, policy }) => {
    await requireSubject(id);
    let row = await one<{
      json: string;
    }>(
      'SELECT json FROM visible_segments WHERE subject=? AND deleted=0 AND start>? AND start<=? AND "end">? ORDER BY start DESC,id LIMIT 1',
      id,
      target - 86400000,
      target,
      target,
    );
    if (!row && policy === 'next')
      row = await one<{
        json: string;
      }>(
        'SELECT json FROM visible_segments WHERE subject=? AND deleted=0 AND start>=? ORDER BY start,id LIMIT 1',
        id,
        target,
      );
    if (!row && policy === 'previous')
      row = await one<{
        json: string;
      }>(
        'SELECT json FROM visible_segments WHERE subject=? AND deleted=0 AND "end"<=? ORDER BY "end" DESC,id LIMIT 1',
        id,
        target,
      );
    return row ? (await readSegments([row]))[0] : null;
  },
  deleteBatch: async ({ id, from, to, unlocated, cutoff, segmentIds }) => {
    await requireSubject(id);
    if (segmentIds)
      return (
        await many<{
          id: string;
        }>(
          `SELECT id FROM segments WHERE subject=? AND deleted=0 AND id IN (${segmentIds.map(() => '?').join(',')}) ORDER BY start,id LIMIT 128`,
          id,
          ...segmentIds,
        )
      ).map((r) => r.id);
    if (unlocated)
      return (
        await many<{
          id: string;
        }>(
          'SELECT id FROM segments WHERE subject=? AND deleted=0 AND start IS NULL ORDER BY id LIMIT 128',
          id,
        )
      ).map((r) => r.id);
    if (cutoff !== undefined)
      return (
        await many<{
          id: string;
        }>(
          'SELECT s.id FROM segments s JOIN unit_segments m ON m.segment=s.id JOIN recording_units u ON u.id=m.unit WHERE s.subject=? AND s.deleted=0 AND u."end"<=? AND NOT EXISTS(SELECT 1 FROM effective_unit_favorites f WHERE f.unit=u.id) ORDER BY s."end",s.id LIMIT 128',
          id,
          cutoff,
        )
      ).map((r) => r.id);
    return (
      await many<{
        id: string;
      }>(
        'SELECT s.id FROM segments s JOIN unit_segments m ON m.segment=s.id JOIN recording_units u ON u.id=m.unit WHERE s.subject=? AND s.deleted=0 AND u.start>? AND u.start<? AND u."end">? ORDER BY s.start,s.id LIMIT 128',
        id,
        from - 86400000,
        to,
        from,
      )
    ).map((row) => row.id);
  },
  close: async ({ clean }) => {
    await snapshotLayouts.close();
    if (clean)
      await transaction(
        async () =>
          await db
            .prepare(
              "INSERT INTO settings VALUES('archive.clean','1') ON CONFLICT(key) DO UPDATE SET value='1'",
            )
            .run(),
      );
    await library.close();
    await db.close();
    await privateSettings.close();
    await mediaInstance!.close();
    await instance.close();
  },
};
if (db?.isOpen) {
  const {
    metadataMutations: mutations,
    metadataBackgroundMutations,
    metadataStatementReads,
    metadataLane,
  } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? './metadata-policy.ts' : './metadata-policy.js',
      import.meta.url,
    ).href
  )) as typeof MetadataPolicyModule;
  const { attachWorkerRpc } = (await import(
    new URL(
      import.meta.url.endsWith('.ts') ? '../library/worker-rpc.ts' : '../library/worker-rpc.js',
      import.meta.url,
    ).href
  )) as typeof RpcModule;
  attachWorkerRpc({
    port,
    handlers,
    mutations,
    backgroundMutations: metadataBackgroundMutations,
    transaction,
    readTransaction: (action, method, background) =>
      db.postgres.inLane(
        background
          ? 'background'
          : metadataLane(method) === 'playback'
            ? 'playback'
            : 'interactive',
        () =>
          metadataStatementReads.has(method)
            ? action()
            : db.postgres.transaction(action, { readOnly: true, repeatableRead: true }),
      ),
    savepoint: async (sql) => await db.exec(sql),
    commitHookPosition: () => db.postgres.commitHookPosition(),
    rollbackCommitHooks: (position) => db.postgres.rollbackCommitHooks(position),
    afterBatch: () => {
      snapshotLayouts.expire();
      if (library.needsCheckpoint())
        void library
          .checkpoint()
          .catch((error) => console.error('library_checkpoint_failed', error));
    },
  });
}
