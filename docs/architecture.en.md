# Architecture and storage

[简体中文](architecture.md) · **English**

ST-Vault supports one administrator across multiple clients. A React/Vite workbench connects to Fastify through REST and SSE; one container runs Node, PostgreSQL 18 and FFmpeg for screenshots. The runtime has no browser, GPU decoding components or automatic key extractor. Dependency versions are defined by [package-lock.json](../package-lock.json) and the [Dockerfile](../deploy/Dockerfile).

## Data flow and module boundaries

Storage, HLS alignment and media directory dates remain UTC. The server validates deployment `TZ` and exposes it through the session API, giving every client the same display timezone independently of language. Calendar navigation uses local midnight/noon slots (`@date-fns/tz` handles DST); media duration remains actual UTC elapsed time. A natural day is not necessarily 24 hours.

```text
Site cookies → Account information / complete following list
Anonymous status and HLS → Shared per-broadcaster ingress → Browser live playback
                                                       → Original media → Units → Screenshots
Browser commands → HTTP → Archive worker → Library journal + PostgreSQL hot indexes
```

| Module                                                                                                                  | Responsibility                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [account](../apps/server/src/account) / [provider](../apps/server/src/provider)                                         | Account sync and anonymous upstream protocols; credentials never enter anonymous media requests                      |
| [network](../apps/server/src/network) / [ingest](../apps/server/src/ingest)                                             | Routing preferences, manual CDN tests and switching, shared fragment producers and buffers                           |
| [capture](../apps/server/src/capture) / [live](../apps/server/src/live)                                                 | Automatic recording policy and browser live sessions                                                                 |
| [archive](../apps/server/src/archive) / [library](../apps/server/src/library) / [database](../apps/server/src/database) | Media reads, units and commands, commit/recovery and database lifecycle                                              |
| [previews](../apps/server/src/previews) / [runtime](../apps/server/src/runtime)                                         | Image caches, screenshot jobs, clocks, budgets, health and shutdown order                                            |
| [http](../apps/server/src/http) / [api-schema](../packages/api-schema/src)                                              | Authentication, validation, authorized interfaces and shared contracts                                               |
| [UI](../apps/ui/src)                                                                                                    | App coordinates the workbench; features organize business functions, design/shared reuse assets, locales manage text |

## Status, recording and networking

“Record all models” is a persistent recording default, not an aggregate of individual switches. One archive transaction updates the default and all non-archived models. Newly added or re-followed models inherit it; routine list refreshes and online transitions preserve individual choices. Archiving still stops recording. The policy recovers with the portable library journal and uses the existing synchronization channel. An absent policy defaults to off; previous batch-operation intent is not inferred.

Status is evidence with an observation time and finite lease, not an indefinitely valid boolean. Failed/UNKNOWN results neither immediately overwrite known status nor renew it. A different known state requires an additional anonymous observation; confirmation backdates the transition to the first valid candidate observation. Privacy revocation does not wait for history confirmation. Restart and lease expiry preserve unknown gaps rather than inventing offline or continuous online states. Implementation and failure tests are in [provider](../apps/server/src/provider) and [archive](../apps/server/src/archive).

History is paginated by increasing event ID. Occurrence and detection times are separate, so late confirmation does not disturb read cursors. Program events record normal shutdowns and abnormal shutdowns discovered on restart. The last heartbeat is only a lower bound on failure time. Events, status and read positions belong to the recoverable media library; the UI no longer draws orange downtime coverage blocks.

Each broadcaster shares one normal upstream production path. Live playback consumes buffered media while recording commits independently in order; it does not wait for disk publication. Recording preserves the highest available source quality without transcoding. HLS PROGRAM-DATE-TIME is preferred for wall-clock alignment. Fragments without reliable time remain unlocated rather than using download time as broadcast time.

The website origin is locked after account connection and shared by list and anonymous metadata and status requests. HLS defaults to `edge-hls.doppiocdn.net` and then uses the saved manual choice. On a switch, each live producer cancels its old requests and resolves the selected node while retaining its published buffer and recording queue. Manual testing samples up to 2 MiB of real media per node in sequence and uses the result for display and sorting.

## Recording units and UI consistency

A complete source fragment belongs to one stable recording unit. Units form at roughly minute cadence without cutting video at natural-minute boundaries; a brief interruption does not itself create a new identity. The representative image prefers a decodable frame in the unit's first fragment. Growing units retain their sample anchor and URL. Images, selection snapping, favorites and deletion share the unit identity.

Live time, playback cursor and committed-media end are separate. Clicking an image seeks without freezing the live window; dragging a selection fixes the range. The server produces limited gaps and compressed page cells; clients must not infer page numbers from elapsed minutes. An image not yet generated differs from absent media.

