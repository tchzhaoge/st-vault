import { ApiError } from '../../shared/lib/api';
import { tr } from '../../shared/lib/i18n';
import type { PlaybackNotice } from '../player/player-status';
import type { MediaTimeRange } from '@st-vault/api-schema';
import { clockLabel, dayLabel, dayKey } from '../../shared/lib/date-label';

export function snapshotFailure(error: unknown): PlaybackNotice {
  const notice = (
    title: string,
    detail: string,
    retry = true,
    kind: PlaybackNotice['kind'] = 'error',
  ): PlaybackNotice => ({ title: tr(title), detail: tr(detail), retry, kind });
  if (error instanceof ApiError) {
    if ([408, 504].includes(error.status))
      return notice('截图读取超时', '本机服务未在规定时间内返回截图索引，将按同步周期重试。');
    if (error.status === 401)
      return notice('登录已失效', '请重新登录 ST-Vault 后读取截图。', false);
    if (error.status === 403)
      return notice('截图访问被拒绝', '本机服务拒绝了请求，请检查访问地址与权限。', false);
    if (error.status === 400)
      return notice('截图时间范围无效', '请在时间线上重新选择有效的时间范围。', false);
    if (error.message === 'archive_unavailable')
      return notice('录像存储暂不可用', '数据盘或录像索引尚未就绪，请检查 NAS 挂载与运行状态。');
    if (error.message === 'preview_unavailable')
      return notice('截图索引服务未就绪', '服务器当前无法提供截图索引，请检查运行日志。');
    if (error.status === 404)
      return notice('截图索引不存在', '主播目录或录像可能已变化，请重新读取。');
    if (error.status === 429)
      return notice('截图服务正在忙', '索引查询任务已满，将按同步周期重试。', true, 'waiting');
    if (error.status === 409) return notice('截图读取已中断', '服务器已取消本次读取，可重新读取。');
    return notice('截图索引读取失败', '本机服务未能完成截图查询，可重试并检查运行日志。');
  }
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    return notice('截图读取超时', '本机服务未在规定时间内返回截图索引，将按同步周期重试。');
  if (error instanceof TypeError)
    return notice('无法连接截图服务', '浏览器未能连接本机服务，请检查 NAS 和网络连接。');
  return notice('截图索引读取失败', '本机服务未能完成截图查询，可重试并检查运行日志。');
}

export function snapshotEmptyNotice(
  state: 'idle' | 'loading' | 'recording' | 'page-empty' | 'empty',
  context?: { subjectName: string; window: MediaTimeRange; following: boolean; offline: boolean },
): PlaybackNotice {
  switch (state) {
    case 'idle':
      return {
        kind: 'ended',
        title: tr('选择主播查看截图'),
        detail: tr('选中主播后，这里会按分钟显示对应时间范围的画面。'),
      };
    case 'loading':
      return {
        kind: 'loading',
        title: tr('正在读取截图…'),
        detail: tr('正在查询所选时间范围的截图索引与录像位置。'),
      };
    case 'recording':
      return {
        kind: 'waiting',
        title: tr('等待首段录像'),
        detail: tr('录制正在启动或落盘，首段录像可用后会自动更新截图。'),
      };
    case 'page-empty':
      return {
        kind: 'ended',
        title: tr('当前显示区间暂无截图'),
        detail: tr('当前截图页没有可用画面，可浏览其他时间位置。'),
      };
    case 'empty':
      if (context) {
        const { fromMs, toMs } = context.window;
        const start = `${dayLabel(fromMs)} ${clockLabel(fromMs).slice(0, 5)}`;
        const end = `${dayKey(fromMs) === dayKey(toMs) ? '' : `${dayLabel(toMs)} `}${clockLabel(toMs).slice(0, 5)}`;
        const span = `${start} — ${end}`;
        return {
          kind: 'ended',
          title: context.following ? tr('最近这段时间暂无截图') : tr('所选时间范围暂无截图'),
          detail: context.offline
            ? tr('{{v0}} 当前离线；{{v1}} 内没有找到录像。可拖选有画面的时间段回看。', {
                v0: context.subjectName,
                v1: span,
              })
            : tr('{{v0}}，{{v1}} 内没有找到录像。可拖选其他时间段，有新录像时这里会自动更新。', {
                v0: context.subjectName,
                v1: span,
              }),
        };
      }
      return {
        kind: 'ended',
        title: tr('所选时间范围暂无截图'),
        detail: tr('该时间范围没有可用录像，可在时间线上拖选其他时间段。'),
      };
  }
}
