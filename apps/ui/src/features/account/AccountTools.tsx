import { tr } from '../../shared/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AccountDisconnectResult,
  type AccountSyncResult,
  type AccountSyncStatus,
} from '@st-vault/api-schema';
import { request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { useSyncRefresh, syncReadFailure, type SyncReadResult } from '../../shared/lib/sync';
import { ToolPopover } from '../../shared/ui/ToolPopover';
import { Icon } from '../../design/Icon';
import { PanelFeedback, PanelIdentity } from '../../shared/ui/PanelContent';
import { accountSyncIssue, canDisconnectAccount } from './account-health';
import { RoutingOptions } from '../network/RoutingOptions';
import { CookieImportGuide } from './CookieImportGuide';
import { DisconnectAccountDialog } from './DisconnectAccountDialog';
import { readCookieDraft, writeCookieDraft } from './cookie-draft';

export function AccountTools({
  onImported,
  open,
  onToggle,
  onClose,
}: {
  onImported: () => Promise<void>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}): JSX.Element {
  const [account, setAccount] = useState<AccountSyncStatus | null>(null),
    [error, setError] = useState('');
  const [cookies, setCookies] = useState(''),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false),
    [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const close = () => {
    setConfirmDisconnect(false);
    onClose();
  };
  useEffect(() => {
    if (!open) {
      setEditing(false);
      setConfirmDisconnect(false);
    }
  }, [open]);
  const [failedAvatar, setFailedAvatar] = useState('');
  const [statusError, setStatusError] = useState('');
  const [sourceOrigin, setSourceOrigin] = useState<string | null>(null);
  const [draftError, setDraftError] = useState('');
  useEffect(() => {
    try {
      const draft = readCookieDraft(window.localStorage);
      if (draft) {
        setCookies(draft.cookiesText);
        setSourceOrigin(draft.origin ?? null);
      }
    } catch {
      setDraftError(tr('无法读取 Cookies 草稿，请重新粘贴。'));
    }
  }, []);
  const updateDraft = useCallback((text: string, site: string) => {
    setCookies(text);
    setSourceOrigin(site);
    try {
      writeCookieDraft(window.localStorage, text, site);
      setDraftError('');
    } catch {
      setDraftError(tr('无法保存 Cookies 草稿，刷新页面后可能丢失。'));
    }
  }, []);
  const [operation, setOperation] = useState<'connect' | 'disconnect' | null>(null);
  const pending = useRef<AbortController | null>(null),
    mounted = useRef(true),
    locked = useRef(false),
    revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  const load = useCallback(async (signal: AbortSignal): Promise<SyncReadResult> => {
    const expected = revision.current;
    try {
      const value = await request<AccountSyncStatus>('/api/account-sync', {
        signal,
      });
      if (mounted.current && !signal.aborted && revision.current === expected) {
        setAccount(value);
        setStatusError('');
      }
    } catch (cause) {
      if (mounted.current && !signal.aborted && revision.current === expected)
        setStatusError(messageFor(cause));
      return syncReadFailure(cause, signal);
    }
  }, []);
  useSyncRefresh(['account'], load);
  async function perform(kind: 'connect' | 'disconnect'): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    revision.current++;
    setBusy(true);
    setOperation(kind);
    setError('');
    const controller = new AbortController();
    pending.current = controller;
    try {
      if (kind === 'disconnect') {
        const result = await request<AccountDisconnectResult>('/api/account-sync', {
          method: 'DELETE',
          signal: controller.signal,
        });
        if (mounted.current && !controller.signal.aborted) {
          setAccount(result.status);
          setStatusError('');
          revision.current++;
          if (result.draft) updateDraft(result.draft.cookiesText, result.draft.origin ?? origin);
          setEditing(false);
          void onImported().catch((cause: unknown) => {
            if (mounted.current) setError(messageFor(cause));
          });
        }
      } else {
        const result = await request<AccountSyncResult>('/api/account-sync', {
          method: 'PUT',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookiesText: cookies.trim(), origin }),
        });
        if (mounted.current && !controller.signal.aborted) {
          setAccount(result.status);
          setStatusError('');
          revision.current++;
          setEditing(false);
          void onImported().catch((cause: unknown) => {
            if (mounted.current) setError(messageFor(cause));
          });
        }
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(messageFor(cause));
    } finally {
      locked.current = false;
      if (pending.current === controller) pending.current = null;
      if (mounted.current) setBusy(false);
      if (mounted.current) setOperation(null);
    }
  }
  useEffect(() => {
    if (
      account?.connected &&
      sourceOrigin &&
      sourceOrigin !== (account.origin ?? 'https://stripchat.com')
    ) {
      updateDraft('', account.origin ?? 'https://stripchat.com');
    }
  }, [account?.connected, account?.origin, sourceOrigin, updateDraft]);
  const profile = account?.connected ? account.profile : null;
  const origin =
    (account?.connected ? account.origin : (sourceOrigin ?? account?.origin)) ??
    'https://stripchat.com';
  const issue = accountSyncIssue(account, statusError);
  const avatar = profile?.avatarUrl?.startsWith('/api/account-sync/avatar?')
    ? profile.avatarUrl
    : null;
  const face =
    avatar && failedAvatar !== avatar ? (
      <img
        src={avatar}
        alt=""
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedAvatar(avatar)}
      />
    ) : (
      <Icon name="user" />
    );
  return (
    <ToolPopover
      title={tr('账户')}
      className={`account-tool${account?.connected ? ' connected' : ''}`}
      open={open}
      onToggle={onToggle}
      onClose={close}
      alert={issue ?? undefined}
      trigger={
        <>
          <span className="account-trigger-avatar">{face}</span>
          <span className="account-trigger-info">
            <strong title={profile?.username}>
              {profile?.username ?? tr(account?.connected ? '已连接账户' : '未连接账户')}
            </strong>
            {account?.connected && (
              <span>
                {tr('关注 {{v0}} 位', {
                  v0: profile?.followingCount ?? account.lastImportedCount ?? 0,
                })}
              </span>
            )}
          </span>
        </>
      }
    >
      {(!!error || (!busy && !!issue)) && (
        <PanelFeedback kind="error">{error ? error : issue}</PanelFeedback>
      )}
      {!!draftError && <PanelFeedback kind="error">{draftError}</PanelFeedback>}
      {!account && !statusError && <PanelFeedback kind="busy">{tr('读取中')}</PanelFeedback>}
      {account && (
        <form
          className="account-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform('connect');
          }}
        >
          {account?.connected ? (
            <PanelIdentity
              icon={<Icon name="network" />}
              label={tr('登录域名')}
              value={new URL(account.origin ?? origin).hostname}
            />
          ) : (
            <RoutingOptions
              kind="sites"
              origin={origin}
              disabled={busy}
              onOriginChange={(site) => {
                if (site !== origin) updateDraft('', site);
                setError('');
              }}
            />
          )}
          {(!account?.connected || editing) && (
            <>
              <label className="field account-cookie-field">
                <span>{account.connected ? tr('更新 Cookies') : 'Cookies'}</span>
                <textarea
                  aria-label={account?.connected ? tr('更新 Cookies') : 'Cookies'}
                  rows={2}
                  maxLength={65536}
                  autoComplete="off"
                  spellCheck={false}
                  value={cookies}
                  disabled={busy}
                  onChange={(event) => {
                    // Bind an unsubmitted draft too, so another client's update cannot
                    // silently associate these credentials with a different domain.
                    updateDraft(event.target.value, origin);
                    setError('');
                  }}
                  placeholder={tr('粘贴 Cookie 请求头、Netscape 文本或 JSON')}
                />
              </label>
              <CookieImportGuide origin={origin} />
            </>
          )}
          {busy && (
            <PanelFeedback kind="busy">
              {operation === 'disconnect'
                ? tr('正在断开账户…')
                : account?.stage === 'syncing'
                  ? tr('Cookies 已验证，正在同步关注清单…')
                  : account?.stage === 'saving'
                    ? tr('正在保存账户与关注清单…')
                    : tr('正在验证 Cookies…')}
            </PanelFeedback>
          )}
          <div className="panel-actions">
            {canDisconnectAccount(account) && !editing && (
              <button
                type="button"
                className="text-button panel-danger"
                disabled={busy}
                onClick={() => setConfirmDisconnect(true)}
              >
                {tr('断开')}
              </button>
            )}
            {account?.connected && (
              <button
                type="button"
                className={editing ? 'text-button' : 'secondary'}
                disabled={busy}
                aria-expanded={editing}
                onClick={() => setEditing(!editing)}
              >
                {editing ? tr('取消') : tr('更换 Cookies')}
              </button>
            )}
            {(!account?.connected || editing) && (
              <button className="primary" disabled={busy || !cookies.trim()}>
                {busy ? tr('处理中…') : account?.connected ? tr('更新并同步') : tr('连接并同步')}
              </button>
            )}
          </div>
        </form>
      )}
      {open && confirmDisconnect && (
        <DisconnectAccountDialog
          onClose={() => setConfirmDisconnect(false)}
          onConfirm={() => {
            setConfirmDisconnect(false);
            void perform('disconnect');
          }}
        />
      )}
    </ToolPopover>
  );
}
