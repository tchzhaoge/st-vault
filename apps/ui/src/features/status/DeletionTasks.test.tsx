import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { MediaDeletionJob } from '@st-vault/api-schema';
import { DeletionTasks } from './DeletionTasks';
const job: MediaDeletionJob = {
  id: 'job',
  subjectId: 'stripchat:42',
  state: 'running',
  total: 1000,
  processed: 128,
  reclaimedBytes: 1024,
  fromMs: 1000,
  toMs: 61000,
  createdAtMs: 1000,
  updatedAtMs: 2000,
  error: null,
};
it('shows active work in one compact line without cards or a separate progress bar', () => {
  const html = renderToStaticMarkup(<DeletionTasks jobs={[job]} subjects={[]} />);
  expect(html).toContain('stripchat:42');
  expect(html).toContain('正在删除');
  expect(html).toContain('128');
  expect(html).toContain('1,000');
  expect(html).toContain('12%');
  expect(html).toContain('archive-activity');
  expect(html).toContain('overflow-text');
  expect(html).not.toContain('<article');
  expect(html).not.toContain('progressbar');
});
it('omits completed work and shows recovery alongside active task progress', () => {
  const html = renderToStaticMarkup(
    <DeletionTasks
      jobs={[
        { ...job, state: 'retry', error: 'storage_unavailable' },
        { ...job, id: 'done', state: 'completed', processed: 1000 },
      ]}
      subjects={[]}
    />,
  );
  expect(html).toContain('等待恢复');
  expect(html).not.toContain('已完成');
  expect(html).not.toContain('至少回收');
});
it('disappears when there is no background work', () => {
  expect(renderToStaticMarkup(<DeletionTasks jobs={[]} subjects={[]} />)).toBe('');
  expect(
    renderToStaticMarkup(<DeletionTasks jobs={[{ ...job, state: 'completed' }]} subjects={[]} />),
  ).toBe('');
});
it('replaces the existing inline status with preparation progress without adding rows or a fake percentage', () => {
  const html = renderToStaticMarkup(
    <DeletionTasks
      inline
      jobs={[{ ...job, state: 'preparing', phase: 'units', scannedUnits: 256, selectedUnits: 240 }]}
      subjects={[]}
    />,
  );
  expect(html).toContain('正在准备删除');
  expect(html).toContain('已检查 256');
  expect(html).toContain('已选 240');
  expect(html).not.toContain('%');
  expect(html).not.toContain('<div');
});
