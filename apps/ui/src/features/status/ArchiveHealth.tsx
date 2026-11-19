import { tr } from '../../shared/lib/i18n';
import type { SystemHealth } from './display';
import { PanelStatus } from '../../shared/ui/PanelContent';
import type { ReactNode } from 'react';

export function ArchiveHealth({
  health,
  activity,
}: {
  health: SystemHealth | null;
  activity?: ReactNode;
}): JSX.Element {
  const kind =
    health?.kind === 'ok' ? 'ok' : !health || health.kind === 'checking' ? 'checking' : 'error';
  const notes =
    kind === 'error' && health ? (health.messages.length ? health.messages : [health.title]) : [];
  return (
    <PanelStatus
      className={`archive-health${activity ? ' has-activity' : ''}`}
      label={tr('归档服务')}
      kind={kind}
      value={activity ?? tr(kind === 'ok' ? '可用' : kind === 'checking' ? '检查中' : '异常')}
    >
      {notes.length ? notes.map((message) => <p key={message}>{message}</p>) : undefined}
    </PanelStatus>
  );
}
