import { tr } from '../../shared/lib/i18n';
import type { PublicStatus } from '@st-vault/api-schema';
import { statusBands } from './status-bands';
import type { TrackData } from './track-data';
export type { TrackData } from './track-data';
import {
  coverageBands,
  coverageGeometry,
  coverageSurface,
  splitSeenCoverage,
} from './coverage-bands';
import { formatDateTime } from './timeline';
import './timeline.css';
import { memo, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLayoutMotion } from '../../design/use-layout-motion';
import {
  useDeletionProjections,
  pendingProjection,
  projectionRanges,
  subtractRanges,
} from '../../shared/lib/deletion-projection';
const STATUS_NAMES: Record<PublicStatus, string> = {
  PUBLIC: '公开直播',
  PRIVATE: '私密',
  OFFLINE: '离线',
  UNKNOWN: '未知',
};
export const TimelineBands = memo(function TimelineBands({
  data,
  fromMs,
  toMs,
  overscanMs = 0,
  animateWindow = false,
  widthPx = 0,
  nowMs = Date.now(),
}: {
  data?: TrackData;
  fromMs: number;
  toMs: number;
  overscanMs?: number;
  animateWindow?: boolean;
  widthPx?: number;
  nowMs?: number;
}): JSX.Element {
  useTranslation();
  const sheenId = useId();
  const root = useRef<HTMLDivElement>(null);
  const deletions = useDeletionProjections();
  const holes = useMemo(
    () =>
      deletions
        .filter((entry) =>
          pendingProjection(entry, data?.coverage.subjectId, data?.coverage.revision),
        )
        .flatMap((entry) => projectionRanges(entry, data?.coverage.protectedSpans)),
    [deletions, data],
  );
  const duration = Math.max(1, toMs - fromMs),
    position = (at: number): string => `${(100 * (at - fromMs)) / duration}%`;
  const clips = useMemo(
    () =>
      subtractRanges(
        coverageBands(
          data?.coverage.buckets ?? [],
          fromMs - overscanMs,
          toMs + overscanMs,
          widthPx > 0 ? duration / widthPx : 0,
        ),
        holes,
      ).map((band) => ({ ...band, key: band.fromMs })),
    [data?.coverage.buckets, fromMs, toMs, overscanMs, duration, widthPx, holes],
  );
  const now = nowMs,
    bands = data?.bands.flatMap((band) => {
      if (band.fromMs >= now) return [];
      if (band.toMs <= now) return [band];
      // The API counts future status time as UNKNOWN. Remove that time before
      // choosing the visible status and tooltip, keeping historical unknowns.
      return statusBands([
        {
          ...band,
          toMs: now,
          durationsMs: {
            ...band.durationsMs,
            UNKNOWN: Math.max(0, band.durationsMs.UNKNOWN - (band.toMs - now)),
          },
        },
      ]);
    });
  const surfaces = useMemo(
    () =>
      splitSeenCoverage(clips, data?.coverage.seenSpans ?? []).map(({ seen, bands }) => ({
        seen,
        surface: coverageSurface(bands, fromMs, toMs, widthPx || 600),
      })),
    [clips, fromMs, toMs, widthPx, data?.coverage.seenSpans],
  );
  // Geometry owns motion: a new response/revision with identical pixels must not
  // cancel and recapture every coverage element during a background refresh.
  const geometry = JSON.stringify([
    fromMs,
    toMs,
    widthPx,
    clips.map(({ fromMs, toMs, level }) => [fromMs, toMs, level]),
    data?.coverage.seenSpans,
    bands?.map(({ fromMs, toMs, status }) => [fromMs, toMs, status]),
  ]);
  useLayoutMotion(
    root,
    `${data?.coverage.subjectId ?? ''}:${animateWindow ? 'focus' : `${fromMs}:${toMs}`}`,
    geometry,
  );
  return (
    <div ref={root} className="timeline-content">
      <div className="status-line" aria-label={tr('主播状态线')}>
        {bands?.map((band) => (
          <span
            key={band.fromMs}
            data-motion-key={`status:${band.fromMs}`}
            className={`status-band status-band-${band.status.toLowerCase()}`}
            aria-label={`${formatDateTime(band.fromMs)} · ${(
              Object.entries(band.durationsMs) as [PublicStatus, number][]
            )
              .filter(([, ms]) => ms > 0)
              .map(([status, ms]) =>
                tr('{{v0}} {{v1}}秒', { v0: tr(STATUS_NAMES[status]), v1: Math.round(ms / 1000) }),
              )
              .join(' / ')}`}
            style={{
              left: position(band.fromMs),
              width: `${(100 * (band.toMs - band.fromMs)) / duration}%`,
            }}
          />
        ))}
      </div>
      <div className="recording-line" aria-label={tr('录像覆盖线')}>
        {surfaces.map(
          ({ seen, surface }) =>
            surface && (
              <svg
                key={String(seen)}
                className="track-clip"
                data-seen={seen}
                data-motion-key={`coverage:${seen}`}
                viewBox="0 0 1000 100"
                preserveAspectRatio="none"
                role="img"
                aria-label={tr('{{v0}} · 录像 {{v1}} 秒', {
                  v0: formatDateTime(surface.extent.fromMs),
                  v1: Math.round(surface.extent.coveredMs) / 1000,
                })}
                style={coverageGeometry(surface.extent, fromMs, toMs)}
              >
                <defs>
                  <linearGradient id={`${sheenId}:${seen}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" className="coverage-edge" />
                    <stop offset=".12" className="coverage-light" />
                    <stop offset=".42" className="coverage-base" />
                    <stop offset=".55" className="coverage-shade" />
                    <stop offset=".82" className="coverage-base" />
                    <stop offset="1" className="coverage-light" />
                  </linearGradient>
                </defs>
                {surface.paths.map(({ level, d }) => (
                  <path
                    key={level}
                    d={d}
                    fill={`url(#${sheenId}:${seen})`}
                    opacity={0.35 + (0.65 * level) / 15}
                  />
                ))}
              </svg>
            ),
        )}
      </div>
    </div>
  );
});
