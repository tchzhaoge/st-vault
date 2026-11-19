# HTTP API reference

[简体中文](api.md) · **English**

These endpoints serve the workbench in this repository; no independently versioned public API compatibility is promised. Request constraints are defined by [api-schema](../packages/api-schema/src/index.ts) and the HTTP modules' Zod schemas. Times are UTC epoch milliseconds and broadcaster IDs are `stripchat:<providerId>`; the UI uses `timeZone` returned by `/api/session` (deployment `TZ`). Calendar queries allow up to 8 UTC days to accommodate 7 local days across a DST fallback.

Except for health, static resources and local login/setup entry points, business endpoints require an administrator session. Routine status responses never return cookies or address keys; the explicit disconnect response below returns the former cookies for a reconnect draft. The `GET /api/keys/current` endpoint returns the single saved key to the administrator over HTTPS or a trusted local connection. Use `PUT /api/keys/current` with `{name, value}` to add or replace it. Mutations validate Origin and sensitive endpoints disable caching.

## Sessions and accounts

| Method and path                        | Behavior                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/session`                     | Administrator authentication and setup stage                                                                    |
| `POST /api/setup/session`              | Restricted setup authorization; legacy installations must verify the old password                               |
| `POST /api/setup`                      | Complete setup with `{pin}`, without requiring a site account                                                   |
| `POST /api/login` / `POST /api/logout` | PIN unlock / revoke current session                                                                             |
| `GET /api/account-sync`                | Account metadata and sync status, without credentials                                                           |
| `PUT /api/account-sync`                | Import `{cookiesText, origin}`                                                                                  |
| `DELETE /api/account-sync`             | Disconnect; return `{status, draft}` with former `{cookiesText, origin}` or null; HTTPS/loopback only, no-store |

Setup authorization is only for completing the PIN, not account, media or settings access. There are no site-password login, verification-code task or direct following-list import endpoints. Accounts use pasted cookies only. See [http/app.ts](../apps/server/src/http/app.ts).

Account endpoints require an unlocked administrator and return `Cache-Control: no-store, private`. Imports without an origin use the current source, or the default when disconnected. A connected domain is locked; updates for another domain return 409 `account_origin_locked`. Website probes obey the same connection lock. Disconnecting durably applies an empty following list, archives all broadcasters and stops recording; recovery continues after restart and existing recordings remain.

## Workbench and media

| Group          | Entry points and contract                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broadcasters   | `GET /api/subjects`; per-model/batch policy PATCH; `PUT /api/subjects/recording-default` persists `{enabled}` and applies it to all non-archived models |
| Timeline       | `GET /api/workbench` for visible rows; per-broadcaster timeline, coverage and recording-bounds                                                          |
| Live           | `POST /api/subjects/:id/live`; live-progress; session manifest/media; DELETE to close                                                                   |
| Replay         | `POST /api/playback`; session seek, close, manifest and authorized media reads                                                                          |
| Images         | preview/avatar JPEG, snapshot-pages and unit JPEG                                                                                                       |
| History        | events, events/meta, events/runs, events/read                                                                                                           |
| Network        | network/routes reads and updates the HLS CDN choice; network/probe manually tests CDNs or candidate login sites                                         |
| Administration | system, settings, keys, me/favorites                                                                                                                    |

`GET /api/network/routes` returns the available nodes in `cdnHosts`, the saved choice in `preferences.cdnHost`, the routes resolved by live producers in `activeCdns`, and manual test status in `cdnProbe`. Saving a different node cancels requests to the previous node and reconnects all live producers immediately.

`POST /api/network/probe` accepts `{kind: "cdn", subjectId?: string}` or `{kind: "sites"}` and returns 202. Progress arrives through shared refresh. CDN tests can run while the player is idle. Site tests require a disconnected account and no active account-sync task. Actual reads of the bound website are reported independently in `sites.access`.

Live sessions belong to an administrator owner. Replay reads enforce session, range and logical-deletion rules. Images are version-cached; a pending screenshot returns 202, not permanent absence.

`POST /api/playback` accepts gapPolicy values report, next, previous and next-or-previous. Deletion recovery uses next-or-previous: shrink the specified range to surviving complete units, prefer later media within it, and locate the last available instant when the cursor exceeds the remaining end. Earlier media is allowed if no later media remains. Explicit unitId reads must locate that identity rather than substitute a different unit. Empty fixed ranges return 409 coverage_gap and remain empty in the client, without searching outside. Ordinary next requests never fall back backward, preventing end-of-replay loops.

`GET /api/subjects/:id/snapshot-pages` accepts at, from, to, page and limit. The limit maximum is 1000; UI pages use 30 cells. Optional unitId provides exact playbackUnitPage; follow=1 follows the live tail and page=last directly reads the last page. Items are recording units; total counts visible units in the actual display range regardless of JPEG readiness. Cells are unit, gap or pending; slotCount is the compressed cell count and pageOffset the first cell on this page. Gaps are not images and cannot be liked or deleted. Gaps below a minute use no cells, one–two minutes use one, two–three use two, and longer gaps use at most three. Entirely empty pages are not generated.

Pages correspond to this request's limit. occupiedPages and pageAnchors provide 30-cell navigation and time lookup; elapsed minutes cannot be used to infer page numbers. Live mode retains at most 30 tail cells, removes leading gaps, and aligns displayWindow.fromMs and session.selectionFromMs with the first retained complete unit. displayWindow.toMs preserves the requested right boundary. Display and batch selection use that actual range, excluding outside units. Replay retains pagination for the full requested range. Normal/fullscreen modes share live boundaries, unit identities and 30-cell reads; scrolling changes the current page rather than loading a historical prefix.

Every response includes deletionRevision, the broadcaster's deletion generation, covering accepted deletion and retention tombstones without changing for ordinary fragment growth. Clients must not combine display blocks from different generations. A newer generation evicts old caches and rejects late old responses. Range commands are separate from bounded display caches. Unlike all uses a server-frozen range token; Delete unliked directly submits a durable range intent. Both cover the entire current time range, not only the visible page. The browser neither downloads the full directory nor maintains multi-selection membership. Stale personal revisions or deletion generations return 409; tokens are not silently rebuilt into larger scopes.

Implementation: [live](../apps/server/src/http/live.ts), [images](../apps/server/src/http/previews.ts), [workbench](../apps/server/src/http/workbench.ts), [history](../apps/server/src/http/events.ts), [network](../apps/server/src/http/network-routing.ts).

Screenshot unitId identifies a stable set of complete source fragments. slotFromMs/slotToMs give its actual full range; open means it can grow, and atMs is its stable representative sample anchor. A fragment crossing a natural minute is not cut. The view determines which units intersect without rewriting their bounds. The JPEG URL's to is a stable decode-search ceiling, still limited to that unit; appending fragments does not repeatedly change URLs or resample. gridIndex is server-provided placement, not atMs divided by 60000.

recording-bounds snaps a drag selection outward to complete intersecting units. Live time, playback cursor and disk end remain distinct. An open unit's openUnitId allows replay to await new members of that unit without importing unrelated later recordings.

Nonempty coverage buckets include mediaFromMs/mediaToMs, the earliest/latest actual media inside the bucket; empty buckets omit them. They reuse minute coverage indexes and logical deletion projections for drawing and immediate drag feedback without changing storage format. Internal gaps may remain. Final selection is precisely checked by recording-bounds; bucket endpoints do not prove continuity.

Hover previews use `GET /api/subjects/:id/snapshot-point?at=<milliseconds>` and return one unit or null; the old whole-range snapshots list is removed. Replay creation can specify unitId to distinguish units sharing PDT; missing explicit IDs are rejected, not guessed by time. Ordinary coverage reads neither compute nor return protectedSpans. Only unliked deletion tasks awaiting a published deletion revision request this bounded mask through the workbench protection subject-ID parameter. It shares the read snapshot with seenSpans and can reuse a cache keyed by media and favorite versions. Delete clicks immediately reuse loaded screenshot favorite ranges without awaiting this query. Demand stops after revision publication, failure or completion. Backend deletion independently validates all favorite relationships; display masks never authorize deletion. These spans create no standalone markers and do not define editing boundaries.

## Background status

`GET /api/system` includes health, disk, recording and screenshots plus capturedAtMs, backgroundTasks and ingress. Each task has a stable id, group, state and optional last-run/success/next-run timestamps, processed/total/pending/failed counts. Without a total, clients must not invent a percentage. Target contains only public endpoint hostnames and latency, not credentials, media URLs or local paths. Ingress reports shared live broadcaster count, retained bytes and budget.

Reading status does not start tasks or scan all media history. If one observation source fails, others remain available and that task reports task_status_unavailable. Each failure period emits one diagnostic and one recovery event. The browser reuses the shared clock/SSE without a separate panel poller. See [scheduling](architecture.en.md#concurrency-and-scheduling).

## Batch favorites and deletion

`POST /api/subjects/:id/unit-seen` accepts `{evidence:[{unitId,toMs}]}` (1–100 entries), monotonically advances visible units' `seen_to` to the displayed boundary, clamped to committed media, and returns `{changed}`. Boundaries are frozen when loading starts and reported after successful grid display; prefetch and hover previews never call it. Growth and metadata refreshes do not extend seen coverage, and delayed retries cannot roll it back. `unit_seen_ranges` is persisted through the media-library journal without changing favorite revisions or retention protection. Coverage responses include bounded `seenSpans`; mixed buckets stay unread. These spans are display summaries, never selection/deletion boundaries. A local `seen` notification refreshes timelines without reloading screenshot catalogs; other clients use the shared heartbeat.

The UI deletes through `POST /api/subjects/:id/deletion-intents` with `{commandId,target}`. commandId is a UUID. All targets contain fromMs/toMs; kind selects units + unitIds, selection + selectionId/patch, or range + mode(all/unliked)/baseSelectionId/patch. A 202 response means the intent is durably journaled; preparation and deletion run in the background with immediate logical hiding. Reusing the same key/target returns the existing task; the same key with a different target returns 409. `GET /api/media-deletions` reports preparing/queued/running/retry/completed/failed, phase, scannedUnits, selectedUnits and deletion version. Preparation need not have a known total. See [command consistency](architecture.en.md#recording-units-and-ui-consistency).

Exact-set and plan endpoints remain available for programmatic checks; the UI no longer waits for their preview/statistics:

1. `POST /api/subjects/:id/media-selection`: `{fromMs,toMs,mode}`, where mode is all, unliked or explicit; optional baseSelectionId unions a set, with includeUnitIds/excludeUnitIds. Frozen sets are prepared in 256-unit steps and return id, count, personalRevision and deletionRevision. Cancelling preparation does not commit a mutation.
2. `POST /api/subjects/:id/media-selection/:selectionId/favorites`: `{liked,revision}` plus optional exceptions. Return after durable acceptance; logical favorites apply immediately and physical flags materialize in 256-item steps, resuming after restart. Each nonempty accepted command advances revision once; count and the old removed field describe requested targets, not the count of physically changed rows.
3. `POST /api/subjects/:id/delete-selection/preview`: mutually exclusive selectionId or unitIds; freezes unit identities and returns affected ranges, plan and personal revision. Legacy ranges input is rejected. Large preparations yield between batches.
4. `POST /api/subjects/:id/delete-selection`: `{planId,personalRevision}`; 202 confirms acceptance, immediate logical hiding and batched background reclamation. Read progress/retries through `GET /api/media-deletions`.
5. Current-page operations also support `POST /api/subjects/:id/unit-favorites/query`, `POST /api/subjects/:id/unit-favorites` (unitIds, liked, revision) and `DELETE /api/me/favorites/:id`. They use the same favorite-command owner and logical projection.

Acceptance and retention coordinate through the same broadcaster write sequence. Accepted favorites protect complete units before physical materialization, including later members. Unliking restores retention eligibility without immediate deletion. Explicit manual deletion can delete favorites; logically deleted units disappear from personal favorites and coverage summaries. A changed personal revision/deletion generation from another client returns 409 and requires reconfirmation, never silent scope expansion.

Explicit ID arrays are capped at 100000 for HTTP payload protection; frozen selections do not require encoding the entire range in an array. Selection ranges allow at most nine days to accommodate a seven-day UI window expanded to full units. Acceptance includes the latest open-unit members and seals the target; later recording is excluded. Accepted work outlives the browser; closing the page does not roll back a durable intent.

Implementation: [selection endpoints](../apps/server/src/http/media-selection.ts), [selection store](../apps/server/src/archive/media-selection-store.ts), [favorites](../apps/server/src/archive/favorite-commands.ts), [deletion](../apps/server/src/archive/deletion-store.ts).

## Errors and cancellation

Business errors use stable codes translated by the UI. A 401 means the session is invalid; invalid parameters should not be retried forever. Respect rate-limit information on 429. Network/server failures use retries bounded by their owning operation. Cancelling a request is not proof that a server mutation did not commit; durable commands require idempotent identity and reconciliation when results are unknown.

Heavy metadata reads at their admission limit return 503 `{error: 'archive_busy'}` with `Retry-After: 1`. Keep existing content and retry within bounded policy. Reads not yet dispatched to the worker may be rejected; accepted writes are not timed out or cancelled by this protection.

When changing endpoints, update schemas, server, client and boundary tests together. Never interpret an error as fabricated offline status, missing media or successful deletion.

Browser reads have a 15-second deadline and mutation submissions 30 seconds. Transport failures or uncertain server errors do not automatically replay mutations or imply rollback. Release the interaction lock, then perform bounded reconciliation: favorites by unit ID and deletion by the submitted plan ID. No observed result still means unknown, not definitely unexecuted. Explicit archive_busy admission rejection returns 503 so the UI can ask the user to retry later.

Individual favorite protection queries have a 15-second preparation budget. Changing range or unmounting cancels preparation, and late reads cannot submit writes. Preparation failure means no mutation was submitted. A submitted POST uses its own mutation budget, does not inherit preparation cancellation and is not automatically replayed.

Rebuildable playback sessions use the explicit client option `operation=session`, preserving transport/server errors for the player's bounded preparation retries. This option is not sent to the server. Aborted or incompletely delivered sessions are reclaimed server-side, with TTL and quantity limits as additional protection. Durable favorites/deletions do not use this policy and unknown outcomes do not enter session retries.
