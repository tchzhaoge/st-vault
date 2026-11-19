import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ArchivePort } from '../ports.js';

const ttlMs = 7 * 86400000;
const setupTtlMs = 20 * 60000;
const verifierSchema = z
  .object({
    salt: z.string().regex(/^[a-f0-9]{48}$/),
    hash: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
const sessionSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
    credentialId: z.string().regex(/^[a-f0-9]{48}$/),
  })
  .strict();
const lockoutSchema = z
  .object({
    failures: z.number().int().min(0).max(4),
    level: z.number().int().min(0).max(3),
    blockedUntil: z.number().int().nonnegative(),
  })
  .strict();
type Verifier = z.infer<typeof verifierSchema>;
type SavedSession = z.infer<typeof sessionSchema>;
type Lockout = z.infer<typeof lockoutSchema>;
type AuthStore = Pick<ArchivePort, 'getSetting' | 'setSetting'>;

const derive = (secret: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(secret, salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
  });
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const emptyLockout = (): Lockout => ({ failures: 0, level: 0, blockedUntil: 0 });
function read<T>(raw: string, schema: z.ZodType<T>, code: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(code);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(code);
  return result.data;
}
function tokenFrom(header: string | undefined, name: string): string | undefined {
  const prefix = `${name}=`;
  const part = header
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  const value = part?.slice(prefix.length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
export function sessionToken(header?: string): string | undefined {
  return tokenFrom(header, 'stv_next');
}
export function setupToken(header?: string): string | undefined {
  return tokenFrom(header, 'stv_setup');
}
export class LocalAuthError extends Error {
  constructor(
    readonly code: 'setup_busy' | 'setup_expired' | 'rate_limited' | 'invalid_password',
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'LocalAuthError';
  }
}

export class LocalAuth {
  private sessions: SavedSession[] = [];
  private pin: Verifier | undefined;
  private password: Verifier | undefined;
  private lockout = emptyLockout();
  private setupLease: { digest: string; expiresAt: number } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly archive: AuthStore,
    private readonly now: () => number,
  ) {}

  static async open(archive: AuthStore, now: () => number = Date.now): Promise<LocalAuth> {
    const auth = new LocalAuth(archive, now);
    const [pin, password, sessions, lockout] = await Promise.all([
      archive.getSetting('local-auth.pin'),
      archive.getSetting('local-auth.password'),
      archive.getSetting('local-auth.sessions'),
      archive.getSetting('local-auth.lockout'),
    ]);
    if (pin) auth.pin = read(pin, verifierSchema, 'INVALID_PIN_RECORD');
    else if (password) auth.password = read(password, verifierSchema, 'INVALID_PASSWORD_RECORD');
    if (lockout) auth.lockout = read(lockout, lockoutSchema, 'INVALID_AUTH_LOCKOUT');
    if (sessions) {
      const entries = read(sessions, z.array(z.unknown()), 'INVALID_LOCAL_SESSIONS');
      auth.sessions = entries
        .flatMap((entry) => {
          const parsed = sessionSchema.safeParse(entry);
          return parsed.success &&
            parsed.data.credentialId === auth.pin?.salt &&
            parsed.data.expiresAt > now()
            ? [parsed.data]
            : [];
        })
        .slice(-200);
    }
    // A committed PIN wins after a crash between verifier replacement and old-record cleanup.
    if (auth.pin && password) await archive.setSetting('local-auth.password', '');
    return auth;
  }

  credential(): 'pin' | 'password' | null {
    return this.pin ? 'pin' : this.password ? 'password' : null;
  }
  setupRequired(): Promise<boolean> {
    return Promise.resolve(this.credential() === null);
  }
  authenticated(token?: string): boolean {
    if (!this.pin || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const hash = digest(token);
    return this.sessions.some(
      (session) =>
        session.digest === hash &&
        session.credentialId === this.pin?.salt &&
        session.expiresAt > this.now(),
    );
  }
  setupAuthorized(token?: string): boolean {
    return (
      !this.pin &&
      !!token &&
      /^[a-f0-9]{64}$/.test(token) &&
      !!this.setupLease &&
      this.setupLease.expiresAt > this.now() &&
      this.setupLease.digest === digest(token)
    );
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    // Callers receive the rejection; only the queue tail recovers so later attempts can run.
    this.queue = result.catch(() => undefined);
    return result;
  }
  private checkThrottle(): void {
    if (this.lockout.blockedUntil > this.now())
      throw new LocalAuthError(
        'rate_limited',
        Math.ceil((this.lockout.blockedUntil - this.now()) / 1000),
      );
  }
  private async saveLockout(next: Lockout): Promise<void> {
    await this.archive.setSetting('local-auth.lockout', JSON.stringify(next));
    this.lockout = next;
  }
  private async failed(): Promise<void> {
    const failures = this.lockout.failures + 1;
    const level = failures === 5 ? Math.min(3, this.lockout.level + 1) : this.lockout.level;
    const blockedUntil = failures === 5 ? this.now() + [0, 60000, 300000, 900000][level] : 0;
    await this.saveLockout({ failures: failures === 5 ? 0 : failures, level, blockedUntil });
    this.checkThrottle();
  }
  private async matches(secret: string, verifier: Verifier): Promise<boolean> {
    const actual = await derive(secret, verifier.salt);
    return timingSafeEqual(actual, Buffer.from(verifier.hash, 'hex'));
  }
  beginSetup(password?: string, existingToken?: string): Promise<string> {
    return this.serial(async () => {
      if (this.pin) throw new Error('ALREADY_CONFIGURED');
      if (this.setupAuthorized(existingToken) && existingToken) return existingToken;
      if (this.setupLease && this.setupLease.expiresAt > this.now())
        throw new LocalAuthError('setup_busy');
      if (this.password) {
        this.checkThrottle();
        if (!password || password.length > 256 || !(await this.matches(password, this.password))) {
          await this.failed();
          throw new LocalAuthError('invalid_password');
        }
        await this.saveLockout(emptyLockout());
      }
      const token = randomBytes(32).toString('hex');
      this.setupLease = { digest: digest(token), expiresAt: this.now() + setupTtlMs };
      return token;
    });
  }
  completeSetup(pin: string, setupToken: string): Promise<string> {
    return this.serial(async () => {
      if (!/^\d{6}$/.test(pin)) throw new Error('INVALID_PIN');
      if (!this.setupAuthorized(setupToken)) throw new LocalAuthError('setup_expired');
      const salt = randomBytes(24).toString('hex');
      const verifier = { salt, hash: (await derive(pin, salt)).toString('hex') };
      if (!this.setupAuthorized(setupToken)) throw new LocalAuthError('setup_expired');
      // Session binding changes in the same durable write as the verifier. Old tokens can
      // never regain access even if the process stops before the following cleanup writes.
      await this.archive.setSetting('local-auth.pin', JSON.stringify(verifier));
      this.pin = verifier;
      this.password = undefined;
      this.setupLease = undefined;
      this.sessions = [];
      await this.archive.setSetting('local-auth.password', '');
      await this.saveLockout(emptyLockout());
      return this.issue();
    });
  }
  login(pin: string): Promise<string | null> {
    return this.serial(async () => {
      if (!/^\d{6}$/.test(pin)) throw new Error('INVALID_PIN');
      if (!this.pin) return null;
      this.checkThrottle();
      if (!(await this.matches(pin, this.pin))) {
        await this.failed();
        return null;
      }
      await this.saveLockout(emptyLockout());
      return this.issue();
    });
  }
  logout(token?: string): Promise<void> {
    return this.serial(async () => {
      if (token) {
        const hash = digest(token);
        this.sessions = this.sessions.filter((session) => session.digest !== hash);
        if (this.setupLease?.digest === hash) this.setupLease = undefined;
      }
      await this.persist();
    });
  }
  private async issue(): Promise<string> {
    if (!this.pin) throw new Error('PIN_REQUIRED');
    const token = randomBytes(32).toString('hex');
    this.sessions = this.sessions.filter((session) => session.expiresAt > this.now()).slice(-199);
    this.sessions.push({
      digest: digest(token),
      expiresAt: this.now() + ttlMs,
      credentialId: this.pin.salt,
    });
    await this.persist();
    return token;
  }
  private async persist(): Promise<void> {
    await this.archive.setSetting('local-auth.sessions', JSON.stringify(this.sessions));
  }
  cookie(token: string, secure = false): string {
    return `stv_next=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlMs / 1000}${secure ? '; Secure' : ''}`;
  }
  clearCookie(secure = false): string {
    return `stv_next=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
  setupCookie(token: string, secure = false): string {
    return `stv_setup=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${setupTtlMs / 1000}${secure ? '; Secure' : ''}`;
  }
  clearSetupCookie(secure = false): string {
    return `stv_setup=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}
