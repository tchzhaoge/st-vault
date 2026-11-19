import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type * as React from 'react';
import { ToolPopover } from './ToolPopover';
vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }));
afterEach(() => vi.unstubAllGlobals());
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useLayoutEffect: () => undefined,
}));
it('shows an accessible issue indicator independently of unread counts', () => {
  const html = renderToStaticMarkup(
    <ToolPopover
      title="状态"
      open={false}
      onToggle={() => undefined}
      onClose={() => undefined}
      trigger="Status"
      alert="Cookies require renewal"
    >
      Ready
    </ToolPopover>,
  );
  expect(html).toContain('class="tool-alert"');
  expect(html).toContain('aria-label="Cookies require renewal"');
  expect(html).not.toContain('unread-badge');
});
it('clears the issue indicator after recovery', () => {
  const html = renderToStaticMarkup(
    <ToolPopover
      title="状态"
      open={false}
      onToggle={() => undefined}
      onClose={() => undefined}
      trigger="Status"
    >
      Ready
    </ToolPopover>,
  );
  expect(html).not.toContain('tool-alert');
});
it('opens a single glass surface without detached split decorations', () => {
  vi.stubGlobal('document', { body: {} });
  const html = renderToStaticMarkup(
    <ToolPopover
      title="账户"
      open
      onToggle={() => undefined}
      onClose={() => undefined}
      trigger="Account"
    >
      Content
    </ToolPopover>,
  );
  expect(html.match(/class="toolbar-popover"/g)).toHaveLength(1);
  expect(html).not.toContain('liquid-bridge');
});
