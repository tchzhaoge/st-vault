import type { ViewWindow } from './range-control';
import { dragRange } from './selection-range';
export type TrackGesture = 'selection' | 'scroll';
/** Lock direction only after intent is clear; vertical movement always scrolls rows. */
export function trackGesture(dx: number, dy: number): TrackGesture | null {
  if (Math.hypot(dx, dy) < 5) return null;
  return Math.abs(dy) > Math.abs(dx) ? 'scroll' : 'selection';
}

interface Start {
  id: string;
  preview: boolean;
  x: number;
  y: number;
  at: number;
  width: number;
  scrollTop: number;
  window: ViewWindow;
  selection: ViewWindow;
  edge: string | null;
  timelineStartMs: number;
}
type Motion =
  | { kind: 'idle' }
  | { kind: 'scroll'; top: number }
  | { kind: 'selection'; range: ViewWindow | null };
type Completion = { kind: 'none' } | { kind: 'choose' } | { kind: 'selection'; range: ViewWindow };

/** One pointer owns one direction until finish/cancel; geometry never mutates component refs. */
export class TrackGestureSession {
  private direction: TrackGesture | null = null;
  private active = true;
  private scrollTop: number;
  constructor(private readonly start: Start) {
    this.scrollTop = start.scrollTop;
  }
  get id(): string {
    return this.start.id;
  }
  get mode(): TrackGesture | null {
    return this.direction;
  }
  compensateScroll(delta: number): void {
    if (this.direction === 'scroll') this.scrollTop += delta;
  }
  private rangeAt(x: number, now: number): ViewWindow | null {
    const start = this.start;
    if (start.width <= 0) return null;
    const delta = ((x - start.x) / start.width) * (start.window.toMs - start.window.fromMs);
    return dragRange(
      start.edge === 'from'
        ? start.selection.toMs
        : start.edge === 'to'
          ? start.selection.fromMs
          : start.at,
      start.at + delta,
      {
        fromMs: Math.max(start.timelineStartMs, start.window.fromMs),
        toMs: Math.min(now, start.window.toMs),
      },
    );
  }
  move(x: number, y: number, now: number): Motion {
    if (!this.active) return { kind: 'idle' };
    this.direction ??= trackGesture(x - this.start.x, y - this.start.y);
    if (this.direction === 'scroll')
      return { kind: 'scroll', top: this.scrollTop - (y - this.start.y) };
    if (this.direction === 'selection' && !this.start.preview)
      return { kind: 'selection', range: this.rangeAt(x, now) };
    return { kind: 'idle' };
  }
  finish(x: number, now: number): Completion {
    if (!this.active) return { kind: 'none' };
    this.active = false;
    if (!this.direction && this.start.preview) return { kind: 'choose' };
    const range =
      this.direction === 'selection' && !this.start.preview ? this.rangeAt(x, now) : null;
    return range ? { kind: 'selection', range } : { kind: 'none' };
  }
  cancel(): void {
    this.active = false;
  }
}
