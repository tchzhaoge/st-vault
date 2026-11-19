import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { tr } from '../../shared/lib/i18n';
import { animateSurface } from '../../design/motion';

/** A local confirmation surface: masks only its media review panel, never the player. */
export function MediaDeleteDialog({
  anchor,
  onClose,
  onConfirm,
}: {
  anchor?: HTMLElement | null;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    node.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const animation = animateSurface(
      node,
      anchor?.querySelector('.snapshot-actions') ?? node,
      false,
    );
    return () => {
      animation?.cancel();
      if (node.contains(document.activeElement) && previous?.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [anchor]);
  const content = (
    <div
      className="media-delete-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        className="media-delete-dialog"
        ref={dialog}
        aria-labelledby="media-delete-title"
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
        <h3 id="media-delete-title">{tr('删除所有非喜欢')}</h3>
        <p>{tr('删除当前时间范围内所有未喜欢的录像，包含其他页，无法撤销。')}</p>
        <p className="muted">{tr('已喜欢的录像会保留。')}</p>
        <div className="media-delete-actions">
          <button className="secondary" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="danger" onClick={onConfirm}>
            {tr('确认删除')}
          </button>
        </div>
      </dialog>
    </div>
  );
  const host = anchor?.closest('.media-review');
  return host ? createPortal(content, host) : content;
}
