import type {
  ArchiveHealthStatus,
  SiteRoutesStatus,
  SnapshotJobsStatus,
  BackgroundTask,
} from '@st-vault/api-schema';
export interface SystemInfo {
  recordAll?: boolean;
  disk: {
    freeBytes: number;
    totalBytes: number;
    lowSpace: boolean;
    error?: string | null;
  };
  capture: { pollMs: number; active: number; starting?: number; retrying?: number };
  capturedAtMs?: number;
  backgroundTasks?: BackgroundTask[];
  ingress?: { subjects: number; retainedBytes: number; maxBytes: number } | null;
  version: string;
  maintenanceError?: string | null;
  snapshotJobs?: SnapshotJobsStatus | null;
  archiveHealth?: ArchiveHealthStatus | null;
  siteRoutes?: SiteRoutesStatus | null;
  settings?: {
    pollMs: number;
    retentionDays: number;
    minFreeBytes: number;
  };
}
export type RuntimeSettings = NonNullable<SystemInfo['settings']>;
