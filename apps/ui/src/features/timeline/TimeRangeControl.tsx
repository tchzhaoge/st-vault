import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { tr } from '../../shared/lib/i18n';
import {
  DAY_MS,
  calendarEnd,
  MAX_RANGE_MS,
  resizeCalendarWindow,
  moveWindow,
  dayStart,
  type ViewWindow,
} from './range-control';
import { TimelineRuler } from './TimelineRuler';
import { dayLabel } from '../../shared/lib/date-label';
import { Icon } from '../../design/Icon';
import { calendarSpan } from '../../shared/lib/time';

export function TimeRangeControl({
  fromMs,
  toMs,
  timelineStartMs,
  onChange,
  onMove,
  nowMs = Date.now(),
}: ViewWindow & {
  timelineStartMs: number;
  onChange: (window: ViewWindow) => void;
  onMove: (direction: -1 | 1) => void;
  nowMs?: number;
}): JSX.Element {
  const first = dayStart(timelineStartMs),
    last = calendarEnd(nowMs);
  const total = Math.max(0.5, calendarSpan(first, last) / DAY_MS);
  const root = useRef<HTMLDivElement>(null),
    rail = useRef<HTMLDivElement>(null);
  const move = useRef(onMove);
  move.current = onMove;
  const gesture = useRef<{
    edge: 'from' | 'to' | 'move';
    pointerId: number;
    x: number;
    width: number;
    days: number;
    window: ViewWindow;
    next: ViewWindow;
  } | null>(null);
  const [preview, setPreview] = useState<ViewWindow | null>(null);
  const shown = preview ?? { fromMs, toMs };
  const startDay = calendarSpan(first, shown.fromMs) / DAY_MS,
    visibleDays = calendarSpan(shown.fromMs, shown.toMs) / DAY_MS;
  const spanLabel =
    visibleDays < 1 ? `${visibleDays * 24}${tr('小时')}` : tr('{{v0}}天', { v0: visibleDays });
  // The readable minimum thumb width must share the same available travel scale as dragging.
  const windowWidth = `max(var(--view-window-min-width), ${(visibleDays / total) * 100}%)`;
  const travelPosition = Math.max(0, Math.min(1, startDay / Math.max(0.5, total - visibleDays)));
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    let accumulated = 0,
      lastWheel = 0;
    const wheel = (event: WheelEvent): void => {
      if (event.ctrlKey) return;
      event.preventDefault();
      if (gesture.current) return;
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const delta =
        raw * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? node.clientWidth : 1);
      const at = performance.now();
      if (at - lastWheel > 180 || Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
      lastWheel = at;
      accumulated += delta;
      if (Math.abs(accumulated) >= 48) {
        move.current(accumulated > 0 ? 1 : -1);
        accumulated = 0;
      }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  const update = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = gesture.current;
    if (
      current?.pointerId !== event.pointerId ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    )
      return;
    const delta = ((event.clientX - current.x) * current.days) / current.width;
    const next =
      current.edge === 'move'
        ? moveWindow(current.window, delta * 2, timelineStartMs, nowMs)
        : resizeCalendarWindow(current.window, current.edge, delta, timelineStartMs, nowMs);
    if (next.fromMs === current.next.fromMs && next.toMs === current.next.toMs) return;
    current.next = next;
    setPreview(next);
  };
  const cancel = (): void => {
    gesture.current = null;
    setPreview(null);
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, edge: 'from' | 'to' | 'move'): void => {
    if (event.key === 'Escape') {
      cancel();
      return;
    }
    const delta =
      event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'Home'
            ? -total * 2
            : event.key === 'End'
              ? total * 2
              : 0;
    if (!delta) return;
    event.preventDefault();
    const window = { fromMs, toMs };
    const next =
      edge === 'move'
        ? moveWindow(window, delta, timelineStartMs, nowMs)
        : resizeCalendarWindow(window, edge, delta / 2, timelineStartMs, nowMs);
    if (next.fromMs !== fromMs || next.toMs !== toMs) onChange(next);
  };
  const dragProps = (edge: 'from' | 'to' | 'move') => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !event.isPrimary || gesture.current || !rail.current) return;
      event.preventDefault();
      const width = rail.current.clientWidth;
      if (!width) return;
      const window = { fromMs, toMs };
      const thumbWidth = event.currentTarget.parentElement!.getBoundingClientRect().width;
      gesture.current = {
        edge,
        pointerId: event.pointerId,
        x: event.clientX,
        width: edge === 'move' ? Math.max(1, width - thumbWidth) : width,
        days: edge === 'move' ? Math.max(0, total - calendarSpan(fromMs, toMs) / DAY_MS) : total,
        window,
        next: window,
      };
      setPreview(window);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: update,
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      if (gesture.current?.pointerId !== event.pointerId) return;
      update(event);
      const next = gesture.current?.next;
      cancel();
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      if (next && (next.fromMs !== fromMs || next.toMs !== toMs)) onChange(next);
    },
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => {
      if (gesture.current?.pointerId === event.pointerId) cancel();
    },
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => {
      if (gesture.current?.pointerId === event.pointerId) cancel();
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => keyMove(event, edge),
  });
  return (
    <div className="time-range-control">
      <div className="time-control-row" ref={root}>
        <button
          className="day-step"
          aria-label={tr('前12小时')}
          disabled={fromMs <= first}
          onClick={() => onMove(-1)}
        >
          <Icon name="chevron-left" />
        </button>
        <div className="calendar-page">
          <div
            className="view-position"
            ref={rail}
            data-gesture={preview ? gesture.current?.edge : undefined}
            role="group"
            aria-label={tr('视图位置与跨度')}
          >
            <span className="view-position-track" />
            <div
              className="view-position-window"
              style={{
                left: `calc((100% - ${windowWidth}) * ${travelPosition})`,
                width: windowWidth,
              }}
            >
              <button
                className="view-position-grip"
                role="slider"
                aria-label={tr('平移视窗')}
                aria-valuemin={0}
                aria-valuemax={Math.max(0, total - visibleDays)}
                aria-valuenow={startDay}
                aria-valuetext={`${dayLabel(shown.fromMs, nowMs)} · ${spanLabel}`}
                disabled={visibleDays >= total}
                {...dragProps('move')}
              >
                <span className="view-position-ridges" aria-hidden="true" />
                <span className="view-position-span">{spanLabel}</span>
                <span className="view-position-ridges" aria-hidden="true" />
              </button>
              {(['from', 'to'] as const).map((edge) => {
                const value = edge === 'from' ? startDay : startDay + visibleDays;
                const min =
                  edge === 'from'
                    ? Math.max(0, startDay + visibleDays - MAX_RANGE_MS / DAY_MS)
                    : startDay + 0.5;
                const max =
                  edge === 'from'
                    ? startDay + visibleDays - 0.5
                    : Math.min(total, startDay + MAX_RANGE_MS / DAY_MS);
                return (
                  <button
                    key={edge}
                    className={`view-position-handle ${edge}`}
                    role="slider"
                    aria-label={edge === 'from' ? tr('视窗起点') : tr('视窗终点')}
                    aria-valuemin={min}
                    aria-valuemax={max}
                    aria-valuenow={value}
                    aria-valuetext={dayLabel(
                      edge === 'from' ? shown.fromMs : shown.toMs - 1,
                      nowMs,
                    )}
                    {...dragProps(edge)}
                  ></button>
                );
              })}
            </div>
          </div>
        </div>
        <button
          className="day-step"
          aria-label={tr('后12小时')}
          disabled={toMs >= last}
          onClick={() => onMove(1)}
        >
          <Icon name="chevron-right" />
        </button>
      </div>
      <div className="time-ruler-row">
        <TimelineRuler fromMs={fromMs} toMs={toMs} overscanMs={DAY_MS} nowMs={nowMs} />
      </div>
    </div>
  );
}
