import { tr } from '../../shared/lib/i18n';
import type { ArchiveEvent, PublicStatus } from '@st-vault/api-schema';
const TRANSITIONS: Record<PublicStatus, Partial<Record<PublicStatus, string>>> = {
  OFFLINE: {
    PUBLIC: '上线并开始公开直播',
    PRIVATE: '上线并进入私密直播',
  },
  PUBLIC: {
    OFFLINE: '结束公开直播并下线',
    PRIVATE: '由公开直播转为私密直播',
  },
  PRIVATE: {
    OFFLINE: '结束私密直播并下线',
    PUBLIC: '结束私密直播，恢复公开直播',
  },
  UNKNOWN: {},
};
export function eventPresentation(event: ArchiveEvent): {
  name: string;
  text: string;
  color: string;
} {
  if (event.kind === 'status_changed')
    return {
      name: event.handle,
      text: tr(TRANSITIONS[event.fromStatus][event.toStatus] ?? '状态更新'),
      color: event.toStatus.toLowerCase(),
    };
  return {
    name: tr('录制程序'),
    text:
      event.kind === 'run_started'
        ? tr('正常启动')
        : event.kind === 'run_stopped'
          ? tr('正常关闭')
          : event.uncertainUntilMs === null
            ? tr('异常关闭')
            : tr('检测到上次运行异常关闭'),
    color: 'program',
  };
}
