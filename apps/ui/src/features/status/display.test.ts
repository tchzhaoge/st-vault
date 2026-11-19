import { describe, expect, it } from 'vitest';
import { systemHealthStatus } from './display';
describe('system health status', () => {
  it('does not show stale healthy data after a failed status request or archive probe', () => {
    expect(systemHealthStatus({ lowSpace: false, serviceError: true }).kind).toBe('unavailable');
    const status = systemHealthStatus({
      lowSpace: false,
      archiveError: 'archive_timeout',
      restarting: true,
    });
    expect(status.kind).toBe('unavailable');
    expect(status.messages.join(' ')).toContain('重启');
  });
  it('prioritizes disk availability and low space without hiding maintenance warnings', () => {
    const unavailable = systemHealthStatus({
      diskError: 'private-path-or-error',
      lowSpace: true,
      maintenanceError: 'retention_cleanup_failed',
    });
    expect(unavailable.kind).toBe('unavailable');
    expect(unavailable.title).toBe('磁盘状态暂不可用');
    expect(unavailable.messages.join(' ')).not.toContain('private-path-or-error');
    expect(unavailable.messages.some((message) => message.includes('自动清理失败'))).toBe(true);

    const low = systemHealthStatus({
      lowSpace: true,
      maintenanceError: 'archive_integrity_check_failed',
    });
    expect(low.kind).toBe('low-space');
    expect(low.messages.some((message) => message.includes('完整性巡检失败'))).toBe(true);
  });

  it('shows maintenance failures and returns to normal when they clear', () => {
    expect(
      systemHealthStatus({
        lowSpace: false,
        maintenanceError: 'archive_integrity_check_failed',
      }).kind,
    ).toBe('integrity');
    expect(
      systemHealthStatus({
        lowSpace: false,
        maintenanceError: 'retention_cleanup_failed',
      }).kind,
    ).toBe('retention');
    expect(
      systemHealthStatus({
        lowSpace: false,
        maintenanceError: null,
        diskError: null,
      }),
    ).toEqual({ kind: 'ok', title: '归档服务正常', messages: [] });
  });
});
