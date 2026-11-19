import { afterEach, expect, it, vi } from 'vitest';
import type * as React from 'react';
import { PressVisibility, usePressVisibility } from './use-press-visibility';

const hooks = vi.hoisted(() => ({
  ref: { current: null },
  effects: [] as (() => void | (() => void))[],
  render: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useRef: () => hooks.ref,
  useState: () => [0, hooks.render],
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  hooks.ref.current = null;
  hooks.effects.length = 0;
  hooks.render.mockClear();
  vi.unstubAllGlobals();
});

function mount() {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  const press = usePressVisibility(false);
  cleanup = hooks.effects.shift()?.() ?? undefined;
  press.hold();
  expect(usePressVisibility(true).value).toBe(false);
  return { document, window };
}

it.each(['pointerup', 'pointercancel', 'blur', 'hidden'])(
  'releases a held presentation on %s even without another click',
  (event) => {
    const { document, window } = mount();
    if (event === 'hidden') {
      document.visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    } else (event === 'blur' ? window : document).dispatchEvent(new Event(event));
    expect(usePressVisibility(true).value).toBe(true);
    expect(hooks.render).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event('pointerup'));
    expect(hooks.render).toHaveBeenCalledTimes(2);
  },
);

it('keeps an active press on a visible notification and removes cancellation listeners on unmount', () => {
  const { document, window } = mount();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(usePressVisibility(true).value).toBe(false);
  expect(hooks.render).toHaveBeenCalledTimes(1);
  cleanup?.();
  cleanup = undefined;
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('pointercancel'));
  document.dispatchEvent(new Event('pointerup'));
  window.dispatchEvent(new Event('blur'));
  expect(hooks.render).toHaveBeenCalledTimes(1);
  expect(usePressVisibility(true).value).toBe(true);
});
it('keeps hidden chrome from covering a pressed image until the interaction finishes', () => {
  const press = new PressVisibility<boolean>();
  press.hold(false);
  expect(press.read(true)).toBe(false);
  press.hold(true);
  expect(press.read(true)).toBe(false);
  expect(press.release()).toBe(true);
  expect(press.read(true)).toBe(true);
  expect(press.release()).toBe(false);
});
it('keeps visible controls hittable through the hide deadline and freezes both player layers', () => {
  const press = new PressVisibility<{ controls: boolean; heading: boolean }>();
  const visible = { controls: true, heading: true };
  press.hold(visible);
  expect(press.read({ controls: false, heading: false })).toBe(visible);
  press.release();
  expect(press.read({ controls: false, heading: false })).toEqual({
    controls: false,
    heading: false,
  });
});
