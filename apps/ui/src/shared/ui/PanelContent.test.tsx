import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PanelFeedback, PanelSection } from './PanelContent';

it('gives grouped settings one consistent section heading level', () => {
  const html = renderToStaticMarkup(
    <PanelSection title="Group">
      <label>
        Field
        <input />
      </label>
    </PanelSection>,
  );
  expect(html).toContain('<h3>Group</h3>');
  expect(html).not.toContain('<h2');
});

it.each(['info', 'busy', 'success', 'error'] as const)(
  'announces %s feedback with appropriate semantics',
  (kind) => {
    const html = renderToStaticMarkup(
      <PanelFeedback kind={kind}>Operation progress</PanelFeedback>,
    );
    expect(html).toContain(`role="${kind === 'error' ? 'alert' : 'status'}"`);
    expect(html.includes('operation-spinner')).toBe(kind === 'busy');
  },
);
