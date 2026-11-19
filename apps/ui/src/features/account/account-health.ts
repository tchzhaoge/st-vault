import type { AccountSyncStatus } from '@st-vault/api-schema';
import { ApiError } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';

export function canDisconnectAccount(account: AccountSyncStatus | null): boolean {
  return !!account && (account.connected || account.error === 'account_library_changed');
}

/** Connection configuration is not proof that the latest list synchronization succeeded. */
export function accountSyncIssue(account: AccountSyncStatus | null, readError = ''): string | null {
  if (readError) return tr('无法读取关注清单同步状态，正在重试。');
  if (account?.error) return messageFor(new ApiError(account.error, 400));
  if (account?.needsReconnect) return tr('需要更新 Cookies');
  return null;
}