Favorites are durably accepted and logically protect media before batched materialization; later members of an open unit inherit protection. Deletion durably accepts an intent and logically hides media before member preparation and physical reclamation. Acceptance seals selected open units so subsequent recording does not enter an old task. Unfinished steps resume after restart. Select-all uses a frozen selection token plus explicit exceptions, not a complete browser-side library list. Personal revisions and deletion generations reject stale results.

UI reads and cancellation are owned by business scopes. SSE signals invalidation, not complete business data. Timeline reads currently use three rows per packet and two packets in flight, with bounded caches prioritizing visible rows. Unchanged subject objects are reused; connection geometry is locally subscribed; animations follow actual geometry changes with batched measurements before writes. Exact playback updates do not redraw the whole coverage band, and archive time mapping uses a cumulative index with binary search.

Native scrolling owns pixel offsets; the virtual list updates when its visible row set changes. Restoration and the player connection retain exact offsets. Each coverage row uses one SVG with at most 15 density paths, preserving gaps and subpixel markers without giving every historical fragment its own DOM layout and glass animation. Drawing aggregation does not change the original time data used by screenshots, selection snapping, favorites or deletion.

Sorting, filtering and membership changes share viewport-only transitions. Final ordering and the browsing anchor are committed first; Web Animations then translates visible rows. Distant destinations stop at the viewport edge. Exit DOM is capped at about one screen for 360ms, without mounting distant rows or loading their images; neighbors fill the gaps. Interrupted updates continue from current visual positions, while scrolling, selection gestures and view changes take priority. Covers and timelines move together, with the selection and player connection following. Timing and easing reuse existing motion tokens; no animation dependency is added.

## Concurrency and scheduling

[execution-policy.ts](../apps/server/src/runtime/execution-policy.ts) plans network, decoder, file IO, publication and database capacity from effective CPU, memory and container constraints. Recording has no fixed room count, but buffers and queues remain bounded. More concurrency does not guarantee proportional HDD throughput.

Database pools separate general reads, playback, background reads, snapshots and writes. Foreground batches alternate fairly with bounded background steps; recording-unit backfill is background work. The single journal writer guarantees ordered logs and fsync consistency, rather than retaining a SQLite limitation. Interactive/playback read-only transactions limit each SQL statement to 15 seconds, excluding pool wait; this is not end-to-end cancellation. Snapshot connections are discarded when rollback fails.

The status panel groups sync, covers, recording, screenshots, deletion, favorite materialization, retention, integrity and checkpoints. A shared business clock schedules work without overlapping slow runs. Decoding, reconnection and timeout are operation lifecycles rather than one panel task per timer. Normal shutdown stops producers first, drains accepted work, then closes archiving and PostgreSQL.

## Storage and recovery

`data` contains deployment-private configuration and PostgreSQL hot indexes; `media` is the portable library. Separate SSD/HDD mounts are supported. Database storage must be local, and only one instance may write a library.

```text
data/
  postgres/18/                    PostgreSQL cluster
  private/                        Configuration master key and database credentials
  logs/                           Rotated logs
  backups/                        Frozen copies when upgrading legacy databases
media/
  library.json                    Library identity and checkpoint references
  catalog/                        Current and previous NDJSON checkpoints
  postgres-journal/               Ordered commit logs
  subjects/stripchat-<ID>/
    images/                       Cover and avatar
    recordings/YYYY-MM-DD/HH/     Original fragments, bucketed by UTC date/hour
    recordings/unlocated/         Media without reliable wall-clock location
    recordings/.staging/          Unpublished writes
    thumbnails/YYYY-MM-DD/HH/     JPEGs and source-validation metadata
```

The broadcaster key is `stripchat:<ID>`; names and automatically recorded former names are metadata. Paths are relative to the library root. Day/hour directories bound directory size, while requests use database indexes instead of rescanning video files. PIN, cookies, address keys and private network configuration are excluded from media checkpoints.

Media is written temporarily, fsynced and atomically published. Actual database row changes are fsynced to the media journal before committing hot indexes and acknowledging callers. Checkpoints pin a consistent snapshot and stream it without loading the whole database into memory. Current/previous checkpoints and required logs are retained. Missing indexes are rebuilt from them. Invalid complete records or sequence gaps cause explicit failure rather than silently discarding corruption.

Screenshots are recoverable background work; valid existing JPEGs are reused after image and source checks. Physical deletion does not hold the recording write lock for a long historical cleanup. Work is ordered per broadcaster and bounded across broadcasters. Unlink failure after a committed tombstone is retried without marking the entire library corrupt.

The current library manifest format is 2 and PostgreSQL catalog schema is 1. The retained format-5, dual-directory SQLite importer is a one-time upgrade path, not normal storage. Backup, movement and rollback constraints are in the [user guide](../README.en.md#backups-recovery-and-updates) and [maintenance guide](CONTRIBUTING.en.md#legacy-upgrades).
