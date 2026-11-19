import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RuntimeSettingsForm } from './RuntimeSettingsForm';
it('keeps immediate controls outside the numeric settings form and saves only that group', () => {
  const html = renderToStaticMarkup(
    <RuntimeSettingsForm
      settings={{ pollMs: 5000, retentionDays: 7, minFreeBytes: 2147483648 }}
      onSaved={() => Promise.resolve()}
      recording={
        <button type="button" data-immediate="recording">
          Record
        </button>
      }
    />,
  );
  const start = html.indexOf('<form'),
    end = html.indexOf('</form>');
  const form = html.slice(start, end);
  expect(html).not.toContain('显示停机时段');
  expect(form.match(/type="number"/g)).toHaveLength(3);
  expect(form).toContain('保存运行设置');
  expect(form).not.toContain('data-immediate');
  expect(form).not.toContain('language-toggle');
  expect(html.indexOf('data-immediate="recording"')).toBeLessThan(start);
  expect(html).not.toContain('data-immediate="routes"');
  expect(html).not.toContain('网站接入点');
});
