# Development and maintenance

[简体中文](CONTRIBUTING.md) · **English**

This guide covers building, testing, releasing and recovering the project. See the [user guide](../README.en.md), [architecture](architecture.en.md) and [API](api.en.md) for usage and interfaces.

Include reproduction steps, relevant tests and risks with changes, and update documentation when behavior changes. Report security issues privately as described in [SECURITY](SECURITY.en.md). The canonical CONTRIBUTING.md and SECURITY.md files stay in docs using [GitHub-supported names and locations](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file), without duplicate root documents.

## Repository layout

| Path                      | Contents                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`, `apps/ui`  | Server and UI, with tests alongside their modules                                                                               |
| `packages/api-schema`     | Shared types and request contracts                                                                                              |
| `deploy`                  | The deployment environment template, Compose, Dockerfile and FFmpeg build                                                       |
| `scripts`                 | Build/check entry points; benchmarks for experiments, diagnostics for explicit network probes, maintenance for legacy migration |
| `tests`                   | Synthetic e2e scenarios, runtime probes and deployment lifecycle validation                                                     |
| `docs`                    | All guides and translations, without development-phase subdirectories                                                           |
| `licenses`, `LICENSE`     | Required legal notices, not disposable development artifacts                                                                    |
| `.github`                 | CI and on-demand browser regression workflows                                                                                   |
| `data`, `media`, `.local` | Git-ignored production state, media and local validation output, separate from source                                           |

Keep npm/workspace lockfiles, TypeScript/ESLint/Prettier configuration and Git/Docker/editor rules at the root rather than inventing custom tool paths merely to hide files. Install dependencies only in containers. Do not commit `build/` or `apps/ui/dist/`.

## Build and check

Run from the repository root without mounting production data/media:

```sh
docker build --target qa -t st-vault:qa -f deploy/Dockerfile .
docker run --rm st-vault:qa npm run check
docker run --rm st-vault:qa npm run test:browser
```

`check` covers formatting, lint, documentation links, source dependencies, types, tool/workspace tests and the release build. QA includes a temporary PostgreSQL cluster for real integration tests; runtime omits npm, compilers and Chromium. Targeted examples:

```sh
docker run --rm st-vault:qa npm test --workspace @st-vault/ui -- src/features/timeline/track-loader.test.ts
docker run --rm st-vault:qa npm test --workspace @st-vault/server -- src/database/postgres.test.ts
docker run --rm st-vault:qa node scripts/run-browser-tests.mjs onboarding snapshot-seek player-disconnect
```

Browser fixtures use a separate port, generate synthetic HLS/JPEG data and block external website requests. Output goes to `.local/qa/`; temporary state is cleaned after normal completion. `STV_QA_KEEP_STATE=1` explicitly retains diagnostic state. Never use private databases, cookies or recordings in tests. UI, deletion, media and persistence changes need relevant browser, cancellation, late-response, interruption and restart coverage.

For source-only iteration, mount the relevant `src` read-only into QA. Do not mount all of apps over the image's workspace dependencies. Rebuild after changing dependencies or build configuration. The compiled business entry point alone does not start the database; production uses `apps/server/src/deploy/start.js` relative to the release root. `STV_BUILD_REVISION` accepts only 40–64 lowercase hexadecimal characters; use the real commit SHA for releases.

After testing the candidate runtime with independent data, local developer deployment uses the override:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml -f deploy/compose.build.yml up -d --build
```

[lifecycle.ps1](../tests/deployment/lifecycle.ps1) tests runtime startup/shutdown without production data. Cleanup must be limited to confirmed disposable validation output and Docker resources; production data/media, required rollback backups and matching images are not caches.

## CI and release

The project starts at `0.1.0`. Pushing to `main` runs [CI](../.github/workflows/container-release.yml) for formatting, types, tests, build, dependency audit and Compose validation. Routine commits keep the current version.

- **Local development and batched pushes.** Make and verify every change on local `main`. Small fixes can be committed locally as they are completed. Push the batch to GitHub when the maintainer decides it is ready, then confirm CI passes. Run local regression checks for affected features when making major changes.
- **Refresh the local test image.** After changing runtime code, UI, or image configuration, rebuild from the current checkout and update the local test container. Pass `STV_BUILD_REVISION` at build time, then confirm the running image revision and service health. Reuse the test instance's Compose settings and data directories. For documentation or GitHub workflow changes, verify the files directly.
- **A push approves a release.** Each push checks the resulting tip of `main`. Intermediate commits are uploaded as history. After checks pass, the workflow subtracts one from its run number for the patch in `0.1.N` and publishes a shared Docker tag for both verified architectures. The release version is stamped into the build while source manifests keep their existing versions. Add `[no release]` to the final commit message to run checks alone.
- **Failures and reruns.** Failed checks or image builds may leave gaps in version numbers. Rerunning an Actions run retains its version. Use `git revert` for ordinary rollbacks, then release when the next batch is ready.

See Packages for container images and version tags, and Actions for verification and publishing results. Public GHCR packages support anonymous pulls.

Browser regression remains a separate on-demand workflow, not an automatic release gate. Historical pass counts are not evidence for a new commit. Describe tests actually run and remaining risks. Never commit credentials or real business data.

## Legacy upgrades

The current importer supports a one-time PostgreSQL upgrade from a dual-directory SQLite library with manifest format 1 and business metadata format 5. Stop the old application normally and back up complete data, media and the matching image. On first startup, the new image replays acknowledged logs, freezes the source, imports/verifies data and publishes a format-2 checkpoint. Frozen copies are in `data/backups/postgresql-<libraryUUID>/<generation>/`; they do not replace video backups. Allow room for old databases, frozen copies, the new cluster, staging tables and WAL. Avoid repeatedly forcing restarts during a large initial import.

An older single-directory layout must first be converted using [migrate-library.mjs](../scripts/maintenance/migrate-library.mjs) with the matching historical image, not an incompatible current latest. The tool requires a normally closed format-5 source and separate targets outside the source. It hard-links on the same filesystem or copies/verifies across filesystems, supports interrupted reruns and retains the source for rollback.

Old images cannot read the new format or reverse-apply new writes. Cross-format rollback needs both directories from the same stopped-state backup and the matching image, not merely an image switch. Metadata cannot restore already reclaimed video. Password-based installations verify the old password once before setting a PIN; unauthenticated setup is not reopened.

## Performance limits and diagnostics

Use synthetic data from `scripts/benchmarks`, recording CPU/memory limits, storage, sample sizes, warmup and measurement scope. Logs separate pool wait, SQL execution and RPC round-trip time; do not attribute all waiting to SQL. Explicit real-network diagnostics live in `scripts/diagnostics` and are excluded from default offline CI.

Remaining costs to quantify include running RPC/SQL not being immediately cancelled with the browser request, distinct admission semantics for recording prerequisite/control reads, historical screenshot discovery rate, exact playback subscriptions, full-height grids and repeated SSE invalidation. The read-only SQL limit is not a whole-request deadline. Dense timelines can still produce long tasks under software rendering; those results cannot be converted into real hardware-accelerated browser frame rates.
