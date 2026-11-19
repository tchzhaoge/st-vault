import { useEffect, useRef, useState } from 'react';
/** One pointer interaction owns one presentation. Candidate updates continue in the background. */
export class PressVisibility<T> {
  private snapshot: { value: T } | null = null;
  hold(value: T): boolean {
    if (this.snapshot) return false;
    this.snapshot = { value };
    return true;
  }
  read(current: T): T {
    return this.snapshot ? this.snapshot.value : current;
  }
  release(): boolean {
    if (!this.snapshot) return false;
    this.snapshot = null;
    return true;
  }
}
export function usePressVisibility<T>(candidate: T): { value: T; hold: () => void } {
  const state = useRef<PressVisibility<T> | null>(null);
  state.current ??= new PressVisibility<T>();
  const press = state.current;
  const [, render] = useState(0);
  useEffect(() => {
    const release = (): void => {
      if (press.release()) render((value) => value + 1);
    };
    const visibility = (): void => {
      if (document.visibilityState === 'hidden') release();
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    // A release outside the page may never deliver pointerup to this document.
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibility);
      press.release();
    };
  }, [press]);
  return {
    value: press.read(candidate),
    hold: () => {
      if (press.hold(candidate)) render((value) => value + 1);
    },
  };
}
