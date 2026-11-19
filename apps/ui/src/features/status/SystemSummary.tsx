import type { MediaDeletionJob, Subject } from '@st-vault/api-schema';
import { tr } from '../../shared/lib/i18n';
import { PanelSection } from '../../shared/ui/PanelContent';
import { OverflowText } from '../../shared/ui/OverflowText';
import { ArchiveHealth } from './ArchiveHealth';
import { BackgroundTasks } from './BackgroundTasks';
import { DeletionTasks } from './DeletionTasks';
import type { SystemHealth } from './display';
import type { SystemInfo } from './system';
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function SystemSummary({
  deletions = [],
  subjects = [],
  system,
  health,
  autoRecordingCount,
}: {
  deletions?: MediaDeletionJob[];
  subjects?: Subject[];
  system: SystemInfo | null;
  health: SystemHealth | null;
  autoRecordingCount: number;
}): JSX.Element {
  const diskRatio = system?.disk.totalBytes
    ? Math.min(1, Math.max(0, system.disk.freeBytes / system.disk.totalBytes))
    : 0;
  const tasks = system?.backgroundTasks ?? [];
  const recording = system
    ? tr('{{v0}} 正在录制 · {{v1}} 已设自动录制', {
        v0: system.capture.active,
        v1: autoRecordingCount,
        context: 'compact',
      })
    : '';
  const recovery =
    system && ((system.capture.starting ?? 0) > 0 || (system.capture.retrying ?? 0) > 0)
      ? tr('启动 {{v0}} · 重连 {{v1}}', {
          v0: system.capture.starting ?? 0,
          v1: system.capture.retrying ?? 0,
        })
      : '';
  return (
    <section
      className={`system-summary${system?.disk.lowSpace ? ' low-space' : ''}`}
      aria-label={tr('系统状态')}
    >
      <PanelSection title={tr('运行状态')}>
        <ArchiveHealth
          health={health}
          activity={
            !tasks.some((task) => task.id === 'deletion') &&
            deletions.some((job) => job.state !== 'completed') ? (
              <DeletionTasks inline jobs={deletions} subjects={subjects} />
            ) : undefined
          }
        />
        {system && (
          <div className="system-overview">
            <div className="system-stats">
              <span>{tr('录制')}</span>
              <span>
                <OverflowText text={[recording, recovery].filter(Boolean).join(' · ')} />
              </span>
            </div>
            <div className="disk-meta">
              <span>{tr('剩余 {{v0}}', { v0: formatBytes(system.disk.freeBytes) })}</span>
              <span>{tr('共 {{v0}}', { v0: formatBytes(system.disk.totalBytes) })}</span>
            </div>
            {system.disk.totalBytes > 0 && (
              <div
                className="disk-track"
                role="progressbar"
                aria-label={tr('磁盘剩余空间')}
                aria-valuemin={0}
                aria-valuemax={system.disk.totalBytes}
                aria-valuenow={system.disk.freeBytes}
              >
                <span style={{ width: `${diskRatio * 100}%` }} />
              </div>
            )}
          </div>
        )}
      </PanelSection>
      <BackgroundTasks
        tasks={tasks}
        capturedAtMs={system?.capturedAtMs ?? Date.now()}
        deletions={deletions}
        subjects={subjects}
      />
    </section>
  );
}
