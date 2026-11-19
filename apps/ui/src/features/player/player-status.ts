import type { LiveProgress } from '@st-vault/api-schema';
import { ApiError } from '../../shared/lib/api';
import { tr } from '../../shared/lib/i18n';

export type MediaPhase =
  'engine' | 'manifest' | 'decoding' | 'buffering' | 'network' | 'decoder' | 'ended' | 'blocked';
export interface PlaybackNotice {
  kind: 'loading' | 'waiting' | 'ended' | 'error' | 'action';
  title: string;
  detail: string;
  retry?: boolean;
  action?: 'import-keys' | 'choose-cdn';
}
export function liveNotice(progress: LiveProgress): PlaybackNotice | null {
  const loading = (title: string, detail: string): PlaybackNotice => ({
    kind: 'loading',
    title,
    detail,
  });
  switch (progress.phase) {
    case 'queued':
      return loading(tr('等待直播通道'), tr('正在等待服务器分配拉流通道。'));
    case 'checking':
      return loading(tr('确认公开直播状态'), tr('服务器正在匿名查询主播当前状态。'));
    case 'resolving':
      return loading(tr('获取直播源'), tr('服务器正在解析直播地址并选择可用画质。'));
    case 'buffering':
      return loading(tr('接收首批直播画面'), tr('直播源已就绪，服务器正在获取首个可播放分片。'));
    case 'reconnecting':
      return {
        kind: 'waiting',
        title: tr('直播源正在重连'),
        detail: tr('服务器正在重新获取直播分片，已有画面将继续播放。'),
      };
    case 'ended':
      return {
        kind: 'ended',
        title: tr('本场直播已结束'),
        detail: tr('直播源已发送结束标记，可选择时间线中的录像回放。'),
      };
    case 'stopped': {
      if (progress.reason === 'keys')
        return {
          kind: 'action',
          title: tr('需要导入直播密钥'),
          detail: tr('服务器没有匹配此直播的密钥。请粘贴导入后，再重新连接直播。'),
          action: 'import-keys',
          retry: true,
        };
      if (progress.reason === 'offline')
        return {
          kind: 'ended',
          title: tr('主播已下播'),
          detail: tr('已确认主播离线，当前直播连接已结束。'),
        };
      if (progress.reason === 'private')
        return {
          kind: 'ended',
          title: tr('主播已转入非公开直播'),
          detail: tr('私密或群组直播不提供公开画面，当前连接已结束。'),
        };
      if (progress.reason === 'status-unknown')
        return {
          kind: 'error',
          title: tr('无法确认公开直播状态'),
          detail: tr('状态接口未返回有效公开状态，为避免继续获取非公开画面，连接已停止。'),
          retry: true,
        };
      return {
        kind: 'error',
        title: tr('直播源连接已中断'),
        detail:
          progress.reason === 'timeout'
            ? tr('服务器持续未收到新分片。当前 CDN 可能不可达，可更换节点后重试。')
            : tr('服务器未能继续获取直播分片。可更换 CDN 节点后重试。'),
        action: 'choose-cdn',
        retry: true,
      };
    }
    case 'ready':
      return null;
  }
}
export function requestNotice(error: unknown, live: boolean): PlaybackNotice {
  if (live && error instanceof ApiError && error.message === 'live_unavailable' && error.reason)
    return error.reason === 'timeout' ||
      error.reason === 'status-unknown' ||
      error.reason === 'keys'
      ? liveNotice({ phase: 'stopped', reason: error.reason })!
      : {
          kind: 'error',
          title: tr('未能获取可播放直播源'),
          detail: tr(
            '服务器未能解析播放清单或下载首个分片。当前 CDN 可能不可用，可换一个节点重试。',
          ),
          action: 'choose-cdn',
          retry: true,
        };
  if (error instanceof ApiError && error.message === 'live_not_public')
    return liveNotice({
      phase: 'stopped',
      reason:
        error.reason === 'private' || error.reason === 'offline' ? error.reason : 'status-unknown',
    })!;
  if (error instanceof ApiError && error.message === 'coverage_gap')
    return {
      kind: 'ended',
      title: tr('所选范围内没有录像'),
      detail: tr('请在时间线有画面覆盖的位置重新选取。'),
    };
  if (error instanceof ApiError && error.message === 'live_busy')
    return {
      kind: 'error',
      title: tr('直播通道暂时已满'),
      detail: tr('服务器当前播放任务已达到上限，请关闭其他播放后重试。'),
      retry: true,
    };
  return {
    kind: 'error',
    title: live ? tr('直播会话未能建立') : tr('录像会话未能建立'),
    detail:
      error instanceof TypeError
        ? tr('浏览器未能连接本机服务，请检查网络和服务运行状态。')
        : tr('服务器未能完成播放请求，请重新连接；详细原因请查看服务日志。'),
    retry: true,
  };
}
export function mediaNotice(phase: MediaPhase, live: boolean): PlaybackNotice {
  const labels: Record<MediaPhase, [string, string]> = {
    blocked: [tr('等待点击播放'), tr('浏览器阻止了自动播放，请点击播放。')],
    engine: [tr('初始化播放器'), tr('正在加载 HLS 播放引擎。')],
    manifest: [tr('读取播放清单'), tr('浏览器正在读取本地播放清单及媒体分片。')],
    decoding: [tr('解码首帧'), tr('已收到媒体信息，正在准备可显示的视频帧。')],
    buffering: [
      tr('等待后续画面'),
      live ? tr('播放缓冲暂时耗尽，正在等待新的直播分片。') : tr('正在读取所选录像的后续分片。'),
    ],
    network: [tr('重新连接播放通道'), tr('浏览器正在重试播放清单或媒体分片请求。')],
    decoder: [tr('恢复视频解码器'), tr('正在重新初始化解码器并恢复画面。')],
    ended: live
      ? [tr('直播播放已结束'), tr('播放清单已结束，可重新连接确认最新直播状态。')]
      : [tr('当前录像已播完'), tr('此范围内没有后续可播放画面，可重新选取时间范围。')],
  };
  const [title, detail] = labels[phase];
  return {
    kind:
      phase === 'blocked'
        ? 'action'
        : phase === 'ended'
          ? 'ended'
          : phase === 'buffering' || phase === 'network' || phase === 'decoder'
            ? 'waiting'
            : 'loading',
    title,
    detail,
    retry: phase === 'ended' && live,
  };
}
