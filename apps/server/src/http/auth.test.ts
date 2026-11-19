import { createHash, scryptSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { LocalAuth, LocalAuthError, sessionToken, setupToken } from './auth.js';

function fixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let now = 1000;
  const archive = {
    getSetting: (key: string): Promise<string | null> => Promise.resolve(values.get(key) ?? null),
    setSetting: (key: string, value: string): Promise<void> => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
  return {
    values,
    archive,
    open: () => LocalAuth.open(archive, () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function legacy() {
  const salt = 'a'.repeat(48),
    token = 'b'.repeat(64);
  return {
    token,
    values: {
      'local-auth.password': JSON.stringify({
        salt,
        hash: scryptSync('old-password', salt, 64).toString('hex'),
      }),
      'local-auth.sessions': JSON.stringify([
        { digest: createHash('sha256').update(token).digest('hex'), expiresAt: 1000000 },
      ]),
    },
  };
}
async function configured() {
  const f = fixture(),
    auth = await f.open();
  const lease = await auth.beginSetup();
  const token = await auth.completeSetup('012345', lease);
  return { ...f, auth, token };
}

it('keeps a fresh setup lease separate from administrator access and preserves leading zeroes', async () => {
  const f = fixture(),
    auth = await f.open();
  expect(auth.credential()).toBeNull();
  expect(await auth.setupRequired()).toBe(true);
  const lease = await auth.beginSetup();
  expect(auth.setupAuthorized(lease)).toBe(true);
  expect(auth.authenticated(lease)).toBe(false);
  expect(await auth.beginSetup(undefined, lease)).toBe(lease);
  const token = await auth.completeSetup('012345', lease);
  expect(auth.credential()).toBe('pin');
  expect(await auth.setupRequired()).toBe(false);
  expect(auth.setupAuthorized(lease)).toBe(false);
  expect(auth.authenticated(token)).toBe(true);
  expect(f.values.get('local-auth.pin')).not.toContain('012345');
  expect(await auth.login('123450')).toBeNull();
  const unlocked = await auth.login('012345');
  expect(auth.authenticated(unlocked ?? undefined)).toBe(true);
});

it('rejects competing setup owners and stale or missing capabilities', async () => {
  const f = fixture(),
    auth = await f.open(),
    first = await auth.beginSetup();
  await expect(auth.beginSetup()).rejects.toMatchObject({ code: 'setup_busy' });
  await expect(auth.completeSetup('123456', 'c'.repeat(64))).rejects.toMatchObject({
    code: 'setup_expired',
  });
  f.advance(20 * 60000);
  expect(auth.setupAuthorized(first)).toBe(false);
  await expect(auth.completeSetup('123456', first)).rejects.toMatchObject({
    code: 'setup_expired',
  });
  expect(await auth.beginSetup()).not.toBe(first);
});

it.each(['12345', '1234567', '12a456', '１２３４５６', '123 45', ' 123456'])(
  'rejects invalid PIN %j at the service boundary',
  async (pin) => {
    const auth = await fixture().open(),
      lease = await auth.beginSetup();
    await expect(auth.completeSetup(pin, lease)).rejects.toThrow('INVALID_PIN');
    expect(auth.setupAuthorized(lease)).toBe(true);
    expect(auth.credential()).toBeNull();
  },
);

it('requires the old password once, migrates without trusting old sessions, and clears its verifier', async () => {
  const old = legacy(),
    f = fixture(old.values),
    auth = await f.open();
  expect(auth.credential()).toBe('password');
  expect(await auth.setupRequired()).toBe(false);
  expect(auth.authenticated(old.token)).toBe(false);
  await expect(auth.beginSetup('wrong-password')).rejects.toMatchObject({
    code: 'invalid_password',
  });
  expect(await auth.login('012345')).toBeNull();
  const lease = await auth.beginSetup('old-password');
  expect(auth.setupAuthorized(lease)).toBe(true);
  const token = await auth.completeSetup('012345', lease);
  expect(auth.authenticated(token)).toBe(true);
  expect(auth.authenticated(old.token)).toBe(false);
  expect(f.values.get('local-auth.password')).toBe('');
  const reopened = await f.open();
  expect(reopened.authenticated(token)).toBe(true);
  expect(reopened.authenticated(old.token)).toBe(false);
  await expect(reopened.beginSetup('old-password')).rejects.toThrow('ALREADY_CONFIGURED');
});

it('does not revive an old session if a crash leaves both PIN and legacy records behind', async () => {
  const f = await configured(),
    old = legacy();
  f.values.set('local-auth.password', old.values['local-auth.password']);
  f.values.set('local-auth.sessions', old.values['local-auth.sessions']);
  const reopened = await f.open();
  expect(reopened.credential()).toBe('pin');
  expect(reopened.authenticated(old.token)).toBe(false);
  expect(f.values.get('local-auth.password')).toBe('');
  expect(await reopened.login('012345')).not.toBeNull();
});

it('persists escalating PIN lockout across restarts and resets it only after successful verification', async () => {
  const f = await configured();
  let auth = f.auth;
  for (const wait of [60000, 300000, 900000, 900000]) {
    for (let n = 0; n < 4; n++) expect(await auth.login('999999')).toBeNull();
    await expect(auth.login('999999')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: wait / 1000,
    });
    auth = await f.open();
    await expect(auth.login('012345')).rejects.toBeInstanceOf(LocalAuthError);
    f.advance(wait);
  }
  expect(await auth.login('012345')).not.toBeNull();
  for (let n = 0; n < 4; n++) expect(await auth.login('999999')).toBeNull();
  await expect(auth.login('999999')).rejects.toMatchObject({ retryAfterSeconds: 60 });
});

it('applies the same persisted throttle to legacy verification and serializes parallel guesses', async () => {
  const f = fixture(legacy().values),
    auth = await f.open();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => auth.beginSetup('wrong-password')),
  );
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(
    results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof LocalAuthError &&
        result.reason.code === 'rate_limited',
    ),
  ).toHaveLength(4);
  const reopened = await f.open();
  await expect(reopened.beginSetup('old-password')).rejects.toMatchObject({ code: 'rate_limited' });
  f.advance(60000);
  expect(await reopened.beginSetup('old-password')).toMatch(/^[a-f0-9]{64}$/);
});

