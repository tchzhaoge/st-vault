import { tr } from '../../shared/lib/i18n';
import type { PlaybackNotice } from '../player/player-status';
import { PlaybackNoticeContent } from '../player/PlaybackNoticeContent';
import { useNoticeStage } from '../player/use-notice-stage';

export function SnapshotNotice({
  notice,
  compact,
  onRetry,
  scope = 'snapshots',
}: {
  notice: PlaybackNotice;
  compact: boolean;
  onRetry: () => void;
  scope?: string;
}): JSX.Element {
  const stage = useNoticeStage(notice, scope);
  if (stage === 'hidden') return <></>;
  return (
    <div
      className={`snapshot-status${compact ? ' snapshot-status--compact' : ''}${stage === 'brief' ? ' playback-status--brief' : ''}`}
      data-kind={notice.kind}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <PlaybackNoticeContent
        notice={notice}
        onRetry={onRetry}
        retryLabel={tr('重新读取')}
        emptyIcon="image"
        brief={stage === 'brief'}
      />
    </div>
  );
}
