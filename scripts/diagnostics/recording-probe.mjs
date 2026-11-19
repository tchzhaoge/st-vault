// Run inside the deployed app container via stdin. Never enable recording policies.
import { DatabaseSync } from 'node:sqlite';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const app = process.env.STV_PROBE_APP_ROOT ?? '/app';
const state = process.env.STV_DATA_DIR ?? '/data';
const load = (file) => import(pathToFileURL(path.join(app, 'apps/server/src', file)).href);
const { createProvider } = await load('provider/index.js');
const { createIngressHub } = await load('ingest/index.js');
const { openArchive } = await load('archive/index.js');
const { KeyVault } = await load('http/key-vault.js');
const { createSupervisor } = await load('capture/supervisor.js');
const { SyncClock } = await load('runtime/sync-clock.js');
const { createFfmpegDecoder, verifyJpeg } = await load('previews/ffmpeg.js');
await access(path.join(state, 'private/address-key.key')); // Refuse creating production credentials.
const { libraryIndexPath } = await load('library/paths.js');
const db = new DatabaseSync(libraryIndexPath(state, process.env.STV_MEDIA_DIR ?? '/media'), {
  readOnly: true,
});
const privateDb = new DatabaseSync(path.join(state, 'app.sqlite'), { readOnly: true });
let root, archive, hub, supervisor, probeClock;
try {
  const vault = await KeyVault.open(state, {
    getSetting: async (key) =>
      privateDb.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value,
  });
  const provider = createProvider({ keyLookup: vault.lookup });
  const rows = db
    .prepare(
      "SELECT id,provider_id,handle FROM subjects WHERE monitor=1 AND status='PUBLIC' LIMIT 4",
    )
    .all();
  let subject;
  for (const row of rows) {
    if ((await provider.status(row.provider_id, AbortSignal.timeout(10000))) === 'PUBLIC') {
      subject = {
        id: row.id,
        providerId: row.provider_id,
        handle: row.handle,
        monitorEnabled: true,
        autoRecord: false,
        providerStatus: 'PUBLIC',
        observedAtMs: Date.now(),
      };
      break;
    }
  }
  if (!subject) throw new Error('NO_PUBLIC_PROBE_SUBJECT');
  root = await mkdtemp(path.join(tmpdir(), 'stv-live-probe-'));
  archive = await openArchive({ root });
  await archive.upsertSubjects([subject]);
  hub = createIngressHub({ provider, keyLookup: vault.lookup });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60000);
  const samples = [];
  let started = Date.now(),
    firstCommitMs,
    firstWriteMs,
    firstCoverageMs,
    coverageReadMs,
    policySavedMs;
  let bytes = 0,
    decodeInput;
  const sink = {
    commit: async (input) => {
      const writingAt = Date.now();
      const saved = await archive.commit(input);
      if (!samples.length) {
        firstCommitMs = Date.now() - started;
        firstWriteMs = Date.now() - writingAt;
        const readAt = Date.now();
        const coverage = await archive.coverage(subject.id, readAt - 86400000, readAt + 1, 360);
        coverageReadMs = Date.now() - readAt;
        if (!coverage.buckets.some((bucket) => bucket.coveredMs > 0))
          throw new Error('FIRST_COMMIT_NOT_QUERYABLE');
        firstCoverageMs = Date.now() - started;
      }
      samples.push({
        sequence: input.sourceSequence,
        epoch: input.sourceEpoch,
        start: input.wallStartMs,
        duration: input.durationSeconds,
        discontinuity: input.discontinuity,
      });
      bytes += input.bytes.length;
      decodeInput = input;
      if (samples.length >= 12) controller.abort();
      return saved;
    },
  };
  try {
    if (process.env.STV_PROBE_POLICY_START === '1') {
      await archive.setObservation(subject.id, 'PUBLIC', Date.now(), 15000);
      probeClock = new SyncClock({ intervalMs: () => 2000 });
      supervisor = createSupervisor({
        clock: probeClock,
        archive: {
          listSubjects: () => archive.listSubjects(),
          setObservation: (...args) => archive.setObservation(...args),
          commit: sink.commit,
        },
        provider: { ...provider, capture: (...args) => hub.capture(...args) },
        autoStart: true,
      });
      started = Date.now();
      await archive.setPolicy(subject.id, { autoRecord: true });
      policySavedMs = Date.now() - started;
      await supervisor.requestRecording([subject.id], started);
      if (!controller.signal.aborted)
        await new Promise((resolve) =>
          controller.signal.addEventListener('abort', resolve, { once: true }),
        );
      probeClock.stop();
      await supervisor.close();
      await probeClock.close();
    } else await hub.capture(subject, sink, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(deadline);
  }
  await hub.close();
  if (!samples.length) throw new Error('NO_MEDIA_COMMITTED');
  const file = path.join(root, 'decode-check.mp4');
  await writeFile(file, Buffer.concat([decodeInput.init ?? new Uint8Array(), decodeInput.bytes]));
  const signal = AbortSignal.timeout(15000);
  const snapshot = await createFfmpegDecoder()({
    paths: [file],
    offsetSeconds: 0,
    endSeconds: decodeInput.durationSeconds,
    signal,
  });
  await verifyJpeg(snapshot, signal);
  const gaps = samples.slice(1).map((sample, index) => {
    const previous = samples[index];
    return {
      missing:
        previous.epoch === sample.epoch
          ? Number(BigInt(sample.sequence) - BigInt(previous.sequence) - 1n)
          : null,
      wallGapMs:
        previous.start === null || sample.start === null
          ? null
          : sample.start - previous.start - previous.duration * 1000,
    };
  });
  console.log(
    JSON.stringify({
      event: 'recording_probe_result',
      subjectId: subject.id,
      elapsedMs: Date.now() - started,
      firstCommitMs,
      firstWriteMs,
      firstCoverageMs,
      coverageReadMs,
      policySavedMs,
      policyStart: process.env.STV_PROBE_POLICY_START === '1',
      committed: samples.length,
      bytes,
      gaps,
      snapshot: { generated: true, decoded: true, bytes: snapshot.length },
      productionPoliciesChanged: false,
    }),
  );
} finally {
  probeClock?.stop();
  await supervisor?.close();
  await probeClock?.close();
  await hub?.close();
  await archive?.close();
  db.close();
  privateDb.close();
  if (root && path.dirname(root) === tmpdir() && path.basename(root).startsWith('stv-live-probe-'))
    await rm(root, { recursive: true, force: true });
}
