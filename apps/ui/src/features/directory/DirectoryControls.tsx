import type { ReactNode } from 'react';
import type { SubjectFilter } from './subjects';
import { tr } from '../../shared/lib/i18n';

export function DirectoryControls({
  account,
  statusFilter,
  setStatusFilter,
  counts,
}: {
  account: ReactNode;
  statusFilter: string;
  setStatusFilter: (value: SubjectFilter) => void;
  counts: Record<SubjectFilter, number>;
}): JSX.Element {
  const filters: { id: SubjectFilter; label: string }[] = [
    { id: 'ONLINE', label: tr('在线') },
    { id: 'OFFLINE', label: tr('离线') },
    { id: 'ARCHIVED', label: tr('归档') },
  ];
  return (
    <aside className="directory">
      {account}
      <div className="subject-filters" role="group" aria-label={tr('主播状态筛选')}>
        <span
          className="glass-selection"
          aria-hidden="true"
          style={{
            transform: `translateX(${
              Math.max(
                0,
                filters.findIndex((item) => item.id === statusFilter),
              ) * 100
            }%)`,
          }}
        />
        {filters.map((item) => (
          <button
            key={item.id}
            className={statusFilter === item.id ? 'active' : ''}
            aria-pressed={statusFilter === item.id}
            aria-label={item.label}
            title={
              item.id === 'ARCHIVED'
                ? tr(
                    '归档包含已取关、断开账户或不在当前完整关注清单中的本地主播。已有录像仍可浏览，不再录制；临时网络或状态异常不会直接归档。',
                  )
                : item.label
            }
            onClick={() => setStatusFilter(item.id)}
          >
            <span className="filter-label">
              {item.id === 'ARCHIVED' ? tr('归档', { context: 'compact' }) : item.label}
            </span>
            {counts[item.id] > 0 && <span className="filter-count">{counts[item.id]}</span>}
          </button>
        ))}
      </div>
    </aside>
  );
}
