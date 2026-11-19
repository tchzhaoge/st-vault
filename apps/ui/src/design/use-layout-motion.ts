import { useLayoutEffect, useRef, type RefObject } from 'react';
import { LayoutMotion } from './layout-motion';
export function useLayoutMotion(
  root: RefObject<HTMLElement>,
  scope: string,
  revision: unknown,
  selector?: string,
  capture?: unknown,
): void {
  const motion = useRef<LayoutMotion | null>(null);
  const previous = useRef<{ value: unknown } | null>(null);
  motion.current ??= new LayoutMotion();
  useLayoutEffect(() => {
    if (root.current)
      motion.current!.update(root.current, scope, selector, previous.current?.value !== revision);
    previous.current = { value: revision };
  }, [root, scope, revision, selector, capture]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    // Responsive/fullscreen CSS changes geometry without changing media data.
    // Refresh the baseline so the next heartbeat never animates from an old layout.
    const observer = new ResizeObserver(() => motion.current!.update(node, scope, selector, false));
    observer.observe(node);
    return () => observer.disconnect();
  }, [root, scope, selector]);
  useLayoutEffect(() => () => motion.current!.clear(), []);
}
