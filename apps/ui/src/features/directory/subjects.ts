import type { PublicStatus, Subject } from '@st-vault/api-schema';
const STATUS_ORDER: Record<PublicStatus, number> = {
  PUBLIC: 0,
  PRIVATE: 1,
  OFFLINE: 2,
  UNKNOWN: 3,
};
const NAME_ORDER = new Intl.Collator('zh-CN', { numeric: true });
export type SubjectFilter = 'ONLINE' | 'OFFLINE' | 'ARCHIVED';
/** Keep unchanged rows stable across heartbeat JSON decoding; every field still participates. */
export function reconcileSubjects(previous: Subject[], incoming: Subject[]): Subject[] {
  const byId = new Map(previous.map((subject) => [subject.id, subject]));
  const rows = incoming.map((subject) => {
    const old = byId.get(subject.id);
    if (!old) return subject;
    const keys = new Set([...Object.keys(old), ...Object.keys(subject)] as (keyof Subject)[]);
    const equal = [...keys].every((key) => {
      const a = old[key],
        b = subject[key];
      return (
        Object.is(a, b) ||
        (Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((value, index) => value === b[index]))
      );
    });
    return equal ? old : subject;
  });
  return rows.length === previous.length && rows.every((row, index) => row === previous[index])
    ? previous
    : rows;
}
export function displayStatus(subject: Subject): PublicStatus {
  return subject.providerStatus === 'UNKNOWN'
    ? (subject.lastKnownStatus ?? 'UNKNOWN')
    : subject.providerStatus;
}
export function normalizeSubjectFilter(filter: string): SubjectFilter {
  if (filter === 'ARCHIVED') return 'ARCHIVED';
  if (filter === 'OFFLINE') return 'OFFLINE';
  return 'ONLINE';
}
export function subjectGroup(subject: Subject): SubjectFilter {
  if (subject.archived) return 'ARCHIVED';
  const status = displayStatus(subject);
  return status === 'PUBLIC' || status === 'PRIVATE' ? 'ONLINE' : 'OFFLINE';
}
export function subjectCounts(subjects: Subject[]): Record<SubjectFilter, number> {
  const counts = { ONLINE: 0, OFFLINE: 0, ARCHIVED: 0 };
  for (const subject of subjects) counts[subjectGroup(subject)]++;
  return counts;
}
export function visibleSubjects(subjects: Subject[], filter: string): Subject[] {
  const group = normalizeSubjectFilter(filter);
  const timestamp = (value: number | null | undefined): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
  return subjects
    .filter((subject) => subjectGroup(subject) === group)
    .sort(
      (a, b) =>
        (group === 'OFFLINE'
          ? timestamp(b.lastRecordedAtMs) - timestamp(a.lastRecordedAtMs) ||
            timestamp(b.lastOnlineAtMs) - timestamp(a.lastOnlineAtMs)
          : 0) ||
        STATUS_ORDER[displayStatus(a)] - STATUS_ORDER[displayStatus(b)] ||
        NAME_ORDER.compare(a.handle, b.handle) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
