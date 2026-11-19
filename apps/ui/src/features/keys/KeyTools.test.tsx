import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { KeyTools } from './KeyTools';

it('provides one single-line field to add the next key', () => {
  const html = renderToStaticMarkup(
    <KeyTools onChanged={() => undefined} onBusyChange={() => undefined} />,
  );
  expect(html).toContain('type="text"');
  expect(html).toContain('密钥名:密钥值');
  expect(html).toContain('添加密钥');
  expect(html).not.toContain('textarea');
  expect(html).not.toContain('立即更新');
});
