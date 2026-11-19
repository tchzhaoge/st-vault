import type { BackgroundTask, MediaDeletionJob, Subject } from '@st-vault/api-schema';
import { ApiError } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { clockLabel, dayKey, dayLabel } from '../../shared/lib/date-label';
import { PanelSection } from '../../shared/ui/PanelContent';
import { ProgressRing } from '../../shared/ui/ProgressRing';
import { OverflowText } from '../../shared/ui/OverflowText';
import { DeletionTasks } from './DeletionTasks';
import './background-tasks.css';

const labels: Record<string, string> = {
  'capture-status': '主播状态同步',
  'public-status-evidence': '状态与直播许可',
  'account-list': '关注清单同步',
  'cover-sync': '封面更新',
  'avatar-sync': '头像更新',
  'site-probe': '登录前站点测速',
  'site-access': '账户绑定站点',
  'archive-index': '录像单元索引',
  'library-checkpoint': '媒体库检查点',
  'orphan-sweep': '中断遗留文件检查',
  snapshots: '截图生成与补齐',
  'snapshot-maintenance': '截图校验与缓存回收',
  'favorite-materialization': '喜欢标记持久化',
  deletion: '录像删除与回收',
  'disk-check': '磁盘与可写性检查',
  retention: '录像保留期清理',
  'integrity-scan': '录像完整性巡检',
  'run-heartbeat': '运行心跳',
  'client-sync': '客户端更新推送',
};
const stateLabels: Record<BackgroundTask['state'], string> = {
  running: '执行中',
  idle: '空闲',
  waiting: '等待',
  retrying: '等待重试',
  paused: '已暂停',
  error: '异常',
  disabled: '未启用',
};
const partialImageError = '部分图片未更新，继续保留已有图片。';
const errors: Record<string, string> = {
  account_reconnect: '请在账户面板更新 Cookies。',
  disk_read_only: '数据目录只读，恢复可写后继续。',
  disk_permission_denied: '数据目录没有写入权限，请检查挂载权限。',
  disk_write_failed: '数据盘写入失败，请检查存储设备与运行日志。',
  disk_full: '数据盘已满，请释放空间。',
  disk_unavailable: '数据盘暂不可用，请检查挂载。',
  disk_low_space: '剩余空间低于保护阈值，请释放空间。',
  data_disk_low_space: '应用数据盘剩余空间不足，请释放索引所在磁盘的空间。',
  retention_cleanup_failed: '保留期清理未完成，将再次尝试。',
  favorite_materialization_failed: '喜欢标记已保存，后台整理将再次尝试。',
  archive_integrity_check_failed: '巡检发现异常，请检查归档和备份。',
  recording_unit_index_failed: '录像索引未完成，请检查归档状态。',
  library_checkpoint_failed: '媒体库检查点未完成，日志仍保留，将再次尝试。',
  library_write_recovery_required: '媒体库持久写入中断，请恢复存储后重启服务。',
  orphan_cleanup_failed: '遗留文件检查未完成，请检查归档状态。',
  image_refresh_partial: partialImageError,
  cover_refresh_partial: partialImageError,
  avatar_refresh_partial: partialImageError,
  screenshot_storage_unavailable: '截图存储暂不可用，正在重试。',
  account_sync_failed: '关注清单同步未完成，请查看账户面板。',
  run_heartbeat_failed: '运行心跳未写入，正在重新尝试。',
  task_status_unavailable: '任务状态暂不可用，下次刷新重试。',
  client_sync_failed: '客户端更新推送中断，正在重新连接。',
  status_sync_failed: '本轮主播状态同步未完成，将重新尝试。',
  site_unavailable: '绑定站点访问失败，将在该站点继续重试；换站需先退出账户。',
  site_verification_required:
    '站点数据接口要求人机验证；网页可访问不代表该接口已放行，现有数据会继续保留。',
  site_request_timeout: '绑定站点的数据请求超时，后续实际请求会重新确认状态。',
  site_network_unavailable: '容器连接绑定站点失败，请检查容器的网络与 DNS。',
  site_rate_limited: '站点暂时限制请求频率，后续请求将重新确认状态。',
  site_response_invalid: '站点接口未返回有效 JSON；可能返回了验证页或响应格式已变化。',
  site_probe_failed: '站点测速均未成功，可在账户面板手动重测。',
  deletion_retry: '文件回收已暂停，存储恢复后继续。',
  screenshot_cleanup_failed: '截图缓存回收未完成，将再次尝试。',
  screenshot_audit_failed: '截图校验未完成，将再次尝试。',
};
const groups = [
  ['sync', '同步与连接'],
  ['processing', '录像处理'],
  ['protection', '存储维护'],
] as const;

