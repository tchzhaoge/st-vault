import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Subject } from '@st-vault/api-schema';
import { PlayerHeading } from './PlayerHeading';

it('links only the avatar and keeps current/former names as text', () => {
  const subject: Subject = {
    id: 'stripchat:42',
    providerId: 42,
    handle: 'Current',
    formerNames: ['Before'],
    monitorEnabled: true,
    autoRecord: false,
    providerStatus: 'PUBLIC',
    observedAtMs: 1000,
  };
  const html = renderToStaticMarkup(
    <PlayerHeading subject={subject} siteOrigin="https://stripchatcam.com" />,
  );
  expect(html).toContain('subject-avatar');
  expect(html).toContain('Current');
  expect(html).toContain('Before');
  expect(html).toContain('href="https://stripchatcam.com/Current"');
  expect(html).toMatch(/<a class="player-avatar-link"[^>]+>[\s\S]*subject-avatar[\s\S]*<\/a>/);
  expect(html).toContain('<h2 title="Current">Current</h2>');
  expect(html).not.toMatch(/<h2[^>]*>\s*<a/);
  expect(html).not.toContain('selection-summary');
});
it('leaves the idle heading empty', () => {
  const html = renderToStaticMarkup(<PlayerHeading subject={null} />);
  expect(html).toBe('');
});
