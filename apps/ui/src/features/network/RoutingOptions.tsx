import { useEffect, useRef, useState } from 'react';
import type { NetworkRoutesStatus } from '@st-vault/api-schema';
import { request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { useSyncRefresh, syncReadFailure, type SyncReadResult } from '../../shared/lib/sync';
import { PanelFeedback } from '../../shared/ui/PanelContent';
import { Icon } from '../../design/Icon';
import './routing-options.css';

type Measurement = {
  testing?: boolean;
  error?: string | null;
} & ({ latencyMs: number | null } | { bytesPerSecond: number | null; bitrate: number | null });
const measurement = (item: Measurement): number | null =>
  'bytesPerSecond' in item ? item.bytesPerSecond : item.latencyMs;
export function routeSelectable(item: Measurement): boolean {
  return !item.error;
}
export function routeTone(item: Measurement): 'pending' | 'good' | 'fair' | 'poor' | 'unavailable' {
  if (item.testing) return 'pending';
  if (item.error) return 'unavailable';
  if (measurement(item) === null) return 'pending';
  if ('bytesPerSecond' in item) {
    if (!item.bitrate) return 'pending';
    const headroom = (item.bytesPerSecond! * 8) / item.bitrate;
    return headroom >= 2 ? 'good' : headroom >= 1 ? 'fair' : 'poor';
  }
  return item.latencyMs! <= 1000 ? 'good' : item.latencyMs! <= 2500 ? 'fair' : 'poor';
}
export function sortRoutes<T extends Measurement & { key: string }>(items: readonly T[]): T[] {
  const rank = (item: Measurement): number => (item.error ? 2 : measurement(item) !== null ? 0 : 1);
  const score = (item: Measurement): number =>
    'bytesPerSecond' in item ? -item.bytesPerSecond! : item.latencyMs!;
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) || (rank(a) === 0 ? score(a) - score(b) : 0) || a.key.localeCompare(b.key),
  );
}
export function routeMeasurement(item: Measurement): string {
  if (item.testing) return tr('测速中…');
  if (item.error) return tr('不可用');
  if (measurement(item) === null) return tr('未测速');
  if ('bytesPerSecond' in item) {
    const giga = item.bytesPerSecond! >= 1e9;
    const rate = item.bytesPerSecond! / (giga ? 1e9 : 1e6);
    return `${rate.toFixed(rate >= 100 ? 0 : rate >= 1 ? 1 : 2)} ${giga ? 'GB/s' : 'MB/s'}`;
  }
  return `${item.latencyMs} ms`;
}
export function routeProbeLabel(
  progress: { completed: number; total: number },
  compact = false,
): string {
  return `${tr('测速中…', compact ? { context: 'compact' } : undefined)} ${progress.completed}/${progress.total}`;
}

