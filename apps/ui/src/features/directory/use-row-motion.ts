import { useLayoutEffect, useRef, type RefObject } from 'react';
import { MEDIA_MOTION } from '../../design/layout-motion';
import { planRowMotion, type RowWindow } from './row-motion';
import { SUBJECT_ROW_HEIGHT } from './virtual-list';

interface Flight {
  id: string;
  node: HTMLElement;
  animation: Animation;
  from: number;
  to: number;
  opacity: [number, number];
}
interface Snapshot extends RowWindow {
  scope: string;
  width: number;
  nodes: Map<string, HTMLElement>;
}
let exitSequence = 0;
function retainExit(source: HTMLElement): HTMLElement {
  if (!source.isConnected) return source;
  const clone = source.cloneNode(true) as HTMLElement;
  // An overscan row still exists in React. Give its copied SVG paint servers
  // independent IDs so either copy can unmount without breaking the other.
  for (const definition of clone.querySelectorAll<SVGElement>('defs [id]')) {
    const old = definition.id;
    definition.id = `${old}-exit-${++exitSequence}`;
    for (const node of clone.querySelectorAll('*')) {
      for (const attribute of [...node.attributes]) {
        const value = attribute.value.replaceAll(`url(#${old})`, `url(#${definition.id})`);
        if (value !== attribute.value) node.setAttribute(attribute.name, value);
      }
    }
  }
  return clone;
}

