import type { CoverageResponse, StatusHistoryResponse } from '@st-vault/api-schema';
import { statusBands, type StatusBand } from './status-bands';

export interface TrackData {
  coverage: CoverageResponse;
  bands: StatusBand[];
}
export interface WorkbenchResponse {
  rows: {
    subjectId: string;
    coverage: CoverageResponse;
    status: StatusHistoryResponse;
  }[];
}
/** Both timeline scales consume the same bounded read model. */
export function trackData(row: WorkbenchResponse['rows'][number]): TrackData {
  return {
    coverage: row.coverage,
    bands: statusBands(row.status.buckets),
  };
}
