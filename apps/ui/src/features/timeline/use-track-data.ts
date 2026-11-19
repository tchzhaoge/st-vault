import { useEffect, useReducer, useRef } from 'react';
import { request } from '../../shared/lib/api';
import { trackData, type WorkbenchResponse } from './track-data';
import { TrackLoader, type TrackPlan } from './track-loader';
import { protectionSubjects } from '../../shared/lib/deletion-projection';

export function readWorkbench(
  ids: string[],
  fromMs: number,
  toMs: number,
  buckets: number,
  signal: AbortSignal,
): Promise<WorkbenchResponse> {
  const protection = protectionSubjects(ids);
  const query = `ids=${encodeURIComponent(ids.join(','))}&from=${fromMs}&to=${toMs}&buckets=${buckets}`;
  return request<WorkbenchResponse>(
    `/api/workbench?${query}${protection.length ? `&protection=${encodeURIComponent(protection.join(','))}` : ''}`,
    { signal },
  );
}
export function useTrackData(plan: TrackPlan): TrackLoader {
  const [, changed] = useReducer((value: number) => value + 1, 0),
    loader = useRef<TrackLoader | null>(null);
  loader.current ??= new TrackLoader(async (ids, current, signal) => {
    const packet = await readWorkbench(ids, current.fromMs, current.toMs, current.buckets, signal);
    return packet.rows.map((row) => ({
      subjectId: row.subjectId,
      data: trackData(row),
    }));
  }, changed);
  const latest = useRef(plan);
  latest.current = plan;
  const ids = plan.ids.join('|'),
    visible = plan.visible.join('|'),
    prefetch = plan.prefetch.join('|');
  useEffect(() => {
    loader.current!.update(latest.current);
  }, [ids, visible, prefetch, plan.fromMs, plan.toMs, plan.buckets, plan.revision]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) loader.current?.close();
      });
    };
  }, []);
  return loader.current;
}
