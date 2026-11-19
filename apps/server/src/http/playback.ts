import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { playbackSchema, type Segment } from '@st-vault/api-schema';
import { ARCHIVE_MEDIA_BATCH_LIMIT, type ArchivePort } from '../ports.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { recordingRange } from './recording-range.js';
import { waitUnitTail } from './unit-tail.js';

interface PlaybackSession {
  owner: string;
  expiresAt: number;
  segments: Segment[];
}
interface PlaybackOptions {
  archive: ArchivePort;
  clock: SyncClock;
  now: () => number;
  ownerOf: (request: FastifyRequest) => string | undefined;
}
/** Archive playback owns its sessions and all in-flight admission, including revocation. */
export function registerPlayback(app: FastifyInstance, options: PlaybackOptions) {
  const { archive, clock, now, ownerOf } = options;
  const playbacks = new Map<string, PlaybackSession>();
  const operations = new Map<AbortController, string>();
  let closed = false;
  const openPlayback = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const owner = ownerOf(request);
    if (closed) return reply.code(503).send({ error: 'stopping' });
    if (!owner) return reply.code(401).send({ error: 'unauthorized' });
    const controller = new AbortController();
    operations.set(controller, owner);
    const disconnected = (): void => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.once('aborted', disconnected);
    reply.raw.once('close', disconnected);
    try {
      const {
        subjectId: id,
        targetUtcMs,
        gapPolicy,
        ...requested
      } = playbackSchema.parse(request.body);
      let { fromMs, toMs } = requested;
      let openUnitId = requested.openUnitId;
      if (openUnitId && archive.unitRange) {
        const range = await waitUnitTail(
          archive,
          clock,
          id,
          openUnitId,
          targetUtcMs,
          AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        );
        if (!range || range.toMs <= targetUtcMs)
          return reply.code(409).send({ error: 'coverage_gap' });
        toMs = range.toMs;
        if (!range.open) openUnitId = undefined;
      }
      if (fromMs !== undefined && toMs !== undefined) {
        const range = await recordingRange(archive, id, fromMs, toMs);
        if (!range) return reply.code(409).send({ error: 'coverage_gap' });
        fromMs = range.fromMs;
        toMs = range.toMs;
        openUnitId = range.openUnitId;
      }
      // Screenshot navigation names a recording unit, not an ambiguous UTC point.
      // An unavailable unit must never silently select a different same-time source.
      // A range may shrink after a deletion. The navigation policy operates
      // inside the surviving range, while explicit unit/report requests remain exact.
      const target =
        fromMs !== undefined &&
        toMs !== undefined &&
        gapPolicy === 'next-or-previous' &&
        !requested.unitId
          ? Math.max(fromMs, Math.min(toMs - 1, targetUtcMs))
          : targetUtcMs;
      const locatePolicy = gapPolicy === 'next-or-previous' ? 'next' : gapPolicy;
      let segment = requested.unitId
        ? ((await archive.unitSource?.(id, requested.unitId, target)) ?? null)
        : await archive.locate(id, target, locatePolicy);
      if (!segment && !requested.unitId && gapPolicy === 'next-or-previous')
        segment = await archive.locate(id, target, 'previous');
      if (controller.signal.aborted) {
        if (request.raw.aborted || reply.raw.destroyed) return;
        return reply.code(409).send({ error: 'playback_cancelled' });
      }
      if (!segment) return reply.code(409).send({ error: 'coverage_gap' });
      if (segment.wallStartMs === null || segment.wallEndMs === null)
        return reply.code(409).send({ error: 'coverage_gap' });
      const actualAtMs =
        target >= segment.wallStartMs && target < segment.wallEndMs
          ? target
          : gapPolicy === 'previous'
            ? Math.max(segment.wallStartMs, segment.wallEndMs - 1)
            : segment.wallStartMs;
      if (toMs !== undefined && (actualAtMs < fromMs! || actualAtMs >= toMs))
        return reply.code(409).send({ error: 'coverage_gap' });
      const window = await archive.timeline(
        id,
        segment.wallStartMs,
        Math.min(segment.wallStartMs + 1800000, toMs ?? Infinity),
        2000,
      );
      const startIndex = window.segments.findIndex((row) => row.id === segment.id);
      if (startIndex < 0) return reply.code(409).send({ error: 'coverage_changed' });
      // Wall-clock gaps are compressed in media time. Segment metadata remains the
      // sole UTC mapping, so a missing interval never creates an empty media buffer.
      const segments = window.segments.slice(startIndex);
      const last = segments.at(-1)!;
      const next =
        last.wallEndMs === null ? null : await archive.locate(id, last.wallEndMs, 'next');
      const nextAtMs =
        next &&
        !segments.some((item) => item.id === next.id) &&
        (toMs === undefined || (next.wallStartMs !== null && next.wallStartMs < toMs))
          ? next.wallStartMs
          : null;
      if (request.raw.aborted || reply.raw.destroyed) return;
      if (controller.signal.aborted || ownerOf(request) !== owner || closed)
        return reply.code(409).send({ error: 'playback_cancelled' });
      for (const [key, session] of playbacks) if (session.expiresAt <= now()) playbacks.delete(key);
      if (playbacks.size >= 50) return reply.code(429).send({ error: 'too_many_playbacks' });
      const sessionId = randomUUID();
      playbacks.set(sessionId, {
        owner,
        expiresAt: now() + 30 * 60000,
        segments,
      });
      const abandoned = (): void => {
        if (!reply.raw.writableFinished) playbacks.delete(sessionId);
      };
      reply.raw.once('close', abandoned);
      reply.raw.once('finish', () => reply.raw.removeListener('close', abandoned));
      return {
        sessionId,
        manifestUrl: `/api/playback/${sessionId}/manifest.m3u8`,
        requestedAtMs: targetUtcMs,
        actualAtMs,
        seekOffsetSeconds: (actualAtMs - segment.wallStartMs) / 1000,
        timeBasis: segment.timeBasis,
        uncertaintyMs: segment.uncertaintyMs,
        segments,
        windowEndMs: Math.min(last.wallEndMs!, toMs ?? Infinity),
        nextAtMs: nextAtMs ?? (openUnitId ? last.wallEndMs : null),
        ...(openUnitId ? { openUnitId } : {}),
        hasGapAfter:
          nextAtMs !== null && last.wallEndMs !== null && nextAtMs - last.wallEndMs > 250,
        ...(fromMs === undefined ? {} : { rangeFromMs: fromMs, rangeToMs: toMs }),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        if (request.raw.aborted || reply.raw.destroyed) return;
        return reply.code(409).send({ error: 'playback_cancelled' });
      }
      throw error;
    } finally {
      operations.delete(controller);
      request.raw.removeListener('aborted', disconnected);
      reply.raw.removeListener('close', disconnected);
    }
  };
  app.post('/api/playback', openPlayback);
  app.post('/api/playback/:id/seek', async (request, reply) => {
    const session = playbacks.get((request.params as { id: string }).id);
    if (!session || session.expiresAt <= now() || session.owner !== ownerOf(request))
      return reply.code(404).send({ error: 'playback_not_found' });
    return openPlayback(request, reply);
  });
  app.post('/api/playback/:id/close', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = playbacks.get(id);
    if (!session || session.owner !== ownerOf(request))
      return reply.code(404).send({ error: 'playback_not_found' });
    playbacks.delete(id);
    return { ok: true };
  });
  app.get('/api/playback/:id/manifest.m3u8', async (request, reply) => {
    const session = playbacks.get((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: 'playback_not_found' });
    if (session.expiresAt <= now() || session.owner !== ownerOf(request))
      return reply.code(404).send({ error: 'playback_not_found' });
    // A half-hour contains up to 2000 fragments, while each archive lookup is
    // deliberately bounded. Shared init objects must also be deduplicated first.
    const objectIds = [
      ...new Set(
        session.segments.flatMap((segment) =>
          segment.initObjectId
            ? [segment.mediaObjectId, segment.initObjectId]
            : [segment.mediaObjectId],
        ),
      ),
    ];
    for (let offset = 0; offset < objectIds.length; offset += ARCHIVE_MEDIA_BATCH_LIMIT) {
      if (!(await archive.hasMedia(objectIds.slice(offset, offset + ARCHIVE_MEDIA_BATCH_LIMIT))))
        return reply.code(410).send({ error: 'coverage_changed' });
    }
    if (
      !playbacks.has((request.params as { id: string }).id) ||
      ownerOf(request) !== session.owner ||
      closed
    )
      return reply.code(404).send({ error: 'playback_not_found' });
    session.expiresAt = now() + 30 * 60000;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-TARGETDURATION:${Math.max(1, ...session.segments.map((segment) => Math.ceil(segment.durationSeconds)))}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];
    let previous: Segment | undefined;
    let init: string | null = null;
    for (const segment of session.segments) {
      const gap =
        previous?.wallEndMs != null &&
        segment.wallStartMs !== null &&
        Math.abs(segment.wallStartMs - previous.wallEndMs) > 250;
      if (
        previous &&
        (segment.discontinuity ||
          gap ||
          previous.sourceEpoch !== segment.sourceEpoch ||
          previous.initObjectId !== segment.initObjectId)
      )
        lines.push('#EXT-X-DISCONTINUITY');
      if (segment.initObjectId && segment.initObjectId !== init) {
        lines.push(`#EXT-X-MAP:URI="/api/media/${segment.initObjectId}"`);
        init = segment.initObjectId;
      }
      lines.push(
        `#EXTINF:${segment.durationSeconds.toFixed(3)},`,
        `/api/media/${segment.mediaObjectId}`,
      );
      previous = segment;
    }
    lines.push('#EXT-X-ENDLIST');
    return reply
      .header('cache-control', 'no-store')
      .type('application/vnd.apple.mpegurl')
      .send(lines.join('\n') + '\n');
  });
  return {
    closeOwner(owner: string) {
      for (const [controller, current] of operations) if (current === owner) controller.abort();
      for (const [id, session] of playbacks) if (session.owner === owner) playbacks.delete(id);
    },
    close() {
      closed = true;
      for (const controller of operations.keys()) controller.abort();
      playbacks.clear();
    },
  };
}
