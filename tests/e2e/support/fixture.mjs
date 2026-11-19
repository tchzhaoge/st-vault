import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ffmpegRuntime, generateMedia, outputRoot, projectRoot } from './media.mjs';

export async function startFixture(options = {}) {
  const modules = (name) =>
    import(pathToFileURL(path.join(projectRoot, 'build', 'apps', 'server', 'src', name)).href);
  let archive, app, runtime, root, network, sites, legacyToken;
  const close = async () => {
    const failures = [];
    for (const cleanup of [
      () => app?.close(),
      () => sites?.close(),
      () => network?.close(),
      () => archive?.close(),
      () => runtime?.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (root && process.env.STV_QA_KEEP_STATE !== '1' && failures.length === 0) {
      // Only delete the exact mkdtemp directory owned by this invocation.
      const relative = path.relative(outputRoot, root);
      if (!/^state-[^\\/]+$/.test(relative)) throw new Error('Unsafe QA state cleanup target');
      await rm(root, { recursive: true, force: true });
    }
    if (failures.length)
      throw new AggregateError(failures, 'QA fixture cleanup failed; state retained');
  };
  try {
    const [
      { openArchive },
      { buildApp },
      { SettingsStore },
      { KeyVault },
      { createLiveProxy },
      { createPreviews },
      { createFfmpegDecoder, verifyJpeg },
      { NetworkRouting },
      { SiteRoutes },
      { LocalAuth },
    ] = await Promise.all(
      [
        'archive/index.js',
        'http/app.js',
        'runtime/settings.js',
        'http/key-vault.js',
        'live/index.js',
        'previews/index.js',
        'previews/ffmpeg.js',
        'network/network-routing.js',
        'provider/site-routes.js',
        'http/auth.js',
      ].map(modules),
    );
    runtime = await ffmpegRuntime();
    const media = await generateMedia(runtime),
      read = (name) => {
        const bytes = media.files.get(name);
        if (!bytes) throw new Error(`Unknown synthetic media: ${name}`);
        return bytes;
      };
    await mkdir(outputRoot, { recursive: true });
    root = await mkdtemp(path.join(outputRoot, 'state-'));
    await writeFile(
      path.join(root, 'QA-SYNTHETIC.json'),
      JSON.stringify({ synthetic: true, productionCredentialsRead: false }),
    );
    const archiveOptions = {
      root,
      fault: async (point) => {
        if (point === 'before-unlink') await options.beforeUnlink?.();
        if (point === 'before-deletion-prepare') await options.beforeDeletionPrepare?.();
      },
    };
    archive = await openArchive(archiveOptions);
    const started = Date.now();
    await archive.setSetting('timeline.deployed-at', String(started - 14 * 86400000));
    // Read the same persisted deployment boundary as an ordinary recovered archive.
    await archive.close();
    archive = await openArchive(archiveOptions);
    const vault = await KeyVault.open(root, archive),
      settings = await SettingsStore.open(archive, {});
    // Most scenarios exercise media, not onboarding. Seed only local authentication so
    // signing in cannot re-import subjects and change the fixture's unfollowed membership.
    if (options.legacyPassword) {
      const salt = randomBytes(24).toString('hex');
      await archive.setSetting(
        'local-auth.password',
        JSON.stringify({
          salt,
          hash: scryptSync(options.legacyPassword, salt, 64).toString('hex'),
        }),
      );
      legacyToken = randomBytes(32).toString('hex');
      await archive.setSetting(
        'local-auth.sessions',
        JSON.stringify([
          {
            digest: createHash('sha256').update(legacyToken).digest('hex'),
            expiresAt: Date.now() + 7 * 86400000,
          },
        ]),
      );
    } else if (!options.freshSetup) {
      const auth = await LocalAuth.open(archive),
        lease = await auth.beginSetup();
      await auth.completeSetup(options.pin ?? '012345', lease);
    }
    const subjects = Array.from({ length: 300 }, (_, index) => ({
      id: `stripchat:${index + 1}`,
      providerId: index + 1,
      handle: index === 41 ? '00 演示直播' : `演示主播 ${String(index + 1).padStart(3, '0')}`,
    }));
    await archive.upsertSubjects(subjects, { syncAccount: true });
    // A successful list is a complete snapshot, including every current follow.
    const following = subjects.slice(0, -1);
    await archive.upsertSubjects(
      following.map((subject) =>
        subject.id === subjects[41].id ? { ...subject, handle: '旧名 Synthetic' } : subject,
      ),
      { syncAccount: true },
    );
    await archive.upsertSubjects(following, { syncAccount: true });
    const archiveStart = Math.floor(started / 60000) * 60000 - 180000,
      liveStart = Math.floor(started / 2000) * 2000 - 60000;
    for (let index = 0; index < 60; index++) {
      const segment = media.segments[index % media.segments.length];
      await archive.commit({
        subjectId: 'stripchat:42',
        sourceEpoch: `synthetic-${Math.floor(index / media.segments.length)}`,
        sourceSequence: String(index % media.segments.length),
        init: read('init.mp4'),
        bytes: read(segment.name),
        durationSeconds: segment.durationSeconds,
        wallStartMs: archiveStart + index * 2000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: index % media.segments.length === 0,
      });
    }
    for (const subject of subjects)
      await archive.setObservation(
        subject.id,
        subject.providerId % 4 === 0
          ? 'PRIVATE'
          : subject.providerId % 3 === 0 && subject.providerId !== 42
            ? 'OFFLINE'
            : 'PUBLIC',
        started,
        600000,
      );
    await archive.startRun(started);
    await archive.setObservation('stripchat:42', 'PRIVATE', started + 1, 600000);
    await archive.setObservation('stripchat:42', 'PUBLIC', started + 2, 600000);
    const provider = {
      importList: async () => subjects,
      status: async () => 'PUBLIC',
      capture: async () => {},
    };
    const captureStates = {};
    const captureListeners = new Set();
    const captureTimers = new Set();
    const supervisor = {
      requestRecording: async (ids) => {
        const rows = await archive.listSubjects();
        for (const row of rows.filter((row) => ids.includes(row.id))) {
          captureStates[row.id] = row.autoRecord ? 'RESOLVING' : 'IDLE';
          for (const listener of captureListeners) listener();
          if (row.autoRecord) {
            const timer = setTimeout(() => {
              captureTimers.delete(timer);
              captureStates[row.id] = 'CAPTURING';
              for (const listener of captureListeners) listener();
            }, 600);
            captureTimers.add(timer);
          }
        }
      },
      subscribe: (listener) => {
        captureListeners.add(listener);
        return () => captureListeners.delete(listener);
      },
      reconcile: async () => {},
      states: () => captureStates,
      close: async () => {
        for (const timer of captureTimers) clearTimeout(timer);
        captureTimers.clear();
      },
    };
    const live = createLiveProxy({
      archive,
      provider,
      hlsEdges: ['fixture.invalid'],
      allowedMediaHosts: ['fixture.invalid'],
      fetch: async (input) => {
        const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href));
        if (url.pathname.endsWith('_auto.m3u8'))
          return new Response(
            '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=640x360\n../main.m3u8\n',
          );
        if (url.pathname.endsWith('.m3u8')) {
          const last = Math.floor((Date.now() - liveStart) / 2000) - 1,
            first = Math.max(0, last - 9),
            count = media.segments.length;
          const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:2',
            `#EXT-X-MEDIA-SEQUENCE:${first}`,
            `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / count)}`,
            '#EXT-X-MAP:URI="init.mp4"',
          ];
          for (let index = first; index <= last; index++) {
            if (index !== first && index % count === 0) lines.push('#EXT-X-DISCONTINUITY');
            lines.push(
              `#EXT-X-PROGRAM-DATE-TIME:${new Date(liveStart + index * 2000).toISOString()}`,
              '#EXTINF:2,',
              `seg${index}.m4s`,
            );
          }
          return new Response(lines.join('\n') + '\n');
        }
        const segment = /seg(\d+)\.m4s$/.exec(url.pathname);
        return new Response(
          read(
            segment
              ? media.segments[Number(segment[1]) % media.segments.length].name
              : path.basename(url.pathname),
          ),
          { headers: { 'content-type': 'video/mp4' } },
        );
      },
    });
    // Generate fixtures with the full QA tool, but allow acceptance to exercise
    // the exact production decoder binary independently of fixture generation.
    const decodeOptions = process.env.STV_QA_DECODE_FFMPEG
      ? { ffmpegPath: process.env.STV_QA_DECODE_FFMPEG }
      : { launch: runtime.launch };
    const decoder = createFfmpegDecoder(decodeOptions);
    const previews = createPreviews({
      archive,
      cacheRoot: path.join(root, 'cache/previews'),
      decoder,
      validateSnapshot: (bytes, signal) => verifyJpeg(bytes, signal, decodeOptions),
      fetch: async (input) => {
        const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href));
        if (url.pathname.includes('/broadcasts/'))
          return Response.json({
            item: { snapshotTimestamp: Math.floor(Date.now() / 15000) },
          });
        const profile = /\/models\/(\d+)\/cam$/.exec(url.pathname);
        if (profile)
          return Response.json({
            user: {
              user: {
                id: Number(profile[1]),
                avatarUrl: `https://static-cdn.strpst.com/avatars/${profile[1]}`,
              },
            },
          });
        return new Response(
          read(Number(url.pathname.split('/')[2]) % 2 ? 'portrait.jpg' : 'landscape.jpg'),
          { headers: { 'content-type': 'image/jpeg' } },
        );
      },
    });
    const info = {
      synthetic: true,
      productionCredentialsRead: false,
      port: 10085,
      archiveStart,
      archiveEnd: archiveStart + 120000,
      subjectId: 'stripchat:42',
      subjectCount: 300,
      root,
      ffmpeg: runtime.description,
    };
    const routeFetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href));
      if (url.pathname.includes('_auto.m3u8'))
        return new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nmain.m3u8\n',
        );
      if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:2,\nsegment.ts\n');
      if (url.pathname.endsWith('segment.ts'))
        return new Response(new Uint8Array(262144), { headers: { 'content-type': 'video/mp2t' } });
      if (url.pathname === '/api/front/models')
        return Response.json({
          models: [{ id: 42, isLive: true, status: 'public' }],
        });
      return Response.json({ initialDynamic: {} });
    };
    sites = new SiteRoutes({ fetch: routeFetch });
    network = await NetworkRouting.open(archive, sites, { fetch: routeFetch });
    app = await buildApp({
      accountSync: options.accountSync,
      network,
      archive,
      provider,
      supervisor,
      vault,
      live,
      previews,
      settings,
      uiRoot: path.join(projectRoot, 'build/apps/ui/dist'),
    });
    app.get('/qa/info', () => info);
    await app.listen({ host: '127.0.0.1', port: info.port });
    await writeFile(path.join(outputRoot, 'fixture.json'), JSON.stringify(info, null, 2) + '\n');
    console.log(
      `[qa] Synthetic fixture ready at http://127.0.0.1:${info.port}; ${subjects.length} subjects; state ${root}`,
    );
    let closing;
    return {
      info,
      legacyToken,
      appendSnapshotUnit: (atMs, sourceEpoch = `snapshot-append-${atMs}`) =>
        archive.commit({
          subjectId: info.subjectId,
          sourceEpoch,
          sourceSequence: '0',
          init: read('init.mp4'),
          bytes: read(media.segments[0].name),
          durationSeconds: media.segments[0].durationSeconds,
          wallStartMs: atMs,
          timeBasis: 'source-pdt',
          uncertaintyMs: 0,
          discontinuity: true,
        }),
      seedSnapshotHistory: async () => {
        const fromMs = archiveStart - 88 * 60000;
        for (let index = 0; index < 88; index++) {
          const segment = media.segments[0];
          await archive.commit({
            subjectId: info.subjectId,
            sourceEpoch: `snapshot-history-${index}`,
            sourceSequence: '0',
            init: read('init.mp4'),
            bytes: read(segment.name),
            durationSeconds: segment.durationSeconds,
            wallStartMs: fromMs + index * 60000,
            timeBasis: 'source-pdt',
            uncertaintyMs: 0,
            discontinuity: true,
          });
        }
        return { fromMs, toMs: info.archiveEnd };
      },
      seedSparseSnapshotHistory: async () => {
        const fromMs = new Date(started + 8 * 3600000);
        fromMs.setUTCHours(0, 0, 0, 0);
        const at = fromMs.getTime() - 8 * 3600000 - 6 * 86400000 + 3600000;
        await archive.commit({
          subjectId: info.subjectId,
          sourceEpoch: 'sparse-history',
          sourceSequence: '0',
          init: read('init.mp4'),
          bytes: read(media.segments[0].name),
          durationSeconds: media.segments[0].durationSeconds,
          wallStartMs: at,
          timeBasis: 'source-pdt',
          uncertaintyMs: 0,
          discontinuity: true,
        });
        return { fromMs: at, toMs: info.archiveEnd };
      },
      resetSnapshotHistory: () =>
        archive.deleteRange(info.subjectId, archiveStart - 88 * 60000, archiveStart),
      navigationEvents: async () => {
        const at = Date.now();
        for (const [id, from, to] of [
          [299, 'OFFLINE', 'PUBLIC'],
          [297, 'PUBLIC', 'OFFLINE'],
        ]) {
          await archive.setObservation(`stripchat:${id}`, from, at, 600000);
          await archive.setObservation(`stripchat:${id}`, to, at + 1, 600000);
        }
        await archive.upsertSubjects(subjects, {
          syncAccount: true,
        });
        await archive.setObservation('stripchat:300', 'PUBLIC', at, 600000);
        await archive.setObservation('stripchat:300', 'PRIVATE', at + 1, 600000);
        await archive.upsertSubjects(subjects.slice(0, -1), { syncAccount: true });
      },
      verifySnapshot: (bytes) => verifyJpeg(bytes, new AbortController().signal, decodeOptions),
      close: () => (closing ??= close()),
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Fixture setup and cleanup failed');
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const fixture = await startFixture();
    const stop = () => {
      void fixture.close().catch((error) => {
        console.error(`[qa] Fixture shutdown failed: ${error.stack ?? error}`);
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    console.error(`[qa] Fixture startup failed (run npm run build first): ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}
