import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { setLanguage } from '../lib/i18n';
import { LanguageSwitch } from './LanguageSwitch';
afterEach(async () => {
  await setLanguage('zh-CN');
});
it('renders one corner icon without a language row or dropdown', () => {
  const html = renderToStaticMarkup(<LanguageSwitch compact />);
  expect(html).toContain('class="language-icon"');
  expect(html).toContain('type="button"');
  expect(html).not.toContain('language-setting');
  expect(html).not.toContain('<select');
});
it('shows both languages in a direct two-position switch with the current state', async () => {
  expect(renderToStaticMarkup(<LanguageSwitch />)).toContain('aria-checked="false"');
  await setLanguage('en');
  const html = renderToStaticMarkup(<LanguageSwitch />);
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('中文');
  expect(html).toContain('English');
  expect(html).not.toContain('<select');
});
