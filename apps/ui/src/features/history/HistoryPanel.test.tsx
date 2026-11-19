import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { HistorySubject } from './HistoryPanel';

it('makes the avatar and name one native button which invokes ID navigation once', () => {
  const reveal = vi.fn();
  const element = HistorySubject({
    id: 'stripchat:42',
    name: 'Current · Before',
    revision: 0,
    onReveal: reveal,
  }) as ReactElement<{ onClick: () => void }>;
  expect(element.type).toBe('button');
  element.props.onClick();
  expect(reveal).toHaveBeenCalledTimes(1);
  const html = renderToStaticMarkup(element);
  expect(html).toContain('subject-avatar');
  expect(html).toContain('Current · Before');
  expect(html).toContain('type="button"');
});

it('keeps removed subjects readable without exposing a dead navigation action', () => {
  const html = renderToStaticMarkup(
    <HistorySubject id="stripchat:42" name="Old event" revision={0} />,
  );
  expect(html).toContain('Old event');
  expect(html).not.toContain('<button');
});
