import { useLayoutEffect, useRef } from 'react';

/** Animate only overflowing cells in the row being read; no polling timer. */
export function OverflowText({
  text,
  tooltip = true,
}: {
  text: string;
  tooltip?: boolean;
}): JSX.Element {
  const root = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = (): void => {
      const width = node.firstElementChild?.scrollWidth ?? 0;
      const distance = Math.max(0, width - node.clientWidth);
      node.classList.toggle('is-overflowing', distance > 1);
      node.style.setProperty('--text-travel', `${-distance}px`);
      node.style.setProperty(
        '--text-duration',
        `${Math.max(6000, 2000 + (distance * 2000) / 30)}ms`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return (
    <span className="overflow-text" ref={root} title={tooltip ? text : undefined}>
      <span>{text}</span>
    </span>
  );
}
