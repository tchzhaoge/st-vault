import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@st-vault/api-schema';
import { allowsCredentialUrl } from '@st-vault/api-schema';
import { tr } from '../../shared/lib/i18n';
import { ApiError, request } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { LanguageSwitch } from '../../shared/ui/LanguageSwitch';
import { BrandName } from '../../shared/ui/BrandName';
import { PanelFeedback } from '../../shared/ui/PanelContent';
import { ProgressRing } from '../../shared/ui/ProgressRing';

function PinInput({
  label,
  name,
  value,
  disabled,
  creating,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  disabled: boolean;
  creating: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <div className={`pin-boxes${disabled ? ' is-disabled' : ''}`}>
        <input
          className="pin-input"
          aria-label={label}
          type="password"
          name={name}
          inputMode="numeric"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          required
          autoFocus={name === 'pin'}
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        {Array.from({ length: 6 }, (_, index) => (
          <span
            className={`pin-cell${index < value.length ? ' is-filled' : ''}${index === value.length ? ' is-current' : ''}`}
            aria-hidden="true"
            key={index}
          >
            {index < value.length ? '•' : ''}
          </span>
        ))}
      </div>
    </label>
  );
}

export function PinFields({
  creating,
  pin,
  confirm,
  disabled,
  onPin,
  onConfirm,
}: {
  creating: boolean;
  pin: string;
  confirm: string;
  disabled: boolean;
  onPin: (value: string) => void;
  onConfirm: (value: string) => void;
}): JSX.Element {
  return (
    <div className="auth-fields">
      <PinInput
        label={creating ? tr('设置 6 位 PIN') : tr('6 位 PIN')}
        name="pin"
        value={pin}
        disabled={disabled}
        creating={creating}
        onChange={onPin}
      />
      {creating && (
        <PinInput
          label={tr('确认 PIN')}
          name="confirm-pin"
          value={confirm}
          disabled={disabled || pin.length !== 6}
          creating
          onChange={onConfirm}
        />
      )}
    </div>
  );
}

export function AuthCompletion({
  busy,
  error,
  onRetry,
}: {
  busy: boolean;
  error: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="auth-form">
      <PanelFeedback kind={error ? 'error' : 'busy'}>
        {error || tr('正在进入工作台…')}
      </PanelFeedback>
      {!!error && (
        <button type="button" className="primary auth-submit" disabled={busy} onClick={onRetry}>
          {tr('重试进入')}
        </button>
      )}
    </div>
  );
}

