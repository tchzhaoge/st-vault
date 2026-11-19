import { Icon } from '../design/Icon';
import { tr } from '../shared/lib/i18n';
import { ToolPopover } from '../shared/ui/ToolPopover';
export type Tool = 'account' | 'keys' | 'cdn' | 'settings' | 'status' | 'history';
export function HeaderTools({
  settings,
  status,
  history,
  unread,
  open,
  setOpen,
  onLogout,
  statusAlert,
  deletionBusy = false,
}: {
  settings: React.ReactNode;
  status: React.ReactNode;
  history: React.ReactNode;
  unread: number;
  open: Tool | null;
  setOpen: React.Dispatch<React.SetStateAction<Tool | null>>;
  onLogout: () => void;
  statusAlert?: string;
  deletionBusy?: boolean;
}): JSX.Element {
  return (
    <nav className="header-tools" aria-label={tr('管理')}>
      {(
        [
          { id: 'settings', title: tr('设置') },
          { id: 'status', title: tr('状态') },
          { id: 'history', title: tr('历史') },
        ] as const
      ).map((item) => (
        <ToolPopover
          key={item.id}
          title={item.title}
          open={open === item.id}
          className="header-tool"
          busy={item.id === 'status' && deletionBusy}
          alert={item.id === 'status' ? statusAlert : undefined}
          trigger={
            <>
              {item.id === 'status' && deletionBusy ? (
                <span className="spinner" />
              ) : (
                <Icon name={item.id} />
              )}
              <span className="tool-label">{item.title}</span>
            </>
          }
          count={item.id === 'history' ? unread : 0}
          onToggle={() => setOpen((current) => (current === item.id ? null : item.id))}
          onClose={() => setOpen((current) => (current === item.id ? null : current))}
        >
          {item.id === 'history' ? history : item.id === 'status' ? status : settings}
        </ToolPopover>
      ))}
      <button className="logout-button" aria-label={tr('退出')} onClick={onLogout}>
        <Icon name="logout" />
        <span>{tr('退出')}</span>
      </button>
    </nav>
  );
}
