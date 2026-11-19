import { tr } from '../../shared/lib/i18n';
export type SystemHealthKind =
  'unavailable' | 'low-space' | 'integrity' | 'retention' | 'checking' | 'ok';
export interface SystemHealth {
  kind: SystemHealthKind;
  title: string;
  messages: string[];
}

export function systemHealthStatus(input: {
  diskError?: string | null;
  lowSpace: boolean;
  maintenanceError?: string | null;
  archiveError?: string | null;
  serviceError?: boolean;
  restarting?: boolean;
  snapshotUnavailable?: boolean;
}): SystemHealth {
  const messages: string[] = [];
  if (input.serviceError) messages.push(tr('系统状态读取失败，正在自动重试。'));
  if (input.archiveError && input.archiveError !== 'archive_checking') {
    messages.push(
      tr(
        input.archiveError === 'archive_timeout'
          ? '归档工作线程响应超时，正在重试检查。'
          : input.archiveError === 'archive_worker_unavailable'
            ? '归档工作线程已停止，正在准备恢复。'
            : input.archiveError === 'archive_recovery_required'
              ? '上次写入中断，归档需重新打开并校验。'
              : '归档数据库暂不可用，正在自动重试。',
      ),
    );
    if (input.restarting) messages.push(tr('正在停止录制并安全重启服务。'));
  }
  if (input.diskError) {
    messages.push(
      tr(
        input.diskError === 'disk_read_only'
          ? '数据目录只读，录制已暂停；恢复可写后自动重试。'
          : input.diskError === 'disk_permission_denied'
            ? '数据目录没有写入权限，录制已暂停；请恢复目录权限。'
            : input.diskError === 'disk_full'
              ? '数据盘无法继续写入，录制已暂停；释放空间后自动重试。'
              : input.diskError === 'disk_write_failed'
                ? '数据目录写入检查失败，录制已暂停并定时重试。'
                : input.diskError === 'disk_check_stale'
                  ? '磁盘检查未及时完成，录制已暂停；正在等待存储恢复。'
                  : '无法读取磁盘空间状态，请检查数据盘及挂载；新采集可能暂停。',
      ),
    );
  } else if (input.lowSpace)
    messages.push(tr('可用空间低于保护阈值，新采集会暂停，空间恢复后再继续。'));

  if (input.maintenanceError === 'archive_integrity_check_failed') {
    messages.push(tr('归档完整性巡检失败，请检查归档状态并确认已有备份。'));
  } else if (input.maintenanceError === 'retention_cleanup_failed') {
    messages.push(tr('保留期自动清理失败，请检查存储空间和目录权限。'));
  }

  if (input.snapshotUnavailable) messages.push(tr('截图任务存储暂不可用，正在自动重试。'));

  if (input.serviceError)
    return { kind: 'unavailable', title: tr('归档服务状态暂不可用'), messages };
  if (input.diskError) return { kind: 'unavailable', title: tr('磁盘状态暂不可用'), messages };
  if (input.lowSpace) return { kind: 'low-space', title: tr('磁盘空间偏低'), messages };
  if (input.maintenanceError === 'archive_integrity_check_failed')
    return { kind: 'integrity', title: tr('归档完整性检查失败'), messages };
  if (input.maintenanceError === 'retention_cleanup_failed')
    return { kind: 'retention', title: tr('保留期清理失败'), messages };
  if (input.archiveError && input.archiveError !== 'archive_checking')
    return { kind: 'unavailable', title: tr('归档服务异常'), messages };
  if (input.snapshotUnavailable)
    return { kind: 'unavailable', title: tr('截图服务暂不可用'), messages };
  if (input.archiveError === 'archive_checking')
    return { kind: 'checking', title: tr('正在检查归档服务'), messages };
  return { kind: 'ok', title: tr('归档服务正常'), messages };
}
