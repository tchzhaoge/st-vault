import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ArchiveHealth } from './ArchiveHealth';
import { systemHealthStatus } from './display';

it('distinguishes healthy, checking and failed service status and shows the cause', () => {
  expect(
    renderToStaticMarkup(<ArchiveHealth health={systemHealthStatus({ lowSpace: false })} />),
  ).toContain('archive-health is-ok');
  expect(renderToStaticMarkup(<ArchiveHealth health={null} />)).toContain('is-checking');
  const html = renderToStaticMarkup(
    <ArchiveHealth health={systemHealthStatus({ lowSpace: false, diskError: 'disk_read_only' })} />,
  );
  expect(html).toContain('is-error');
  expect(html).toContain('数据目录只读');
});
it('presents availability as a quiet labeled status instead of a prominent normal banner', () => {
  const html = renderToStaticMarkup(
    <ArchiveHealth health={systemHealthStatus({ lowSpace: false })} />,
  );
  expect(html).toContain('归档服务');
  expect(html).toContain('可用');
  expect(html).toContain('panel-status-row');
  expect(html).not.toContain('归档服务正常');
  expect(html).not.toContain('<strong');
});
