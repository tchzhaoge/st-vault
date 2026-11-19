import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SnapshotNotice } from './SnapshotNotice';
import { snapshotFailure, snapshotEmptyNotice } from './snapshot-status';
import { ApiError } from '../../shared/lib/api';
it('uses the shared player notice hierarchy and offers retry only when applicable', () => {
  const html = renderToStaticMarkup(
    <SnapshotNotice
      notice={snapshotFailure(new ApiError('preview_unavailable', 500))}
      compact
      onRetry={() => undefined}
    />,
  );
  expect(html).toContain('snapshot-status--compact');
  expect(html).toContain('playback-status-content');
  expect(html).toContain('截图索引服务未就绪');
  expect(html).toContain('重新读取');
  expect(html).toContain('aria-live="polite"');
  const idle = renderToStaticMarkup(
    <SnapshotNotice
      notice={snapshotEmptyNotice('idle')}
      compact={false}
      onRetry={() => undefined}
    />,
  );
  expect(idle).not.toContain('<button');
  expect(idle).not.toContain('spinner');
});
