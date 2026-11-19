import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { BackgroundTask, MediaDeletionJob } from '@st-vault/api-schema';
import {
  BackgroundTasks,
  backgroundTaskAlert,
  taskProgress,
  taskSchedule,
} from './BackgroundTasks';
const now = Date.UTC(2026, 10, 12, 7, 0, 0);
const task = (patch: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'snapshots',
  group: 'processing',
  state: 'running',
  ...patch,
});
it('does not reserve empty layout when no observable task is available', () => {
  expect(renderToStaticMarkup(<BackgroundTasks capturedAtMs={now} tasks={[]} />)).toBe('');
  expect(
    renderToStaticMarkup(
      <BackgroundTasks capturedAtMs={now} tasks={[task({ id: 'internal-only' })]} />,
    ),
  ).toBe('');
});
it('shows parallel occupancy inside the existing progress line and hides idle occupancy', () => {
  expect(taskProgress(task({ active: 3, limit: 8, processed: 100 }))).toContain('执行 3 / 8');
  expect(taskProgress(task({ state: 'idle', active: 0, limit: 8, processed: 100 }))).not.toContain(
    '执行',
  );
  const html = renderToStaticMarkup(
    <BackgroundTasks capturedAtMs={now} tasks={[task({ active: 3, limit: 8 })]} />,
  );
  expect(html).not.toContain('background-task-progress');
});
it('shows the shared public-status evidence task with a readable label', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasks capturedAtMs={now} tasks={[task({ id: 'public-status-evidence' })]} />,
  );
  expect(html).toContain('状态与直播许可');
  expect(html).not.toContain('public-status-evidence</');
});
it('replaces the existing state with execution progress without adding a progress row', () => {
  const running = renderToStaticMarkup(
    <BackgroundTasks tasks={[task({ processed: 3, total: 10 })]} capturedAtMs={now} />,
  );
  const heading = running.split('background-task-detail')[0];
  expect(heading).toContain('已处理 3 / 10');
  expect(running).not.toContain('background-task-progress');
  const idle = renderToStaticMarkup(
    <BackgroundTasks
      tasks={[task({ state: 'idle', processed: 10, total: 10 })]}
      capturedAtMs={now}
    />,
  );
  expect(idle.split('background-task-detail')[0]).toContain('空闲');
  expect(idle.match(/class="background-task-detail/g)).toHaveLength(1);
  expect(running.match(/class="background-task-detail/g)).toHaveLength(1);
});
it('keeps unknown totals indeterminate and renders queue counts without inventing completion', () => {
  const value = task({ processed: 12, pending: 5, failed: 2 });
  expect(taskProgress(value)).toBe('已生成 12 张 · 待处理 5 · 重试 2');
  const html = renderToStaticMarkup(<BackgroundTasks tasks={[value]} capturedAtMs={now} />);
  expect(html).toContain('截图生成与补齐');
  expect(html).toContain('执行中');
  expect(html).not.toContain('progressbar');
  expect(html).not.toContain('%');
});
it('bounds determinate progress and does not divide by an empty total', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasks tasks={[task({ processed: 15, total: 10 })]} capturedAtMs={now} />,
  );
  expect(html).toContain('aria-valuenow="10"');
  expect(html).toContain('aria-valuemax="10"');
  expect(html).not.toContain('background-task-progress');
  expect(taskProgress(task({ processed: 0, total: 0 }))).toBe('已生成 0 张');
  expect(
    renderToStaticMarkup(
      <BackgroundTasks tasks={[task({ processed: 0, total: 0 })]} capturedAtMs={now} />,
    ),
  ).not.toContain('progressbar');
});
it('uses semantic units for index batches and integrity files', () => {
  expect(taskProgress(task({ id: 'archive-index', detail: 'index-batches', processed: 6 }))).toBe(
    '本次 6 批',
  );
  expect(taskProgress(task({ id: 'integrity-scan', detail: 'checked-files', processed: 32 }))).toBe(
    '已检查 32 个文件',
  );
});
it('distinguishes scheduled, due, on-demand and disabled work using the captured clock', () => {
  expect(taskProgress(task({ detail: 'connected-clients', processed: 0 }))).toBe(
    '0 个客户端已连接',
  );
  expect(taskSchedule(task({ state: 'waiting', nextRunAtMs: now + 60000 }), now)).toBe(
    '下次 15:01:00',
  );
  expect(taskSchedule(task({ state: 'waiting', nextRunAtMs: now - 1000 }), now)).toBe('待调度');
  expect(
    taskSchedule(task({ id: 'retention', state: 'disabled', nextRunAtMs: now + 60000 }), now),
  ).toBe('永久保留');
  expect(
    taskSchedule(
      task({ id: 'account-list', state: 'disabled', detail: 'account-disconnected' }),
      now,
    ),
  ).toBe('连接账户后同步');
  expect(taskSchedule(task({ id: 'snapshot-maintenance', detail: 'legacy-retirement' }), now)).toBe(
    '正在回收旧截图缓存',
  );
  expect(taskSchedule(task({ lastSuccessAtMs: now - 86400000 }), now)).toBe(
    '最近成功 昨天 15:00:00',
  );
  expect(
    taskSchedule(
      task({ detail: 'schedule-only', lastRunAtMs: now - 1000, lastSuccessAtMs: now - 500 }),
      now,
    ),
  ).toBe('最近调度 14:59:59');
});
it('groups tasks without exposing internal subscriptions or raw diagnostic data', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasks
      capturedAtMs={now}
      tasks={[
        task({ id: 'capture-status', group: 'sync', state: 'waiting' }),
        task({
          id: 'integrity-scan',
          group: 'protection',
          state: 'error',
          error: 'https://secret.invalid/private-token',
        }),
        task({ id: 'unit-tail:internal-session-token', state: 'running' }),
      ]}
    />,
  );
  expect(html).toContain('同步与连接');
  expect(html).toContain('存储维护');
  expect(html).toContain('任务异常，请查看运行日志。');
  expect(html).not.toContain('private-token');
  expect(html).not.toContain('internal-session-token');
  expect(html).not.toContain('录像处理');
});
it('keeps idle and disabled states neutral and gives actionable domain errors', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasks
      capturedAtMs={now}
      tasks={[
        task({ id: 'account-list', group: 'sync', state: 'error', error: 'account_reconnect' }),
        task({ id: 'site-probe', group: 'sync', state: 'idle' }),
        task({ id: 'retention', group: 'protection', state: 'disabled' }),
      ]}
    />,
  );
  expect(html).toContain('请在账户面板更新 Cookies。');
  expect(html).toContain('查看其他后台任务');
  expect(html).toContain('is-idle');
  expect(html).toContain('is-disabled');
  expect(html).not.toContain('is-ok');
});
it('distinguishes unavailable observation from actual task damage', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasks
      capturedAtMs={now}
      tasks={[task({ state: 'error', error: 'task_status_unavailable' })]}
    />,
  );
  expect(html).toContain('状态待确认');
  expect(html).toContain('任务状态暂不可用');
  expect(html).not.toContain('>异常<');
});
it('keeps manual network failures actionable without claiming an automatic retry', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasks
      capturedAtMs={now}
      tasks={[
        task({
          id: 'site-access',
          group: 'sync',
          state: 'error',
          error: 'site_unavailable',
          detail: 'account-bound',
        }),
        task({
          id: 'site-probe',
          group: 'sync',
          state: 'error',
          error: 'site_probe_failed',
          detail: 'on-demand',
        }),
      ]}
    />,
  );
  expect(html).toContain('绑定站点访问失败');
  expect(html).toContain('可在账户面板手动重测');
  expect(html).not.toContain('等待重试');
  expect(html).not.toContain('本轮未完成，等待再次尝试');
});
it('renders the public endpoint label even without counters or scheduling metadata', () => {
  const html = renderToStaticMarkup(
    <BackgroundTasks
      capturedAtMs={now}
      tasks={[task({ id: 'site-access', group: 'sync', state: 'idle', target: 'fast.invalid' })]}
    />,
  );
  expect(html).toContain('background-task-detail');
  expect(html).toContain('fast.invalid');
});
it('describes temporary recovery and storage initialization instead of generic deadlines', () => {
  expect(taskSchedule(task({ detail: 'temporary-recovery', nextRunAtMs: now + 60000 }), now)).toBe(
    '正在恢复临时文件',
  );
  expect(taskSchedule(task({ detail: 'temporary-recovery', state: 'waiting' }), now)).toBe(
    '临时文件等待恢复',
  );
  expect(taskSchedule(task({ detail: 'screenshot-storage-opening' }), now)).toBe(
    '正在打开截图存储',
  );
  expect(taskSchedule(task({ detail: 'recovering' }), now)).toBe('正在恢复截图存储');
  const html = renderToStaticMarkup(
    <BackgroundTasks
      capturedAtMs={now}
      tasks={[
        task({ id: 'disk-check', group: 'protection', state: 'paused', error: 'disk_low_space' }),
      ]}
    />,
  );
  expect(html).toContain('剩余空间低于保护阈值，请释放空间。');
  expect(html).not.toContain('任务异常，请查看运行日志。');
});
it('shows durable deletion activity once and leaves its progress inside the existing compact component', () => {
  const job: MediaDeletionJob = {
    id: 'd',
    subjectId: 'stripchat:42',
    state: 'running',
    total: 100,
    processed: 12,
    reclaimedBytes: 0,
    fromMs: 0,
    toMs: 60000,
    createdAtMs: now,
    updatedAtMs: now,
    error: null,
  };
  const html = renderToStaticMarkup(
    <BackgroundTasks
      tasks={[task({ id: 'deletion', processed: 12, total: 100 })]}
      capturedAtMs={now}
      deletions={[job]}
    />,
  );
  expect(html).toContain('archive-activity');
  expect(html).toContain('录像删除与回收');
  expect(html.match(/class="archive-activity"/g)).toHaveLength(1);
  expect(html.split('background-task-detail')[0]).toContain('archive-activity');
  expect(html).not.toContain('progressbar');
});

it('keeps manual probe failures separate from bound-site alarms and reuses account error messages', () => {
  expect(
    backgroundTaskAlert([task({ id: 'site-probe', state: 'error', error: 'site_probe_failed' })]),
  ).toBeUndefined();
  expect(
    backgroundTaskAlert([task({ id: 'site-access', state: 'error', error: 'site_unavailable' })]),
  ).toBe('绑定站点访问异常');
  const html = renderToStaticMarkup(
    <BackgroundTasks
      capturedAtMs={now}
      tasks={[
        task({
          id: 'site-access',
          state: 'error',
          target: 'new.invalid',
          detail: 'account-bound',
          error: 'site_unavailable',
        }),
        task({ id: 'account-list', state: 'error', error: 'cookies_domain_mismatch' }),
      ]}
    />,
  );
  expect(html).toContain('new.invalid');
  expect(html).toContain('换站需先退出账户');
  expect(html).toContain('Cookies 与所选站点域名不匹配');
  expect(html).not.toContain('请选择来源域名');
  expect(taskProgress(task({ id: 'site-probe', failed: 2 }))).toBe('不可用 2');
});
