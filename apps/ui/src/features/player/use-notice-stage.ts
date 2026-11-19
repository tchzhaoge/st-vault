import { useEffect, useRef, useState } from 'react';
import type { PlaybackNotice } from './player-status';
import { NoticeTiming, noticeMode, type NoticeState, type NoticeStage } from './notice-timing';

export function useNoticeStage(notice: PlaybackNotice | null, scope: string): NoticeStage {
  const [state, setState] = useState<NoticeState>({ key: null, stage: 'hidden' });
  const timing = useRef<NoticeTiming | null>(null);
  timing.current ??= new NoticeTiming(setState);
  const pending = notice?.kind === 'loading' || notice?.kind === 'waiting';
  useEffect(() => {
    timing.current!.update(pending ? scope : null);
  }, [pending, scope]);
  useEffect(() => () => timing.current?.dispose(), []);
  return noticeMode(notice?.kind ?? null, state.key === scope ? state.stage : 'hidden');
}
