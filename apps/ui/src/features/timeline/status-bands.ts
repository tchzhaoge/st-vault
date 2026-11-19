import type { PublicStatus, StatusHistoryBucket } from '@st-vault/api-schema';
export interface StatusBand extends StatusHistoryBucket {
  status: PublicStatus;
}
export function statusBands(buckets: StatusHistoryBucket[]): StatusBand[] {
  const bands: StatusBand[] = [];
  for (const bucket of buckets) {
    const status = (Object.keys(bucket.durationsMs) as PublicStatus[]).reduce(
      (best, item) => (bucket.durationsMs[item] > bucket.durationsMs[best] ? item : best),
      'UNKNOWN',
    );
    const previous = bands[bands.length - 1];
    if (previous?.status === status && previous.toMs === bucket.fromMs) {
      previous.toMs = bucket.toMs;
      for (const item of Object.keys(previous.durationsMs) as PublicStatus[])
        previous.durationsMs[item] += bucket.durationsMs[item];
    } else bands.push({ ...bucket, status, durationsMs: { ...bucket.durationsMs } });
  }
  return bands;
}
