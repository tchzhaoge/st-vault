import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Subject } from '@st-vault/api-schema';
import type * as React from 'react';
import { TrackBoard } from './TrackBoard';

// Layout effects require a browser; these tests verify the scroll ownership and row origin.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useLayoutEffect: () => undefined,
}));
const noop = (): void => undefined;
const subjects: Subject[] = Array.from({ length: 40 }, (_, index) => ({
  id: `stripchat:${index}`,
  providerId: index,
  handle: `subject${index}`,
  monitorEnabled: true,
  autoRecord: true,
  captureState: 'CAPTURING',
  providerStatus: 'PUBLIC',
  observedAtMs: null,
}));
function render(selectedId: string | null = subjects[0].id): string {
  return renderToStaticMarkup(
    <TrackBoard
      subjects={subjects}
      selectedId={selectedId}
      fromMs={1000}
      toMs={2000}
      selection={{ fromMs: 1200, toMs: 1600 }}
      timelineStartMs={0}
      nowMs={2000}
      controls={<div>filters</div>}
      onChoose={noop}
      onRangeChoose={() => Promise.resolve(null)}
      onAnchor={noop}
      onViewChange={noop}
      onMove={noop}
      onRecordingChange={() => Promise.resolve()}
    />,
  );
}

it('keeps the header outside the native row scroller so its scrollbar begins below the header', () => {
  const html = render(),
    scroller = html.slice(html.indexOf('class="track-table-scroll"'));
  expect(html.indexOf('class="arrangement-controls"')).toBeLessThan(
    html.indexOf('class="track-table-scroll"'),
  );
  expect(scroller).not.toContain('class="arrangement-controls"');
  expect(scroller).toContain('class="track-row selected"');
});
it('shows the selected subject range without a fixed-selection flag and hides it on disconnect', () => {
  expect(render()).toContain('data-selected-subject="stripchat:0"');
  const empty = render(null);
  expect(empty).toContain('data-selected-subject=""');
  expect(empty).toMatch(/aria-label="取画面选区"[^>]*aria-hidden="true"/);
});

it('positions selection and grid at the row viewport origin while preserving shared virtual rows', () => {
  const html = render(subjects[2].id);
  expect(html).toMatch(/class="timeline-grid"[^>]*style="top:0"/);
  expect(html).toMatch(/class="range-selection"[^>]*style="top:232px;height:116px/);
  expect(html.match(/class="track-row(?: selected)?"/g)).toHaveLength(12);
});

it('places a recording icon over each preview and colors the cell instead of the name', () => {
  const html = render();
  expect(html).toContain('track-label status-cell-public');
  expect(html.match(/recording-toggle record-button is-recording/g)).toHaveLength(12);
  expect(html).toContain('class="subject-name"');
  expect(html).not.toContain('subject-name status-');
});
