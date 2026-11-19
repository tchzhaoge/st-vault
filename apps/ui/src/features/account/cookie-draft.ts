import type { AccountSyncConfig } from '@st-vault/api-schema';

const key = 'stv-account-cookie-draft';
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A single site-bound draft, local to this browser and ST-Vault origin. */
export function readCookieDraft(storage: DraftStorage): AccountSyncConfig | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const draft: unknown = JSON.parse(raw);
  if (
    !draft ||
    typeof draft !== 'object' ||
    !('cookiesText' in draft) ||
    typeof draft.cookiesText !== 'string' ||
    draft.cookiesText.length > 65536 ||
    !('origin' in draft) ||
    typeof draft.origin !== 'string' ||
    new URL(draft.origin).origin !== draft.origin ||
    !draft.origin.startsWith('https://')
  )
    throw new Error('Invalid cookie draft');
  return { cookiesText: draft.cookiesText, origin: draft.origin };
}

export function writeCookieDraft(storage: DraftStorage, cookiesText: string, origin: string): void {
  if (!cookiesText.trim()) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify({ cookiesText, origin }));
}
