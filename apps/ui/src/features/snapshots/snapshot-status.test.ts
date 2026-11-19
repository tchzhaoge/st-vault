import { expect, it } from 'vitest';
import { ApiError } from '../../shared/lib/api';
import { snapshotFailure, snapshotEmptyNotice } from './snapshot-status';

it.each([
  [new ApiError('unauthorized', 401), '登录已失效', false],
  [new ApiError('preview_busy', 429), '截图服务正在忙', true],
  [new ApiError('archive_unavailable', 503), '录像存储暂不可用', true],
  [new ApiError('preview_unavailable', 503), '截图索引服务未就绪', true],
  [new ApiError('invalid_request', 400), '截图时间范围无效', false],
  [new ApiError('preview_not_found', 404), '截图索引不存在', true],
  [new DOMException('private detail', 'TimeoutError'), '截图读取超时', true],
  [new ApiError('gateway_timeout', 504), '截图读取超时', true],
  [new TypeError('private address'), '无法连接截图服务', true],
] as const)('maps %s into a specific safe snapshot notice', (error, title, retry) => {
  expect(snapshotFailure(error)).toMatchObject({ title, retry });
  expect(snapshotFailure(error).detail).not.toMatch(/private/);
});
it('keeps empty footage, pending first recording, and request loading distinct', () => {
  expect(snapshotEmptyNotice('empty').kind).toBe('ended');
  expect(snapshotEmptyNotice('recording').kind).toBe('waiting');
  expect(snapshotEmptyNotice('loading').kind).toBe('loading');
});
it('explains an offline empty window without claiming all historical recordings are missing', () => {
  const value = snapshotEmptyNotice('empty', {
    subjectName: 'Example',
    window: { fromMs: Date.UTC(2026, 10, 12, 2), toMs: Date.UTC(2026, 10, 12, 2, 30) },
    following: true,
    offline: true,
  });
  expect(value.title).toBe('最近这段时间暂无截图');
  expect(value.detail).toContain('Example 当前离线');
  expect(value.detail).toContain('10:00 — 10:30');
  expect(value.detail).toContain('拖选');
  expect(value.retry).toBeUndefined();
});
it('labels cross-day empty windows and preserves fixed-selection wording', () => {
  const value = snapshotEmptyNotice('empty', {
    subjectName: 'Example',
    window: { fromMs: Date.UTC(2026, 10, 11, 15, 45), toMs: Date.UTC(2026, 10, 11, 16, 15) },
    following: false,
    offline: false,
  });
  expect(value.title).toBe('所选时间范围暂无截图');
  expect(value.detail).toMatch(/23:45 — .+ 00:15/);
});
