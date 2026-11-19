import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PlaybackNoticeContent } from './PlaybackNoticeContent';
import { SnapshotNotice } from '../snapshots/SnapshotNotice';

it.each(['error', 'ended', 'action'] as const)(
  'uses the shared SVG assets for %s notices',
  (kind) => {
    const html = renderToStaticMarkup(
      <PlaybackNoticeContent notice={{ kind, title: 'Notice', detail: 'Explanation' }} />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('>!<');
    expect(html).not.toContain('>—<');
  },
);
it('uses a media placeholder for empty snapshots and keeps loading feedback animated', () => {
  const render = (kind: 'ended' | 'loading') =>
    renderToStaticMarkup(
      <SnapshotNotice
        notice={{ kind, title: 'Notice', detail: 'Explanation' }}
        compact={false}
        onRetry={() => undefined}
      />,
    );
  expect(render('ended')).toContain('<svg');
  expect(render('loading')).toBe('');
  expect(
    renderToStaticMarkup(
      <PlaybackNoticeContent
        notice={{ kind: 'loading', title: 'Notice', detail: 'Explanation' }}
      />,
    ),
  ).toContain('spinner');
});
