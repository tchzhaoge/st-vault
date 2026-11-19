import { describe, expect, it, vi } from 'vitest';
import { bindPlayerKeyboard, seekDirection } from './player-keyboard';

function setup() {
  const page = Object.assign(new EventTarget(), {
    hidden: false,
    querySelector: vi.fn((): object | null => null),
  });
  const view = new EventTarget();
  const seek = vi.fn(() => true),
    reset = vi.fn();
  const dispose = bindPlayerKeyboard(seek, reset, page as unknown as Document, view as Window);
  const key = (name: string, props: Record<string, unknown> = {}, type = 'keydown') => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({ key: name, ...props }).map(([k, value]) => [k, { value }]),
      ),
    );
    page.dispatchEvent(event);
    return event;
  };
  return { page, view, seek, reset, dispose, key };
}

describe('single-player keyboard ownership', () => {
  it('handles ordinary page focus and repeated arrows without requiring player focus', () => {
    const { key, seek, dispose } = setup();
    expect(key('ArrowLeft').defaultPrevented).toBe(true);
    key('ArrowRight', { repeat: true });
    expect(seek.mock.calls).toEqual([[-1], [1]]);
    dispose();
    key('ArrowRight');
    expect(seek).toHaveBeenCalledTimes(2);
  });

  it('leaves editable fields, semantic widgets, dialogs and modified keys to their owners', () => {
    const { key, seek, page, dispose } = setup();
    key('ArrowRight', { target: { closest: () => ({}) } });
    for (const flag of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'isComposing']) {
      expect(key('ArrowRight', { [flag]: true }).defaultPrevented).toBe(false);
    }
    page.querySelector.mockReturnValue({});
    key('ArrowRight');
    page.querySelector.mockReturnValue(null);
    page.hidden = true;
    key('ArrowRight');
    expect(seek).not.toHaveBeenCalled();
    expect(seekDirection({ key: 'ArrowRight', defaultPrevented: true } as KeyboardEvent)).toBe(0);
    dispose();
  });

  it('does not consume arrows when there is no actionable media', () => {
    const { key, seek, dispose } = setup();
    seek.mockReturnValue(false);
    expect(key('ArrowLeft').defaultPrevented).toBe(false);
    expect(key('Enter').defaultPrevented).toBe(false);
    expect(seek).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('clears held targets on key release, focus changes, pointer interaction and leaving the page', () => {
    const { page, view, key, reset, dispose } = setup();
    key('ArrowRight', {}, 'keyup');
    for (const type of ['focusin', 'pointerdown', 'visibilitychange'])
      page.dispatchEvent(new Event(type));
    view.dispatchEvent(new Event('blur'));
    expect(reset).toHaveBeenCalledTimes(5);
    dispose();
    view.dispatchEvent(new Event('blur'));
    expect(reset).toHaveBeenCalledTimes(6);
  });
});