export function AuthGate({
  session,
  onDone,
}: {
  session: SessionInfo;
  onDone: (session: SessionInfo) => void;
}): JSX.Element {
  const [localSession, setLocalSession] = useState(session),
    [password, setPassword] = useState(''),
    [pin, setPin] = useState(''),
    [confirm, setConfirm] = useState(''),
    [committed, setCommitted] = useState<'setup' | 'login' | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true),
    locked = useRef(false),
    attempted = useRef(false);
  const initializing = localSession.setupRequired || localSession.credential === 'password';
  const migration = localSession.credential === 'password';
  const authorized = localSession.setupAuthorized === true;
  const insecure = typeof window !== 'undefined' && !allowsCredentialUrl(window.location.href);
  const transportError = insecure
    ? tr('公网地址发送登录凭据必须使用 HTTPS；局域网私有 IP 和 localhost 可使用 HTTP。')
    : '';
  useEffect(() => {
    if (busy) return;
    if (error) form.current?.querySelector<HTMLInputElement>('[name="pin"]')?.focus();
    else if (initializing && pin.length === 6)
      form.current?.querySelector<HTMLInputElement>('[name="confirm-pin"]')?.focus();
  }, [busy, error, initializing, pin]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function begin(legacyPassword?: string): Promise<void> {
    if (locked.current || insecure) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setPassword('');
    try {
      // Keep the eventual cookie response: aborting lease creation can leave its owner unknown.
      await request('/api/setup/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(legacyPassword === undefined ? {} : { password: legacyPassword }),
      });
      const next = await request<SessionInfo>('/api/session');
      if (mounted.current) setLocalSession(next);
    } catch (cause) {
      if (mounted.current) setError(messageFor(cause));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!localSession.setupRequired || authorized || attempted.current || insecure || committed)
      return;
    // A ref survives StrictMode's effect replay, so only one lease request is issued.
    attempted.current = true;
    void begin();
  }, [localSession.setupRequired, authorized, insecure, committed]);

  async function readCompletedSession(kind: 'setup' | 'login'): Promise<void> {
    try {
      const next = await request<SessionInfo>('/api/session');
      if (!mounted.current) return;
      if (next.authenticated) onDone(next);
      else {
        setLocalSession(next);
        setCommitted(null);
        attempted.current = false;
        setError(tr('登录会话已失效，请重新输入 PIN 解锁。'));
      }
    } catch {
      if (mounted.current)
        setError(
          kind === 'setup'
            ? tr('PIN 已保存，但暂时无法读取登录状态。请重试进入。')
            : tr('PIN 已验证，但暂时无法读取登录状态。请重试进入。'),
        );
    }
  }
  async function retryEntry(): Promise<void> {
    if (locked.current || !committed) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      // Completion is already durable. Retrying must never submit the PIN or setup again.
      await readCompletedSession(committed);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function expired(): void {
    setLocalSession((value) => ({ ...value, setupAuthorized: false }));
    setPin('');
    setConfirm('');
    setError(tr('初始化会话已过期，请重新验证后继续。'));
  }
  async function submitPin(value: string, confirmation = confirm): Promise<void> {
    if (locked.current || insecure || committed) return;
    if (!/^\d{6}$/.test(value)) {
      setError(tr('请输入 6 位数字 PIN。'));
      return;
    }
    if (initializing && value !== confirmation) {
      setPin('');
      setConfirm('');
      setError(tr('两次输入的 PIN 不一致。'));
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await request(initializing ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: value }),
      });
      if (mounted.current) {
        setPin('');
        setConfirm('');
        const kind = initializing ? 'setup' : 'login';
        setCommitted(kind);
        await readCompletedSession(kind);
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (
        initializing &&
        cause instanceof ApiError &&
        ['setup_expired', 'unauthorized'].includes(cause.message)
      )
        expired();
      else {
        setPin('');
        setConfirm('');
        setError(messageFor(cause));
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const title =
    committed === 'setup'
      ? tr('初始化完成')
      : !initializing
        ? tr('PIN 解锁')
        : !authorized && migration
          ? tr('验证原密码')
          : tr('初始化 ST-Vault');
  return (
    <main className="auth-wrap">
      <section
        className={`auth-card${initializing ? ' setup-card' : ''}${error && !committed ? ' is-pin-error' : ''}`}
        aria-labelledby="auth-title"
        aria-busy={busy}
      >
        <LanguageSwitch compact />
        <header className="auth-heading">
          <div className="auth-brand">
            <img src="/assets/st-vault-mark.png" alt="" />
            <BrandName />
          </div>
          <h1 id="auth-title">{title}</h1>
        </header>
        {!committed && (transportError || error) && (
          <PanelFeedback kind="error">{transportError || error}</PanelFeedback>
        )}
        {committed ? (
          <AuthCompletion busy={busy} error={error} onRetry={() => void retryEntry()} />
        ) : initializing && !authorized ? (
          migration ? (
            <form
              className="auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (password) void begin(password);
              }}
            >
              <p className="auth-description">
                {tr('验证后改用 6 位 PIN，现有账户和录像保持不变。')}
              </p>
              <label className="field">
                <span>{tr('原管理员密码')}</span>
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  maxLength={256}
                  value={password}
                  disabled={busy || insecure}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError('');
                  }}
                />
              </label>
              <button className="primary auth-submit" disabled={busy || insecure || !password}>
                {busy && <ProgressRing />}
                {busy ? tr('正在验证…') : tr('验证并继续')}
              </button>
            </form>
          ) : (
            <div className="auth-form">
              {!error && !insecure && (
                <PanelFeedback kind="busy">{tr('正在准备初始化…')}</PanelFeedback>
              )}
              {!!error && (
                <button
                  className="primary auth-submit"
                  disabled={busy || insecure}
                  onClick={() => void begin()}
                >
                  {busy && <ProgressRing />}
                  {tr('重试')}
                </button>
              )}
            </div>
          )
        ) : (
          <form
            ref={form}
            className="auth-form"
            noValidate
            onSubmit={(event) => event.preventDefault()}
          >
            {initializing && (
              <p className="auth-description">{tr('PIN 用于解锁本机的 ST-Vault。')}</p>
            )}
            <PinFields
              creating={initializing}
              pin={pin}
              confirm={confirm}
              disabled={busy || insecure}
              onPin={(value) => {
                setPin(value);
                setConfirm('');
                setError('');
                if (!initializing && value.length === 6) void submitPin(value);
              }}
              onConfirm={(value) => {
                setConfirm(value);
                setError('');
                if (value.length === 6) void submitPin(pin, value);
              }}
            />
            {busy && (
              <PanelFeedback kind="busy">
                {initializing ? tr('正在完成初始化…') : tr('正在解锁…')}
              </PanelFeedback>
            )}
          </form>
        )}
      </section>
    </main>
  );
}