function timestamp(at: number, now: number): string {
  return `${dayKey(at) === dayKey(now) ? '' : `${dayLabel(at, now)} `}${clockLabel(at)}`;
}
/** Queue discovery may grow totals; unknown totals never imply a percentage. */
export function taskProgress(task: BackgroundTask): string {
  const processed = Math.max(0, task.processed ?? 0),
    total = task.total;
  const text =
    task.detail === 'connected-clients' && task.processed !== undefined
      ? tr('{{v0}} 个客户端已连接', { v0: processed.toLocaleString() })
      : task.detail === 'subject-scan' && total !== undefined && total > 0
        ? tr('已检查 {{v0}} / {{v1}} 位主播', {
            v0: Math.min(processed, total).toLocaleString(),
            v1: total.toLocaleString(),
          })
        : total !== undefined && total > 0
          ? tr('已处理 {{v0}} / {{v1}}', {
              v0: Math.min(processed, total).toLocaleString(),
              v1: total.toLocaleString(),
            })
          : task.detail === 'index-batches' && processed > 0
            ? tr('本次 {{v0}} 批', { v0: processed.toLocaleString() })
            : task.detail === 'checked-files' && processed > 0
              ? tr('已检查 {{v0}} 个文件', { v0: processed.toLocaleString() })
              : task.id === 'snapshots' && task.processed !== undefined
                ? tr('已生成 {{v0}} 张', { v0: processed.toLocaleString() })
                : processed > 0
                  ? tr('已处理 {{v0}}', { v0: processed.toLocaleString() })
                  : '';
  const pending =
    (task.pending ?? 0) > 0 ? tr('待处理 {{v0}}', { v0: task.pending!.toLocaleString() }) : '';
  const failed =
    (task.failed ?? 0) > 0
      ? tr(task.id === 'site-probe' ? '不可用 {{v0}}' : '重试 {{v0}}', {
          v0: task.failed!.toLocaleString(),
        })
      : '';
  const executing =
    task.active !== undefined && task.active > 0 && task.limit !== undefined
      ? tr('执行 {{v0}} / {{v1}}', { v0: task.active, v1: task.limit })
      : '';
  return [executing, text, pending, failed].filter(Boolean).join(' · ');
}
export function taskSchedule(task: BackgroundTask, now: number): string {
  if (task.detail === 'manual-site-probe') return tr('账户面板手动测速');
  if (task.detail === 'account-bound')
    return task.lastRunAtMs !== null && task.lastRunAtMs !== undefined
      ? tr('最近请求 {{v0}}', { v0: timestamp(task.lastRunAtMs, now) })
      : tr('等待实际数据请求');
  if (task.detail === 'account-disconnected') return tr('连接账户后同步');
  if (task.state === 'disabled') return task.id === 'retention' ? tr('永久保留') : '';
  if (task.detail === 'screenshot-storage-opening') return tr('正在打开截图存储');
  if (task.detail === 'recovering') return tr('正在恢复截图存储');
  if (task.detail === 'temporary-recovery')
    return tr(task.state === 'running' ? '正在恢复临时文件' : '临时文件等待恢复');
  if (task.nextRunAtMs)
    return task.nextRunAtMs <= now
      ? tr('待调度')
      : tr('下次 {{v0}}', { v0: timestamp(task.nextRunAtMs, now) });
  if (task.detail === 'legacy-retirement')
    return tr(task.state === 'running' ? '正在回收旧截图缓存' : '旧截图缓存待回收');
  if (task.detail === 'schedule-only' && task.lastRunAtMs)
    return tr('最近调度 {{v0}}', { v0: timestamp(task.lastRunAtMs, now) });
  if (task.lastSuccessAtMs)
    return tr('最近成功 {{v0}}', { v0: timestamp(task.lastSuccessAtMs, now) });
  if (task.lastRunAtMs) return tr('最近执行 {{v0}}', { v0: timestamp(task.lastRunAtMs, now) });
  if (task.detail === 'bounded-audit') return tr('分批校验与清理');
  return '';
}