/** Native scrolling owns layout. Animation owns only a bounded set of visible pixels. */
export function useRowMotion(
  root: RefObject<HTMLDivElement>,
  ids: string[],
  revision: string,
  scope: string,
  top: number,
  height: number,
  start: number,
  end: number,
  selectedId: string | null,
): void {
  const snapshot = useRef<Snapshot | null>(null);
  const flights = useRef<Flight[]>([]);
  const selectionFlight = useRef<Animation | null>(null);
  const layer = useRef<HTMLElement | null>(null);
  const frame = useRef<number | undefined>();
  const quietUntil = useRef(0);
  const pointerHeld = useRef(false);
  const clear = (): void => {
    for (const flight of flights.current) flight.animation.cancel();
    flights.current = [];
    selectionFlight.current?.cancel();
    selectionFlight.current = null;
    layer.current?.remove();
    layer.current = null;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    if (root.current) {
      delete root.current.dataset.rowMotion;
      root.current.dispatchEvent(new Event('stv-row-motion', { bubbles: true }));
    }
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof element.animate !== 'function') return;
    const before = snapshot.current;
    const next: Snapshot = {
      ids,
      top,
      height,
      scope,
      width: element.clientWidth,
      nodes: new Map(
        [...element.querySelectorAll<HTMLElement>('.track-table > .track-row')].map((node) => [
          node.dataset.subjectId!,
          node,
        ]),
      ),
    };
    snapshot.current = next;
    if (
      before?.scope !== scope ||
      before.height !== height ||
      before.width !== next.width ||
      performance.now() < quietUntil.current ||
      pointerHeld.current
    ) {
      clear();
      return;
    }
    if (before.ids.length === ids.length && before.ids.every((id, i) => id === ids[i])) {
      if (before.top !== top) clear();
      return;
    }
    const interrupted = new Map<string, number>();
    const opacities = new Map<string, number>();
    for (const flight of flights.current) {
      const progress = Number(flight.animation.effect?.getComputedTiming().progress ?? 1);
      interrupted.set(flight.id, flight.from + (flight.to - flight.from) * progress);
      opacities.set(
        flight.id,
        flight.opacity[0] + (flight.opacity[1] - flight.opacity[0]) * progress,
      );
      if (!before.nodes.has(flight.id)) before.nodes.set(flight.id, flight.node);
    }
    const moves = planRowMotion(before, next, SUBJECT_ROW_HEIGHT, interrupted);
    clear();
    const timeline = document.timeline.currentTime;
    let exits = 0;
    const exitLimit = Math.ceil(height / SUBJECT_ROW_HEIGHT) + 1;
    for (const move of moves) {
      let node = next.nodes.get(move.id);
      const targetIndex = ids.indexOf(move.id);
      let base = targetIndex * SUBJECT_ROW_HEIGHT - top;
      if (move.exit) {
        const source = before.nodes.get(move.id);
        if (!source || exits >= exitLimit) continue;
        exits++;
        // Retain unmounted decoded DOM: do not re-fetch a revoked cover blob URL.
        node = retainExit(source);
        node.classList.replace('track-row', 'track-row-motion-ghost');
        node.classList.toggle('selected', move.id === selectedId);
        node.removeAttribute('data-subject-id');
        node.setAttribute('aria-hidden', 'true');
        node.inert = true;
        if (!layer.current) {
          layer.current = document.createElement('div');
          layer.current.className = 'track-row-motion-layer';
          layer.current.setAttribute('aria-hidden', 'true');
          layer.current.inert = true;
          Object.assign(layer.current.style, { top: `${top}px`, height: `${height}px` });
          element.querySelector('.track-table')!.append(layer.current);
        }
        base = move.from;
        Object.assign(node.style, {
          position: 'absolute',
          top: `${base}px`,
          width: '100%',
          translate: 'none',
        });
        layer.current.append(node);
      }
      if (!node) continue;
      const opacity: [number, number] = [
        opacities.get(move.id) ?? move.opacity[0],
        move.opacity[1],
      ];
      const zIndex = Math.abs(move.to - move.from) > SUBJECT_ROW_HEIGHT ? 4 : 1;
      const animation = node.animate(
        [
          { translate: `0 ${move.from - base}px`, opacity: opacity[0], zIndex },
          { translate: `0 ${move.to - base}px`, opacity: opacity[1], zIndex },
        ],
        { ...MEDIA_MOTION, id: 'directory-row', fill: 'both' },
      );
      animation.startTime = timeline;
      flights.current.push({ ...move, node, animation, opacity });
      if (move.id === selectedId && targetIndex >= 0) {
        const selection = element.querySelector<HTMLElement>('.selection-row-motion');
        const offset = targetIndex * SUBJECT_ROW_HEIGHT - top;
        selectionFlight.current =
          selection?.animate(
            [
              { transform: `translateY(${move.from - offset}px)` },
              { transform: `translateY(${move.to - offset}px)` },
            ],
            { ...MEDIA_MOTION, id: 'directory-selection' },
          ) ?? null;
        if (selectionFlight.current) selectionFlight.current.startTime = timeline;
      }
    }
    if (!flights.current.length) return;
    element.dataset.rowMotion = 'true';
    const tick = (): void => {
      element.dispatchEvent(new Event('stv-row-motion', { bubbles: true }));
      if (
        flights.current.some((flight) => ['running', 'paused'].includes(flight.animation.playState))
      )
        frame.current = requestAnimationFrame(tick);
      else clear();
    };
    frame.current = requestAnimationFrame(tick);
  }, [revision, scope, top, height, start, end, selectedId]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const interrupt = (): void => {
      quietUntil.current = performance.now() + 150;
      clear();
      // Even a tiny scroll (or a wheel at the list edge) may not cause a React
      // render. Keep an accurate baseline for the first later data refresh.
      if (snapshot.current) snapshot.current = { ...snapshot.current, top: element.scrollTop };
    };
    const scroll = (): void => {
      if (element.scrollTop !== snapshot.current?.top) interrupt();
    };
    const hold = (): void => {
      pointerHeld.current = true;
      interrupt();
    };
    const release = (): void => {
      pointerHeld.current = false;
    };
    element.addEventListener('wheel', interrupt, { passive: true });
    element.addEventListener('pointerdown', hold, { passive: true });
    element.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      element.removeEventListener('wheel', interrupt);
      element.removeEventListener('pointerdown', hold);
      element.removeEventListener('scroll', scroll);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      clear();
    };
  }, [root]);
}
