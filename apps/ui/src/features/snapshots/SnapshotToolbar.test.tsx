import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SnapshotToolbar, type SnapshotToolbarProps } from './SnapshotToolbar';
const props: SnapshotToolbarProps = {
  total: 90,
  pageIndex: 0,
  pages: 3,
  live: false,
  connected: true,
  busy: false,
  onPrevious: vi.fn(),
  onNext: vi.fn(),
  onUnlike: vi.fn(),
  onDelete: vi.fn(),
};
it('shows exactly two direct range actions without editing or selection controls', () => {
  const html = renderToStaticMarkup(<SnapshotToolbar {...props} />);
  for (const action of ['取消所有喜欢', '删除所有非喜欢'])
    expect(html).toContain(`aria-label="${action}"`);
  for (const removed of ['snapshot-edit-toggle', '编辑', '全选', '已选'])
    expect(html).not.toContain(removed);
});
it.each([{ live: true }, { pages: 1 }, { pages: 0 }, { pageIndex: -1 }])(
  'omits pagination when unnecessary: %j',
  (mode) => {
    const html = renderToStaticMarkup(<SnapshotToolbar {...props} {...mode} />);
    expect(html).not.toContain('snapshot-page-button');
    expect(html).toContain('取消所有喜欢');
  },
);
it('keeps page navigation available during a favorite command', () => {
  const html = renderToStaticMarkup(
    <SnapshotToolbar {...props} pageIndex={1} busy status="请求未完成" />,
  );
  expect(html).toContain('2 / 3');
  expect(html).not.toContain('aria-label="上一页" disabled');
  expect(html).not.toContain('aria-label="下一页" disabled');
  expect(html).toMatch(/aria-label="取消所有喜欢"[^>]*disabled/);
  expect(html).toContain('snapshot-operation-status');
});
it('disables range actions without media and reserves large page numbers', () => {
  const html = renderToStaticMarkup(
    <SnapshotToolbar {...props} total={0} pages={9999} pageIndex={9998} />,
  );
  expect(html).toMatch(/aria-label="删除所有非喜欢"[^>]*disabled/);
  expect(html).toContain('min-width:11ch');
  expect(html).toContain('9999 / 9999');
});
