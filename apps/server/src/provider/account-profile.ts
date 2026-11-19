import type { SubjectInput } from '../ports.js';
import { ProviderError } from './http.js';
import { coverSource } from './cover-source.js';

export interface ImportedAccountProfile {
  username: string;
  followingCount: number;
  avatarSourceUrl: string | null;
}
export interface ImportedAccount {
  subjects: SubjectInput[];
  profile: ImportedAccountProfile;
}
export function accountAvatarSource(value: unknown): string | null {
  return coverSource(value);
}
export function accountProfile(value: unknown, subjectCount: number): ImportedAccountProfile {
  if (
    !value ||
    typeof value !== 'object' ||
    !('username' in value) ||
    typeof value.username !== 'string' ||
    !value.username.trim() ||
    value.username.length > 256 ||
    /[\x00-\x1f\x7f]/.test(value.username)
  )
    throw new ProviderError('account-session-unavailable');
  const following = 'followingCount' in value ? value.followingCount : null;
  return {
    username: value.username.trim(),
    followingCount:
      typeof following === 'number' &&
      Number.isSafeInteger(following) &&
      following >= 0 &&
      following <= 10000000
        ? following
        : subjectCount,
    avatarSourceUrl: accountAvatarSource('avatarUrl' in value ? value.avatarUrl : null),
  };
}