/** External access failures alarm the menu without mislabelling the local archive service. */
export function backgroundTaskAlert(tasks: BackgroundTask[]): string | undefined {
  if (tasks.some((task) => task.id === 'site-access' && task.error)) return tr('绑定站点访问异常');
  if (tasks.some((task) => task.id === 'account-list' && task.error)) return tr('关注清单同步异常');
  if (tasks.some((task) => task.error && task.id !== 'site-probe')) return tr('后台任务异常');
  return undefined;
}
function taskReason(task: BackgroundTask): string {
  if (!task.error) return '';
  if (
    task.id === 'account-list' &&
    task.error !== 'account_reconnect' &&
    task.error !== 'account_sync_failed'
  )
    return messageFor(new ApiError(task.error, 400));
  return tr(
    errors[task.error] ??
      (task.state === 'retrying' ? '本轮未完成，等待再次尝试。' : '任务异常，请查看运行日志。'),
  );
}
function taskState(task: BackgroundTask): string {
  if (task.error === 'task_status_unavailable') return tr('状态待确认');
  if (task.id === 'site-access' && task.state === 'idle') return tr('可用');
  if (task.id === 'site-access' && task.state === 'waiting') return tr('待观测');
  return tr(stateLabels[task.state]);
}
export function BackgroundTasks({
  tasks,
  capturedAtMs,
  deletions = [],
  subjects = [],
}: {
  tasks: BackgroundTask[];
  capturedAtMs: number;
  deletions?: MediaDeletionJob[];
  subjects?: Subject[];
}): JSX.Element | null {
  const known = tasks.filter((task) => labels[task.id]);
  if (!known.length) return null;
  const attention = (task: BackgroundTask): boolean =>
    Boolean(task.error) ||
    (task.pending ?? 0) > 0 ||
    ['running', 'paused', 'retrying', 'error'].includes(task.state);
  const highlighted = known.filter(attention);
  const quiet = known.filter((task) => !attention(task));
  const renderGroups = (list: BackgroundTask[]) =>
    groups.map(([group, title]) => {
      const rows = list.filter((task) => task.group === group);
      if (!rows.length) return null;
      return (
        <PanelSection key={group} title={tr(title)}>
          <ul className="background-task-list">
            {rows.map((task) => {
              const progress = taskProgress(task),
                schedule = taskSchedule(task, capturedAtMs),
                activeDeletion =
                  task.id === 'deletion' && deletions.some((job) => job.state !== 'completed'),
                reason = taskReason(task),
                determinate =
                  !activeDeletion &&
                  task.state === 'running' &&
                  task.total !== undefined &&
                  task.total > 0,
                status = taskState(task),
                detail = [
                  task.target,
                  reason ||
                    [task.state === 'running' || activeDeletion ? '' : progress, schedule]
                      .filter(Boolean)
                      .join(' · '),
                ]
                  .filter(Boolean)
                  .join(' · ');
              return (
                <li
                  key={task.id}
                  className={`background-task is-${task.state}`}
                  data-task={task.id}
                >
                  <div className="background-task-heading">
                    <span className="background-task-label">{tr(labels[task.id])}</span>
                    <span
                      className="background-task-state"
                      aria-label={determinate ? `${tr(labels[task.id])} · ${status}` : status}
                      role={determinate ? 'progressbar' : undefined}
                      aria-valuemin={determinate ? 0 : undefined}
                      aria-valuemax={determinate ? task.total : undefined}
                      aria-valuenow={
                        determinate
                          ? Math.max(0, Math.min(task.total!, task.processed ?? 0))
                          : undefined
                      }
                    >
                      {activeDeletion ? (
                        <DeletionTasks inline jobs={deletions} subjects={subjects} />
                      ) : (
                        <>
                          {task.state === 'running' ? <ProgressRing /> : <i aria-hidden="true" />}
                          <OverflowText
                            text={task.state === 'running' ? progress || status : status}
                          />
                        </>
                      )}
                    </span>
                  </div>
                  <div className={`background-task-detail${reason ? ' is-reason' : ''}`}>
                    {detail && <OverflowText text={detail} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </PanelSection>
      );
    });
  return (
    <div className="background-tasks">
      {renderGroups(highlighted)}
      {quiet.length > 0 && (
        <details className="background-task-disclosure">
          <summary>{tr('查看其他后台任务')}</summary>
          <div>{renderGroups(quiet)}</div>
        </details>
      )}
    </div>
  );
}
