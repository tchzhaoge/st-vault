import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MediaDeleteDialog } from './MediaDeleteDialog';

it('confirms intent immediately without statistics or a global modal backdrop', () => {
  const html = renderToStaticMarkup(
    <MediaDeleteDialog onClose={() => undefined} onConfirm={() => undefined} />,
  );
  expect(html).toContain('media-delete-layer');
  expect(html).toContain('class="danger"');
  expect(html).not.toContain('disabled');
  expect(html).not.toContain('正在核对');
  expect(html).toContain('已喜欢的录像会保留。');
  expect(html).toContain('包含其他页');
  expect(html).toContain('取消</button>');
  expect(html).not.toContain('实际影响边界');
});
