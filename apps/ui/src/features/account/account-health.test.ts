import { expect, it } from 'vitest';
import type { AccountSyncStatus } from '@st-vault/api-schema';
import { accountSyncIssue, canDisconnectAccount } from './account-health';
const connected: AccountSyncStatus = {
  connected: true,
  running: false,
  needsReconnect: false,
  lastAttemptMs: 1,
  lastSuccessMs: 1,
  nextAttemptMs: 2,
  lastImportedCount: 1,
  error: null,
  origin: 'https://stripchat.com',
};
it('does not alarm when disconnected intentionally or after a successful refresh', () => {
  expect(accountSyncIssue(null)).toBeNull();
  expect(accountSyncIssue({ ...connected, connected: false })).toBeNull();
  expect(accountSyncIssue(connected)).toBeNull();
});
it('does not confuse saved credentials with successful synchronization', () => {
  expect(
    accountSyncIssue({ ...connected, error: 'cookies_domain_mismatch', needsReconnect: true }),
  ).toContain('域名');
  expect(accountSyncIssue({ ...connected, error: 'account_access_denied' })).toContain('拒绝');
  expect(accountSyncIssue({ ...connected, needsReconnect: true })).toBe('需要更新 Cookies');
  expect(accountSyncIssue(connected, 'offline')).toContain('无法读取');
});
it('exposes recovery of an unfinished activation tied to a different media library', () => {
  const account = { ...connected, connected: false, error: 'account_library_changed' };
  expect(accountSyncIssue(account)).toContain('媒体库已更换');
  expect(canDisconnectAccount(account)).toBe(true);
  expect(canDisconnectAccount({ ...connected, connected: false })).toBe(false);
});