it('drops temporary setup authorization on restart and on logout', async () => {
  const f = fixture(),
    auth = await f.open(),
    lease = await auth.beginSetup();
  expect((await f.open()).setupAuthorized(lease)).toBe(false);
  await auth.logout(lease);
  expect(auth.setupAuthorized(lease)).toBe(false);
  const next = await auth.beginSetup();
  expect(next).not.toBe(lease);
});

it('rotates and expires administrator sessions while leaving other valid clients signed in', async () => {
  const f = await configured(),
    second = await f.auth.login('012345');
  await f.auth.logout(f.token);
  expect(f.auth.authenticated(f.token)).toBe(false);
  expect(f.auth.authenticated(second ?? undefined)).toBe(true);
  f.advance(7 * 86400000);
  expect(f.auth.authenticated(second ?? undefined)).toBe(false);
});

it('parses setup and administrator cookies independently and applies equal cookie protections', async () => {
  const auth = await fixture().open(),
    token = 'e'.repeat(64),
    other = 'f'.repeat(64);
  expect(sessionToken(`stv_setup=${other}; stv_next=${token}`)).toBe(token);
  expect(setupToken(`stv_setup=${other}; stv_next=${token}`)).toBe(other);
  expect(setupToken('stv_setup=malformed')).toBeUndefined();
  expect(auth.setupCookie(other, true)).toContain(
    'HttpOnly; SameSite=Strict; Max-Age=1200; Secure',
  );
  expect(auth.clearSetupCookie(true)).toContain('Max-Age=0; Secure');
  expect(auth.cookie(token)).toContain('HttpOnly; SameSite=Strict');
});

it.each([
  ['local-auth.pin', '{"salt":"bad","hash":"bad"}'],
  ['local-auth.lockout', '{"failures":-1,"level":0,"blockedUntil":0}'],
  ['local-auth.sessions', '{}'],
])('fails closed for corrupt persisted %s', async (key, value) => {
  await expect(fixture({ [key]: value }).open()).rejects.toThrow();
});
