import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@st-vault/api-schema';
import { AuthGate, AuthCompletion, PinFields } from './AuthGate';
import { setLanguage } from '../../shared/lib/i18n';
import { ApiError } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';

const noop = (): void => undefined;
const render = (session: SessionInfo): string =>
  renderToStaticMarkup(<AuthGate session={session} onDone={noop} />);

it('explains origin validation failures instead of a generic retry', () => {
  expect(messageFor(new ApiError('origin_rejected', 403))).toContain('访问来源校验失败');
});

it('keeps PIN confirmation unavailable until the first six digits are complete', () => {
  const html = renderToStaticMarkup(
    <PinFields creating pin="01234" confirm="" disabled={false} onPin={noop} onConfirm={noop} />,
  );
  const confirmation = /<input[^>]*name="confirm-pin"[^>]*>/.exec(html)?.[0];
  expect(confirmation).toContain('disabled=""');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await setLanguage('zh-CN');
});

it('keeps committed authentication separate from PIN submission while the session is being read', () => {
  const html = renderToStaticMarkup(<AuthCompletion busy error="" onRetry={noop} />);
  expect(html).toContain('正在进入工作台');
  expect(html).toContain('is-busy');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('<button');
});
it('offers only a read retry after setup was saved but session confirmation failed', () => {
  const html = renderToStaticMarkup(
    <AuthCompletion
      busy={false}
      error="PIN 已保存，但暂时无法读取登录状态。请重试进入。"
      onRetry={noop}
    />,
  );
  expect(html).toContain('PIN 已保存');
  expect(html).toContain('重试进入');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('type="button"');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('type="submit"');
});

it('starts fresh setup with a restricted initialization step before exposing a PIN form', () => {
  const html = render({ authenticated: false, setupRequired: true });
  expect(html).toContain('正在准备初始化');
  expect(html).not.toContain('name="pin"');
  expect(html).not.toContain('name="password"');
  expect(html).toContain('aria-labelledby="auth-title"');
  expect(html).toContain('class="language-icon"');
});
it('resumes authorized setup directly at PIN creation without account setup or a submit button', () => {
  const html = render({ authenticated: false, setupRequired: true, setupAuthorized: true });
  expect(html).toContain('name="pin"');
  expect(html).toContain('name="confirm-pin"');
  expect(html).not.toContain('初始化步骤');
  expect(html).not.toContain('连接账户');
  expect(html).not.toContain('type="submit"');
  expect(html).not.toContain('auth-submit');
});
it('requires the existing password for legacy migration even if an old administrator session was present', () => {
  const html = render({ authenticated: true, setupRequired: false, credential: 'password' });
  expect(html).toContain('验证原密码');
  expect(html).toContain('原管理员密码');
  expect(html).toContain('name="password"');
  expect(html).not.toContain('name="pin"');
  expect(html.match(/type="password"/g)).toHaveLength(1);
});
it('unlocks with one masked numeric PIN input and no separate password or confirmation field', () => {
  const html = render({ authenticated: false, setupRequired: false, credential: 'pin' });
  expect(html).toContain('PIN 解锁');
  expect(html).toContain('inputMode="numeric"');
  expect(html).toContain('pattern="[0-9]{6}"');
  expect(html).toContain('maxLength="6"');
  expect(html).toContain('autoComplete="current-password"');
  expect(html.match(/type="password"/g)).toHaveLength(1);
  expect(html).not.toContain('name="password"');
  expect(html).not.toContain('confirm-pin');
  expect(html.match(/class="pin-cell/g)).toHaveLength(6);
  expect(html).not.toContain('auth-submit');
});
it('creates a PIN with two accessible inputs and preserves leading zeroes', () => {
  const html = renderToStaticMarkup(
    <PinFields
      creating
      pin="012345"
      confirm="012345"
      disabled={false}
      onPin={noop}
      onConfirm={noop}
    />,
  );
  expect(html.match(/type="password"/g)).toHaveLength(2);
  expect(html.match(/value="012345"/g)).toHaveLength(2);
  expect(html).toContain('name="confirm-pin"');
  expect(html).toContain('autoComplete="new-password"');
  expect(html.match(/class="pin-cell/g)).toHaveLength(12);
  expect(html).not.toContain('>0<');
});
it('blocks transmitting both migration passwords and PINs over insecure remote HTTP', () => {
  vi.stubGlobal('window', { location: { href: 'http://public.example/' } });
  for (const credential of ['password', 'pin'] as const) {
    const html = render({ authenticated: false, setupRequired: false, credential });
    expect(html).toContain('发送登录凭据必须使用 HTTPS');
    expect(html).toContain('disabled=""');
  }
});
it('allows PIN entry on private LAN HTTP', () => {
  vi.stubGlobal('window', { location: { href: 'http://192.168.3.2:10002/' } });
  const html = render({ authenticated: false, setupRequired: false, credential: 'pin' });
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain('公网地址发送');
});
it('provides English PIN and migration feedback', async () => {
  await setLanguage('en');
  expect(render({ authenticated: false, setupRequired: false, credential: 'pin' })).toContain(
    'Unlock with PIN',
  );
  expect(render({ authenticated: false, setupRequired: false, credential: 'password' })).toContain(
    'Existing administrator password',
  );
  expect(messageFor(new ApiError('setup_expired', 401))).toContain('setup session has expired');
});
it.each([
  ['invalid_pin', 'PIN 不正确'],
  ['setup_busy', '另一客户端'],
  ['invalid_password', '原管理员密码不正确'],
] as const)('explains %s without replacing website password feedback', (code, message) => {
  expect(messageFor(new ApiError(code, 400))).toContain(message);
});
