import { useEffect, useId, useRef } from 'react';
import { tr } from '../../shared/lib/i18n';

/** Confirmation stays attached to the account panel and returns focus on cancel. */
export function DisconnectAccountDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null),
    title = useId(),
    description = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className="account-disconnect-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={root}
        role="alertdialog"
        aria-labelledby={title}
        aria-describedby={description}
        className="account-disconnect-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const buttons = [...event.currentTarget.querySelectorAll('button')];
            if (document.activeElement === buttons[event.shiftKey ? 0 : buttons.length - 1]) {
              event.preventDefault();
              buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
            }
          }
        }}
      >
        <h3 id={title}>{tr('断开账户？')}</h3>
        <p id={description}>
          {tr('将停止所有主播录制，并将主播移入归档。已有录像和喜欢标记保留。')}
        </p>
        <p className="muted">
          {tr('Cookies 草稿保存在当前浏览器，刷新后仍保留；手动清空或切换站点时删除。')}
        </p>
        <div className="panel-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {tr('取消')}
          </button>
          <button type="button" className="text-button panel-danger" onClick={onConfirm}>
            {tr('确认断开')}
          </button>
        </div>
      </div>
    </div>
  );
}
