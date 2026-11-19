import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Icon, type IconName } from './Icon';
it('uses one decorative SVG contract for all control icons', () => {
  for (const name of [
    'play',
    'key',
    'settings',
    'history',
    'user',
    'close',
    'chevron-left',
    'chevron-right',
    'link-off',
    'edit',
  ] as IconName[]) {
    const html = renderToStaticMarkup(<Icon name={name} />);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain('<title');
  }
});
