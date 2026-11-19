import type { ReactNode } from 'react';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AccountTools } from './AccountTools';

const state = vi.hoisted(() => ({ reads: 0, connected: false }));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useState: (initial: unknown) => [
    state.reads++ === 0
      ? {
          connected: state.connected,
          running: state.connected,
          error: state.connected ? null : 'account_library_changed',
          needsReconnect: true,
        }
      : initial,
    vi.fn(),
  ],
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock('../../shared/lib/sync', () => ({ useSyncRefresh: () => undefined }));
vi.mock('../../shared/ui/ToolPopover', () => ({
  ToolPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

it('offers disconnect to recover an unfinished activation even without an active account', () => {
  state.reads = 0;
  const html = renderToStaticMarkup(
    <AccountTools
      onImported={() => Promise.resolve()}
      open
      onToggle={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(html).toContain('媒体库已更换');
  expect(html).toContain('>断开</button>');
});

it('keeps account actions available during a background sync and hides the cookie editor', () => {
  state.reads = 0;
  state.connected = true;
  const html = renderToStaticMarkup(
    <AccountTools
      onImported={() => Promise.resolve()}
      open
      onToggle={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(html).toContain('更换 Cookies');
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>(?:断开|更换 Cookies)/);
  expect(html).not.toContain('同步清单');
  expect(html).not.toContain('textarea');
  expect(html).not.toContain('account-profile');
  expect(html).not.toContain('account-avatar');
  state.connected = false;
});