function cdnProbeIssue(error?: string | null): string | null {
  if (!error) return null;
  switch (error) {
    case 'no-public-probe-room':
      return tr('暂未找到公开直播间，无法测试播放清单，请稍后重试。');
    case 'live-key-required':
      return tr('当前直播流或解密密钥不可用，可更新密钥后重试。');
    case 'request-deadline':
      return tr('测速超时');
    case 'live-source-unavailable':
      return tr('无法读取此 CDN 的直播源');
    default:
      return tr('测速失败，请检查网络后重试。');
  }
}
/** Shared measurement list: website choice is a login draft; CDN choice is persisted. */
export function RoutingOptions({
  kind,
  subjectId,
  origin,
  onOriginChange,
  onCdnChanged,
  disabled = false,
}: {
  kind: 'sites' | 'cdn';
  subjectId?: string;
  origin?: string;
  onOriginChange?: (origin: string) => void;
  onCdnChanged?: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<NetworkRoutesStatus | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const revision = useRef(0),
    lock = useRef(false);
  const lifetime = useRef<AbortController>();
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current?.abort();
  }, []);
  useSyncRefresh(
    ['system'],
    async (signal): Promise<SyncReadResult> => {
      const version = revision.current;
      try {
        const next = await request<NetworkRoutesStatus>('/api/network/routes', { signal });
        if (version === revision.current && !signal.aborted) {
          setStatus(next);
          setError('');
        }
      } catch (cause) {
        if (!signal.aborted) setError(messageFor(cause));
        return syncReadFailure(cause, signal);
      }
    },
    true,
    '',
    true,
  );
  const selected = status
    ? kind === 'sites'
      ? (origin ?? null)
      : status.preferences.cdnHost
    : null;
  const cdn = status?.cdnProbe;
  const probing = kind === 'sites' ? status?.sites.probing : cdn?.running;
  const progress = kind === 'sites' ? status?.sites.probeProgress : cdn;
  const marked = selected ?? (kind === 'sites' ? status?.sites.selectedOrigin : null);
  const items = sortRoutes<Measurement & { key: string; label: string }>(
    kind === 'sites'
      ? (status?.sites.candidates ?? []).map((site) => ({
          ...site,
          key: site.origin,
          label: new URL(site.origin).hostname,
        }))
      : (status?.cdnHosts ?? []).map((host) => ({
          key: host,
          label: host.replace('edge-hls.', ''),
          testing: cdn?.testingHost === host,
          bytesPerSecond: null,
          bitrate: null,
          ...cdn?.results[host],
        })),
  );
  const probeProgress = progress ?? { completed: 0, total: items.length };
  const probeLabel = probing ? routeProbeLabel(probeProgress) : tr('重新测速');
  async function mutate(value: string): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    revision.current++;
    const signal = lifetime.current?.signal;
    try {
      const probe = value === 'probe';
      const next = await request<NetworkRoutesStatus>(
        probe ? '/api/network/probe' : '/api/network/routes',
        {
          method: probe ? 'POST' : 'PUT',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify(
            probe ? { kind, ...(kind === 'cdn' ? { subjectId } : {}) } : { cdnHost: value },
          ),
        },
      );
      if (!signal?.aborted) {
        setStatus(next);
        if (!probe) onCdnChanged?.();
      }
    } catch (cause) {
      if (!signal?.aborted) setError(messageFor(cause));
    } finally {
      lock.current = false;
      if (!signal?.aborted) setBusy(false);
    }
  }
  return (
    <div className={`routing-options routing-${kind}`} aria-busy={busy}>
      <div className="routing-toolbar">
        <button
          type="button"
          className="text-button"
          title={probeLabel}
          aria-label={probeLabel}
          aria-busy={probing}
          disabled={disabled || !status || busy || probing}
          onClick={() => void mutate('probe')}
        >
          {probing ? routeProbeLabel(probeProgress, true) : tr('重新测速', { context: 'compact' })}
        </button>
      </div>
      <small className="routing-caption">
        {kind === 'sites'
          ? tr('选择登录站点；登录后清单、状态与封面统一使用该站点，退出账户后才能更改。')
          : tr('切换 CDN 会让所有直播和录制立即重新连接。')}
      </small>
      <div
        className="routing-list"
        role="group"
        aria-label={kind === 'sites' ? tr('接入点清单') : tr('HLS CDN 清单')}
      >
        {items.map((item) => (
          <button
            type="button"
            key={item.key}
            className="routing-item"
            aria-busy={item.testing}
            disabled={disabled || busy || !routeSelectable(item)}
            aria-pressed={marked === item.key}
            title={
              kind === 'cdn'
                ? (cdnProbeIssue(item.error) ?? item.label)
                : (item.error ?? item.label)
            }
            onClick={() => (kind === 'sites' ? onOriginChange?.(item.key) : void mutate(item.key))}
          >
            <span className="routing-label">
              <span className="routing-selection" aria-hidden="true">
                <Icon name="check" />
              </span>
              <span className="routing-host">{item.label}</span>
            </span>
            <span
              className={`routing-metric is-${routeTone(item)}`}
              title={
                kind === 'sites'
                  ? tr('绿色 ≤1秒 · 黄色 ≤2.5秒 · 红色 >2.5秒；不可用的线路禁止选择')
                  : (cdnProbeIssue(item.error) ??
                    tr('绿色：下载速度≥视频码率2倍；黄色：≥1倍；红色：不足1倍；测速失败不可选。'))
              }
            >
              {routeMeasurement(item)}
            </span>
          </button>
        ))}
      </div>
      {!status && !error && <PanelFeedback kind="busy">{tr('正在读取接入点')}</PanelFeedback>}
      {(error || (kind === 'cdn' && cdnProbeIssue(cdn?.error))) && (
        <PanelFeedback kind="error">{error || cdnProbeIssue(cdn?.error)}</PanelFeedback>
      )}
    </div>
  );
}
