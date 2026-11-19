import type { PlaybackNotice } from './player-status';

export type NoticeStage = 'hidden' | 'brief' | 'detail';
export interface NoticeState {
  key: string | null;
  stage: NoticeStage;
}

/** Presentation timing only; media requests and errors never wait for these timers. */
export class NoticeTiming {
  private key: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly changed: (state: NoticeState) => void) {}
  update(key: string | null): void {
    if (key === this.key) return;
    this.dispose();
    this.key = key;
    this.changed({ key, stage: 'hidden' });
    if (key === null) return;
    this.timer = setTimeout(() => this.changed({ key, stage: 'brief' }), 600);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.key = null;
  }
}

export function noticeMode(kind: PlaybackNotice['kind'] | null, stage: NoticeStage): NoticeStage {
  if (!kind) return 'hidden';
  if (kind !== 'loading' && kind !== 'waiting') return 'detail';
  return stage === 'hidden' ? 'hidden' : 'brief';
}
