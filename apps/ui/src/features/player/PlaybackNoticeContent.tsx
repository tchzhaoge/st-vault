import type { PlaybackNotice } from './player-status';
import { Icon, type IconName } from '../../design/Icon';

export function PlaybackNoticeContent({
  notice,
  onRetry,
  retryLabel,
  emptyIcon = 'stop',
  brief = false,
}: {
  notice: PlaybackNotice;
  onRetry?: () => void;
  retryLabel?: string;
  emptyIcon?: IconName;
  brief?: boolean;
}): JSX.Element {
  return (
    <div className="playback-status-content">
      <span
        className={`playback-status-symbol${notice.kind === 'loading' || notice.kind === 'waiting' ? ' spinner' : ''}`}
        aria-hidden="true"
      >
        {notice.kind === 'error' ? (
          <Icon name="alert-circle" />
        ) : notice.kind === 'ended' ? (
          <Icon name={emptyIcon} />
        ) : notice.kind === 'action' ? (
          <Icon name={notice.action === 'import-keys' ? 'key' : 'play'} />
        ) : (
          ''
        )}
      </span>
      <strong>{notice.title}</strong>
      {!brief && <p>{notice.detail}</p>}
      {!brief && notice.retry && onRetry && (
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
