import { tr } from '../../shared/lib/i18n';
import type { ViewWindow } from '../timeline/range-control';
import { clockLabel, dayLabel } from '../../shared/lib/date-label';
import { durationLabel } from '../../shared/lib/duration';
export function SelectionSummary({ range }: { range: ViewWindow | null }): JSX.Element {
  if (!range) return <div className="selection-summary" aria-hidden="true" />;
  const duration = durationLabel(range.toMs - range.fromMs);
  return (
    <div className="selection-summary" aria-label={tr('所选时间范围')}>
      <time dateTime={new Date(range.fromMs).toISOString()}>
        <span className="selection-date">{dayLabel(range.fromMs)}</span>
        <strong>{clockLabel(range.fromMs)}</strong>
      </time>
      <span className="selection-bridge">
        <output aria-label={tr('所选跨度')} title={duration}>
          {duration}
        </output>
        <span className="selection-bridge-line" aria-hidden="true" />
      </span>
      <time dateTime={new Date(range.toMs).toISOString()}>
        <span className="selection-date">{dayLabel(range.toMs)}</span>
        <strong>{clockLabel(range.toMs)}</strong>
      </time>
    </div>
  );
}
