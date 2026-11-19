import type { ReactNode } from 'react';
import { ProgressRing } from './ProgressRing';

export function PanelIdentity({
  icon,
  label,
  value,
  status,
}: {
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  status?: ReactNode;
}): JSX.Element {
  return (
    <div className="panel-identity">
      <span className="panel-identity-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="panel-identity-content">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      {status}
    </div>
  );
}

export function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function PanelFeedback({
  children,
  kind = 'info',
}: {
  children: ReactNode;
  kind?: 'info' | 'busy' | 'success' | 'error';
}): JSX.Element {
  return (
    <div className={`panel-feedback is-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'busy' && <ProgressRing />}
      <span>{children}</span>
    </div>
  );
}

/** Label/value status rows share the same hierarchy as the panel's facts. */
export function PanelStatus({
  label,
  value,
  kind,
  children,
  className = '',
}: {
  label: string;
  value: ReactNode;
  kind: 'ok' | 'checking' | 'error' | 'neutral';
  children?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`panel-status ${className} is-${kind}`} role="status" aria-live="polite">
      <div className="panel-status-row">
        <span className="panel-status-label">{label}</span>
        <span className="panel-status-value">
          <i className="panel-status-dot" aria-hidden="true" />
          {value}
        </span>
      </div>
      {children && <div className="panel-status-notes">{children}</div>}
    </div>
  );
}
