import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SystemSummary } from './SystemSummary';
import type { SystemInfo } from './system';
const system: SystemInfo = {
  version: 'test',
  capturedAtMs: 1000,
  disk: { freeBytes: 5 * 1024 ** 3, totalBytes: 10 * 1024 ** 3, lowSpace: false },
  capture: { pollMs: 5000, active: 3, starting: 1, retrying: 2 },
  ingress: { subjects: 4, retainedBytes: 1024, maxBytes: 10240 },
  backgroundTasks: [
    {
      id: 'archive-index',
      group: 'processing',
      state: 'running',
      processed: 3,
      detail: 'index-batches',
    },
  ],
};
it('combines lightweight resource facts with actual background tasks instead of old duplicate status rows', () => {
  const html = renderToStaticMarkup(
    <SystemSummary system={system} health={null} autoRecordingCount={5} />,
  );
  expect(html).not.toContain('共享直播入口');
  expect(html).toContain('启动 1 · 重连 2');
  expect(html).not.toContain('连接恢复');
  expect(html).toContain('本次 3 批');
  expect(html).toContain('5.00 GiB');
  expect(html).toContain('width:50%');
  expect(html).not.toContain('截图 ·');
  expect(html).not.toContain('匿名接口');
});
it('does not draw a fake disk progress bar before capacity is known', () => {
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{ ...system, disk: { freeBytes: 0, totalBytes: 0, lowSpace: true } }}
      health={null}
      autoRecordingCount={0}
    />,
  );
  expect(html).not.toContain('磁盘剩余空间');
});
