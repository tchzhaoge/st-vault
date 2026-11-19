import { expect, it } from 'vitest';
import { ApiError } from '../../shared/lib/api';
import { liveNotice, mediaNotice, requestNotice } from './player-status';

it('offers key import when the server reports a missing live key', () => {
  const notice = requestNotice(new ApiError('live_unavailable', 503, 'keys'), true);
  expect(notice).toMatchObject({ action: 'import-keys', retry: true, title: '需要导入直播密钥' });
  expect(liveNotice({ phase: 'stopped', reason: 'keys' })).toEqual(notice);
});

it('distinguishes real server stages from browser decode stages', () => {
  expect(liveNotice({ phase: 'checking' })?.title).toBe('确认公开直播状态');
  expect(liveNotice({ phase: 'buffering' })?.title).toBe('接收首批直播画面');
  expect(mediaNotice('decoding', true).title).toBe('解码首帧');
  expect(liveNotice({ phase: 'ready' })).toBeNull();
});
it('offers a CDN change for live upstream failures only', () => {
  for (const reason of ['timeout', 'source', 'network'] as const) {
    expect(liveNotice({ phase: 'stopped', reason })).toMatchObject({
      action: 'choose-cdn',
      retry: true,
    });
    expect(requestNotice(new ApiError('live_unavailable', 503, reason), true).action).toBe(
      'choose-cdn',
    );
  }
  expect(mediaNotice('network', true).action).toBeUndefined();
  expect(requestNotice(new ApiError('coverage_gap', 404), false).action).toBeUndefined();
});
it('does not turn an unknown status into an offline assertion', () => {
  expect(liveNotice({ phase: 'stopped', reason: 'status-unknown' })?.title).toBe(
    '无法确认公开直播状态',
  );
  expect(requestNotice(new ApiError('live_not_public', 409, 'offline'), true).title).toBe(
    '主播已下播',
  );
  expect(requestNotice(new ApiError('live_not_public', 409, 'private'), true).title).toBe(
    '主播已转入非公开直播',
  );
});
it('separates normal end, recovery, missing archive and failed request', () => {
  expect(liveNotice({ phase: 'ended' })?.kind).toBe('ended');
  expect(liveNotice({ phase: 'reconnecting', reason: 'network' })?.detail).toContain(
    '重新获取直播分片',
  );
  expect(mediaNotice('network', true).kind).toBe('waiting');
  expect(mediaNotice('blocked', true).kind).toBe('action');
  expect(mediaNotice('ended', true).title).toBe('直播播放已结束');
  expect(mediaNotice('ended', false).title).toBe('当前录像已播完');
  expect(requestNotice(new ApiError('coverage_gap', 404), false).retry).toBeUndefined();
  expect(requestNotice(new TypeError('fetch failed'), true).detail).toContain('本机服务');
});
