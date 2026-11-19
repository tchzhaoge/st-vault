import { tr } from './i18n';
import { ApiError, MutationOutcomeUnknown } from './api';

export function messageFor(error: unknown): string {
  if (error instanceof MutationOutcomeUnknown) return error.message;
  if (error instanceof ApiError) {
    const known: Record<string, string> = {
      already_configured: tr('PIN 已经设置，请刷新页面后解锁。'),
      invalid_password: tr('原管理员密码不正确，请检查后重试。'),
      invalid_pin: tr('PIN 不正确，请检查后重试。'),
      setup_busy: tr('另一客户端正在初始化，请完成该流程或等待会话到期后重试。'),
      setup_expired: tr('初始化会话已过期，请重新验证后继续。'),
      rate_limited: tr('尝试次数过多，请稍后再试。'),
      unauthorized: tr('登录已失效，请重新登录后继续。'),
      origin_rejected: tr('访问来源校验失败，请用部署时配置的访问地址重新打开。'),
      list_import_failed: tr('导入请求未完成，可能是网络或服务暂时不可用；请稍后重试。'),
      cookies_invalid: tr(
        'Cookies 格式无法识别或没有可用条目。请只粘贴 Cookie 请求头、Netscape 文本或 Cookie-Editor JSON 数组。',
      ),
      cookies_expired: tr(
        '登录域名未识别到有效会话。请在账户面板显示的域名重新登录并更新 Cookies。',
      ),
      cookies_domain_mismatch: tr(
        'Cookies 与所选站点域名不匹配，请导入该站点的 Cookies；更换站点需先退出账户。',
      ),
      account_origin_locked: tr('账户已绑定该站点。请先退出账户，再粘贴新站点的 Cookies。'),
      subject_archived: tr('归档主播不能录制，可浏览已有录像。'),
      account_origin_invalid: tr('不支持该登录域名，请从已核实的站点中选择。'),
      account_origin_redirect: tr(
        '登录请求跳转到了其他域名，已停止发送凭据。请在所选站点登录后导出 Cookies；换站需先退出账户。',
      ),
      account_network_unavailable: tr(
        '无法连接所选站点，清单未更新；请检查网络，已连接账户会按同步时钟重试。',
      ),
      account_verification_required: tr(
        '登录域名要求站点验证。请在浏览器完成验证，再更新该域名的 Cookies。',
      ),
      account_access_denied: tr(
        '原站拒绝了清单请求，可能需要完成站点验证；重新复制 Cookies 不一定能解决。',
      ),
      account_sync_not_connected: tr('尚未连接关注清单同步，请先更新 Cookies。'),
      account_sync_disconnected: tr('尚未连接关注清单同步，请先粘贴 Cookies。'),
      account_sync_busy: tr('清单同步任务正在运行，请稍后重试。'),
      account_sync_cancelled: tr('本次同步已取消；已有清单和连接设置未受影响。'),
      account_sync_timeout: tr(
        '站点响应超时；已连接账户会按同步时钟重试，也可在账户面板手动重试。',
      ),
      account_sync_unavailable: tr('本地加密凭据暂不可用，请检查状态目录权限或重新连接。'),
      account_library_changed: tr('媒体库已更换，请断开账户后重新连接。'),
      account_sync_https_required: tr(
        '公网地址发送登录凭据必须使用 HTTPS；局域网私有 IP 和 localhost 可使用 HTTP。',
      ),
      keys_https_required: tr('请通过 HTTPS 或受信任的局域网地址管理密钥。'),
      invalid_request: tr('提交内容无效，请检查输入后重试。'),
      subject_not_found: tr('主播目录已变化，请刷新后重试。'),
      archive_unavailable: tr('归档暂不可用，请稍后重试。'),
      archive_busy: tr('归档请求较多，请稍后再试；录制会继续运行。'),
      coverage_changed: tr('所选录像已变化或被删除，请刷新时间轴后重试。'),
      media_selection_stale: tr('画面或喜欢标记已变化，请重新确认后操作。'),
      media_deletion_pending: tr('删除任务已保存，后台恢复后会继续处理，请勿重复提交。'),
      media_deletion_queue_full: tr('删除任务队列已满，请等待已有任务完成。'),
      playback_not_found: tr('播放会话已过期，请重新定位片段。'),
      too_many_playbacks: tr('同时打开的播放会话过多，请关闭一个播放器后重试。'),
      internal_error: tr('服务暂时遇到问题，请稍后重试。'),
    };
    return known[error.message] ?? tr('请求未完成，请稍后重试。');
  }
  return error instanceof Error ? error.message : tr('发生未知错误');
}
