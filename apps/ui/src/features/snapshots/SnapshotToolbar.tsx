import { Icon } from '../../design/Icon';
import { tr } from '../../shared/lib/i18n';
import { OverflowText } from '../../shared/ui/OverflowText';
import { ProgressRing } from '../../shared/ui/ProgressRing';

export interface SnapshotToolbarProps {
  total: number;
  pageIndex: number;
  pages: number;
  live: boolean;
  connected: boolean;
  busy: boolean;
  status?: string;
  onPrevious: () => void;
  onNext: () => void;
  onUnlike: () => void;
  onDelete: () => void;
}

export function SnapshotToolbar(props: SnapshotToolbarProps): JSX.Element {
  const paginated = !props.live && props.pages > 1 && props.pageIndex >= 0;
  return (
    <nav className="snapshot-pages" aria-label={tr('截图工具')} aria-busy={props.busy}>
      <span
        className="snapshot-total"
        style={{ minWidth: `max(36px, ${String(props.total).length + 3}ch)` }}
        title={tr('{{v0}} 张', { v0: props.total })}
      >
        {tr('{{v0}} 张', { v0: props.total, context: 'compact' })}
      </span>
      {paginated && (
        <button
          className="snapshot-page-button is-previous"
          aria-label={tr('上一页')}
          disabled={props.pageIndex === 0}
          onClick={props.onPrevious}
        >
          <Icon name="chevron-left" />
        </button>
      )}
      {paginated && (
        <output
          aria-label={tr('截图页码')}
          style={{ minWidth: `${2 * String(props.pages).length + 3}ch` }}
        >
          {props.pageIndex + 1} / {props.pages}
        </output>
      )}
      {paginated && (
        <button
          className="snapshot-page-button is-next"
          aria-label={tr('下一页')}
          disabled={props.pageIndex === props.pages - 1}
          onClick={props.onNext}
        >
          <Icon name="chevron-left" />
        </button>
      )}
      <div className="snapshot-actions">
        {(
          [
            ['取消所有喜欢', 'heart-off', props.onUnlike],
            ['删除所有非喜欢', 'trash', props.onDelete],
          ] as const
        ).map(([label, icon, onClick]) => (
          <button
            key={label}
            aria-label={tr(label)}
            disabled={props.busy || !props.connected || !props.total}
            onClick={onClick}
          >
            <Icon name={icon} />
            <span>{tr(label, { context: 'compact' })}</span>
          </button>
        ))}
      </div>
      {(props.busy || props.status) && (
        <span
          className="snapshot-operation-status"
          role="status"
          aria-label={props.busy && !props.status ? tr('处理中…') : undefined}
        >
          {props.busy && <ProgressRing />}
          {props.status && <OverflowText text={props.status} tooltip={false} />}
        </span>
      )}
    </nav>
  );
}
