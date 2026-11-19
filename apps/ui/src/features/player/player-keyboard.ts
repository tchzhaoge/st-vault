export const PLAYER_SEEK_SECONDS = 5;

export function seekDirection(event: KeyboardEvent): -1 | 0 | 1 {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return 0;
  return event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
}

// Native controls and dialogs own their keys. Ordinary page focus does not change
// the target: this workbench has exactly one connected player.
const ownKeys =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), ' +
  '[role="slider"]:not([data-player-seek]), [role="spinbutton"], [role="combobox"], [role="listbox"], ' +
  '[role="menu"], [role="tablist"], [role="tree"], [role="grid"], [role="dialog"], dialog';

export function bindPlayerKeyboard(
  seek: (direction: -1 | 1) => boolean,
  reset: () => void,
  page: Document = document,
  view: Window = window,
): () => void {
  const down = (event: KeyboardEvent): void => {
    const direction = seekDirection(event);
    const target = event.target as Element | null;
    if (
      !direction ||
      page.hidden ||
      target?.closest?.(ownKeys) ||
      page.querySelector('[role="dialog"]:not([aria-hidden="true"]), dialog[open]')
    )
      return;
    if (seek(direction)) event.preventDefault();
  };
  const up = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') reset();
  };
  page.addEventListener('keydown', down);
  page.addEventListener('keyup', up);
  page.addEventListener('focusin', reset);
  page.addEventListener('pointerdown', reset);
  page.addEventListener('visibilitychange', reset);
  view.addEventListener('blur', reset);
  return () => {
    page.removeEventListener('keydown', down);
    page.removeEventListener('keyup', up);
    page.removeEventListener('focusin', reset);
    page.removeEventListener('pointerdown', reset);
    page.removeEventListener('visibilitychange', reset);
    view.removeEventListener('blur', reset);
    reset();
  };
}
