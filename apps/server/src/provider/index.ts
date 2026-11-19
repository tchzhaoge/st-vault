import type { PublicStatus } from '@st-vault/api-schema';
import type { ProviderPort, SubjectInput } from '../ports.js';
import { aborted, createHttp, ProviderError } from './http.js';
import { parseAccountCookies } from './account.js';
import { accountAvatarSource, accountProfile } from './account-profile.js';
import type { ImportedAccount } from './account-profile.js';
import { broadcastCover } from './cover-source.js';
import { accountSiteOrigin, SiteRoutes } from './site-routes.js';
import { broadcastResponse } from './public-api.js';

export interface ProviderOptions {
  onCoverObserved?: (subjectId: string, source: string | null) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  origin?: string;
  accountOrigin?: string;
  publicOrigins?: readonly string[];
  sites?: SiteRoutes;
  requestTimeoutMs?: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('invalid-upstream-json');
  return value as Record<string, unknown>;
}
function parseJson(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text) as unknown);
  } catch {
    throw new ProviderError('invalid-upstream-json');
  }
}
function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function createProvider(options: ProviderOptions = {}): Pick<
  ProviderPort,
  'status' | 'importList'
> & {
  sites: SiteRoutes;
  importAccount(
    cookiesText: string,
    signal?: AbortSignal,
    onValidated?: () => void,
    sourceOrigin?: string,
  ): Promise<ImportedAccount>;
} {
  const origin = new URL(options.accountOrigin ?? options.origin ?? 'https://stripchat.com').origin;
  const sites =
    options.sites ??
    new SiteRoutes({
      origins: options.publicOrigins ?? (options.origin ? [options.origin] : undefined),
      fetch: options.fetch,
      now: options.now,
      timeoutMs: options.requestTimeoutMs,
    });
  const now = options.now ?? Date.now;
  const status = async (providerId: number, signal?: AbortSignal): Promise<PublicStatus> => {
    if (!validId(providerId)) throw new ProviderError('invalid-provider-id');
    const item = await sites.read(
      `/api/front/v2/broadcasts/${providerId}`,
      (text) => broadcastResponse(text, providerId),
      signal,
    );
    options.onCoverObserved?.(`stripchat:${providerId}`, broadcastCover(providerId, item));
    const kind = String(item.status).toLowerCase();
    if (
      (item.isLive === false && kind === 'public') ||
      (item.isLive === true && ['off', 'idle'].includes(kind))
    )
      return 'UNKNOWN';
    // Missing/unsupported fields are not evidence of a stopped broadcast.
    if (item.isLive === false && (kind === 'off' || kind === 'idle')) return 'OFFLINE';
    if (item.isLive === true && kind === 'public') return 'PUBLIC';
    if (
      item.isLive === true &&
      [
        'p2p',
        'p2pvoice',
        'p2paudio',
        'private',
        'virtualprivate',
        'groupshow',
        'group_show',
      ].includes(kind)
    )
      return 'PRIVATE';
    return 'UNKNOWN';
  };
  const importAccount = async (
    cookiesText: string,
    signal?: AbortSignal,
    onValidated?: () => void,
    sourceOrigin?: string,
  ): Promise<ImportedAccount> => {
    // Credentials stay on the selected account origin and never follow cross-origin redirects.
    const source = sourceOrigin ? accountSiteOrigin(sourceOrigin) : origin;
    const accountHttp = createHttp({
      fetch: options.fetch,
      timeoutMs: options.requestTimeoutMs,
      allow: (url) => url.origin === source,
      account: true,
    });
    const cookie = parseAccountCookies(cookiesText, new URL(source).hostname, now());
    const observe = sites.beginAccess(source);
    let initial: Record<string, unknown>;
    try {
      initial = parseJson(
        await accountHttp.text(
          `${source}/api/front/v3/config/initial-dynamic?requestPath=/`,
          signal,
          cookie,
        ),
      );
      observe();
    } catch (error) {
      observe(error);
      throw error;
    }
    const dynamic = object(initial.initialDynamic),
      user = dynamic.user;
    if (
      !user ||
      typeof user !== 'object' ||
      !('username' in user) ||
      typeof user.username !== 'string' ||
      !user.username.trim()
    )
      throw new ProviderError('account-session-unavailable');
    const token = dynamic.jwtToken;
    if (typeof token !== 'string' || !token || token.length > 65536 || /[\r\n\0]/.test(token))
      throw new ProviderError('account-session-unavailable');
    onValidated?.();
    const subjects = new Map<number, SubjectInput>();
    for (const route of ['favorites', 'favorites/offline']) {
      for (let offset = 0; offset <= 10000; offset += 100) {
        aborted(signal);
        const url = `${source}/api/front/models/${route}?limit=100&offset=${offset}&stv_refresh=${now()}`;
        const body = parseJson(await accountHttp.text(url, signal, cookie, token));
        if (
          !Array.isArray(body.models) ||
          !Number.isSafeInteger(body.totalCount) ||
          Number(body.totalCount) < 0 ||
          Number(body.totalCount) > 10100
        )
          throw new ProviderError('invalid-account-list');
        for (const value of body.models) {
          const row = object(value);
          if (
            !validId(row.id) ||
            typeof row.username !== 'string' ||
            !row.username.trim() ||
            row.username.length > 256
          )
            throw new ProviderError('invalid-account-list');
          const preview =
            accountAvatarSource(row.previewUrlThumbSmall) ??
            accountAvatarSource(row.previewUrlThumbBig) ??
            accountAvatarSource(row.previewUrl);
          const avatar = accountAvatarSource(row.avatarUrl);
          subjects.set(row.id, {
            id: `stripchat:${row.id}`,
            providerId: row.id,
            handle: row.username,
            ...(preview ? { previewSourceUrl: preview } : {}),
            ...(avatar ? { avatarSourceUrl: avatar } : {}),
          });
        }
        if (offset + body.models.length >= Number(body.totalCount)) break;
        if (!body.models.length || offset === 10000)
          throw new ProviderError('incomplete-account-list');
      }
    }
    aborted(signal);
    const list = [...subjects.values()];
    return { subjects: list, profile: accountProfile(user, list.length) };
  };
  return {
    sites,
    status,
    importAccount,
    importList: async (cookiesText, signal): Promise<SubjectInput[]> =>
      (await importAccount(cookiesText, signal)).subjects,
  };
}
