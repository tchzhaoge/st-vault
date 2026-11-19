import { tr } from '../lib/i18n';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../design/Icon';
import { animateSurface, interruptSurface } from '../../design/motion';
import { popoverPlacement, type PopoverSide } from '../lib/popover-placement';

export function ToolPopover({
  title,
  open,
  onToggle,
  onClose,
  trigger,
  children,
  className = '',
  count = 0,
  busy = false,
  alert,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  count?: number;
  busy?: boolean;
  alert?: string;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const id = useId();
  const [present, setPresent] = useState(open);
  const mounted = open || present;
  const interrupted = useRef<Keyframe>();
  useLayoutEffect(() => {
    if (!mounted || !panel.current || !button.current) return;
    const element = panel.current,
      anchor = button.current;
    if (!open) {
      const restoreFocus = element.contains(document.activeElement);
      element.setAttribute('inert', '');
      if (restoreFocus) anchor.focus({ preventScroll: true });
      const animation = animateSurface(element, anchor, true, interrupted.current);
      interrupted.current = undefined;
      if (!animation) {
        setPresent(false);
        return;
      }
      void animation.finished.then(
        () => setPresent(false),
        (error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            console.warn(
              'Surface closing animation failed',
              error instanceof Error ? error.name : 'unknown',
            );
            setPresent(false);
          }
        },
      );
      return () => {
        interrupted.current = interruptSurface(animation, element);
      };
    }
    setPresent(true);
    element.removeAttribute('inert');
    // Content growth must not flip an already open panel across its trigger.
    let side: PopoverSide | undefined;
    const place = (): void => {
      const element = panel.current,
        anchor = button.current;
      if (!element || !anchor) return;
      const box = anchor.getBoundingClientRect();
      const placement = popoverPlacement(
        box,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        side,
      );
      side = placement.side;
      element.style.maxHeight = `${placement.maxHeight}px`;
      element.style.left = `${placement.left}px`;
      element.style.top = placement.top === undefined ? 'auto' : `${placement.top}px`;
      element.style.bottom = placement.bottom === undefined ? 'auto' : `${placement.bottom}px`;
      const content = element.querySelector<HTMLElement>('.panel-content');
      if (content) {
        // Measure with bounded lists first. Only a genuinely oversized panel
        // takes ownership of scrolling; short lists keep their natural height.
        const scrollTop = content.scrollTop;
        content.dataset.scrollOwner = 'lists';
        content.dataset.scrollOwner =
          content.scrollHeight > content.clientHeight + 1 ? 'panel' : 'lists';
        content.scrollTop = scrollTop;
      }
    };
    place();
    const animation = animateSurface(element, anchor, false, interrupted.current);
    interrupted.current = undefined;
    panel.current?.focus();
    const observer = new ResizeObserver(place);
    const content = element.querySelector<HTMLElement>('.panel-content');
    const observeContent = (): void => {
      observer.disconnect();
      observer.observe(element);
      // At the viewport limit the outer box stops growing. The natural content
      // can still change, so keep observing its groups instead of waiting for a
      // panel resize that will never happen.
      for (const child of content?.children ?? []) observer.observe(child);
    };
    observeContent();
    const mutations = new MutationObserver(() => {
      observeContent();
      place();
    });
    if (content) mutations.observe(content, { childList: true });
    const outside = (event: PointerEvent): void => {
      if (
        !root.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        close.current();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        button.current?.focus();
      }
    };
    const resize = (): void => {
      side = undefined;
      place();
    };
    const scroll = (event: Event): void => {
      // A panel's own scroll does not move its anchor. Re-measuring its lists
      // here would clamp scrollTop while temporarily switching scroll owners.
      if (!element.contains(event.target as Node)) place();
    };
    window.addEventListener('resize', resize);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      interrupted.current = interruptSurface(animation, element);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, mounted]);
  return (
    <div className={`tool-anchor ${className}`} ref={root}>
      <button
        ref={button}
        type="button"
        className={`tool-trigger${open ? ' active' : ''}`}
        aria-label={title}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={mounted ? id : undefined}
        aria-busy={busy}
        onClick={onToggle}
      >
        {trigger}
        {alert && (
          <span className="tool-alert" role="img" aria-label={alert} title={alert}>
            <Icon name="alert-circle" />
          </span>
        )}
        {count > 0 && (
          <span className="unread-badge" aria-label={tr('{{v0}} 条未读事件', { v0: count })}>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {mounted &&
        createPortal(
          <div
            id={id}
            ref={panel}
            className="toolbar-popover"
            role="dialog"
            aria-label={title}
            aria-labelledby={`${id}-title`}
            aria-hidden={open ? undefined : true}
            data-state={open ? 'open' : 'closing'}
            tabIndex={-1}
          >
            <header>
              <h2 id={`${id}-title`}>{title}</h2>
              <button className="icon-button" aria-label={tr('关闭浮窗')} onClick={onClose}>
                <Icon name="close" />
              </button>
            </header>
            <div className="panel-content">{children}</div>
          </div>,
          document.fullscreenElement ?? document.body,
        )}
    </div>
  );
}
