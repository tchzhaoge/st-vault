import { afterEach, expect, it, vi } from 'vitest';
import { NoticeTiming, noticeMode, type NoticeState } from './notice-timing';

afterEach(() => vi.useRealTimers());
it('does not show a routine wait that finishes within 600ms', () => {
  vi.useFakeTimers();
  const update = vi.fn<(state: NoticeState) => void>();
  const timing = new NoticeTiming(update);
  timing.update('model');
  vi.advanceTimersByTime(599);
  timing.update(null);
  vi.advanceTimersByTime(5000);
  expect(update.mock.calls.every(([value]) => value.stage === 'hidden')).toBe(true);
});
it('keeps one wait clock across phases and never expands during a long wait', () => {
  vi.useFakeTimers();
  const update = vi.fn<(state: NoticeState) => void>();
  const timing = new NoticeTiming(update);
  timing.update('model');
  vi.advanceTimersByTime(400);
  timing.update('model');
  vi.advanceTimersByTime(200);
  expect(update).toHaveBeenLastCalledWith({ key: 'model', stage: 'brief' });
  vi.advanceTimersByTime(60000);
  expect(update).toHaveBeenLastCalledWith({ key: 'model', stage: 'brief' });
  timing.dispose();
});
it('cancels stale work when switching subjects or unmounting', () => {
  vi.useFakeTimers();
  const update = vi.fn<(state: NoticeState) => void>();
  const timing = new NoticeTiming(update);
  timing.update('old');
  vi.advanceTimersByTime(500);
  timing.update('new');
  vi.advanceTimersByTime(599);
  expect(update).toHaveBeenLastCalledWith({ key: 'new', stage: 'hidden' });
  vi.advanceTimersByTime(1);
  expect(update).toHaveBeenLastCalledWith({ key: 'new', stage: 'brief' });
  timing.dispose();
  const count = update.mock.calls.length;
  vi.advanceTimersByTime(5000);
  expect(update).toHaveBeenCalledTimes(count);
});
it('keeps errors and actions immediate while all routine feedback remains brief', () => {
  for (const kind of ['error', 'action', 'ended'] as const)
    expect(noticeMode(kind, 'hidden')).toBe('detail');
  expect(noticeMode('loading', 'hidden')).toBe('hidden');
  expect(noticeMode('waiting', 'brief')).toBe('brief');
  expect(noticeMode('loading', 'brief')).toBe('brief');
  expect(noticeMode('waiting', 'detail')).toBe('brief');
  expect(noticeMode(null, 'detail')).toBe('hidden');
});
