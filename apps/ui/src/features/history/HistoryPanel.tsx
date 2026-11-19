import { tr } from '../../shared/lib/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveEvent, EventMeta, EventsResponse, Subject } from '@st-vault/api-schema';
import { request } from '../../shared/lib/api';
import { eventPresentation } from './events';
import { formatDateTimePrecise } from '../timeline/timeline';
import { clockLabel, dayKey, dayLabel } from '../../shared/lib/date-label';
import { useSyncRefresh, syncReadFailure, type SyncReadResult } from '../../shared/lib/sync';
import { CoverImage } from '../directory/CoverImage';
import { Icon } from '../../design/Icon';
import { PanelFeedback } from '../../shared/ui/PanelContent';
import { OverflowText } from '../../shared/ui/OverflowText';

export function HistorySubject({
  id,
  name,
  revision,
  onReveal,
}: {
  id: string;
  name: string;
  revision: number;
  onReveal?: () => void;
}): JSX.Element {
  const content = (
    <>
      <CoverImage id={id} revision={revision} status="avatar" variant="avatar" />
      <strong>
        <OverflowText text={name} />
      </strong>
    </>
  );
  return onReveal ? (
    <button
      type="button"
      className="history-subject"
      aria-label={tr('在列表中定位 {{v0}}', { v0: name })}
      onClick={onReveal}
    >
      {content}
    </button>
  ) : (
    <span className="history-subject">{content}</span>
  );
}

export function HistoryPanel({
  meta,
  onMeta,
  subjects = [],
  onReveal,
}: {
  meta: EventMeta | null;
  onMeta: (meta: EventMeta) => void;
  subjects?: Subject[];
  onReveal: (id: string) => void;
}): JSX.Element {
  const [items, setItems] = useState<ArchiveEvent[]>([]),
    [error, setError] = useState(''),
    [older, setOlder] = useState(false);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const [heights, setHeights] = useState<Map<number, number>>(() => new Map());
  const root = useRef<HTMLDivElement>(null),
    tail = useRef(0),
    first = useRef(0),
    following = useRef(true),
    acknowledged = useRef(meta?.readCursor ?? 0);
  const callback = useRef(onMeta);
  callback.current = onMeta;
  const readCursor = meta?.readCursor ?? 0;
  const openedReadCursor = useRef(meta?.readCursor);
  const [imageRevision, setImageRevision] = useState(0);
  useSyncRefresh(
    ['subjects'],
    () => {
      setImageRevision((value) => value + 1);
      return Promise.resolve();
    },
    true,
    '',
    true,
  );
  const olderRequest = useRef<AbortController | null>(null);
  const manualRequest = useRef<AbortController | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const hasOlder = (meta?.oldestCursor ?? 0) < (items[0]?.id ?? 0);
  const offsets = useMemo(() => {
    const values = [0];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      values.push(
        values.at(-1)! +
          (heights.get(item.id) ??
            32 + (index === 0 || dayKey(item.atMs) !== dayKey(items[index - 1].atMs) ? 30 : 0)),
      );
    }
    return values;
  }, [items, heights]);
  const visibleTop = Math.max(0, viewport.top - (hasOlder ? 30 : 0));
  const visibleStart = Math.max(
    0,
    offsets.findIndex((_, index) => index < items.length && offsets[index + 1] > visibleTop),
  );
  const start = Math.max(0, visibleStart - 4);
  let end = start;
  while (end < items.length && offsets[end] < visibleTop + viewport.height + 360) end++;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = (): void =>
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const next = new Map(heights);
    let changed = false,
      correction = 0;
    for (const article of element.querySelectorAll<HTMLElement>('.history-event')) {
      const id = Number(article.dataset.eventId),
        index = items.findIndex((item) => item.id === id);
      const height = Math.ceil(
        article.getBoundingClientRect().height +
          parseFloat(getComputedStyle(article).marginBottom || '0'),
      );
      if (height > 0 && next.get(id) !== height) {
        correction +=
          index < visibleStart
            ? height -
              (next.get(id) ??
                32 +
                  (index === 0 || dayKey(items[index].atMs) !== dayKey(items[index - 1].atMs)
                    ? 30
                    : 0))
            : 0;
        next.set(id, height);
        changed = true;
      }
    }
    if (changed) {
      const ids = new Set(items.map((item) => item.id));
      for (const id of next.keys()) if (!ids.has(id)) next.delete(id);
      setHeights(next);
      if (!following.current && correction) {
        element.scrollTop += correction;
        setViewport({ top: element.scrollTop, height: element.clientHeight });
      }
    }
  }, [items, start, end, heights, visibleStart]);
  useEffect(
    () => () => {
      olderRequest.current?.abort();
      manualRequest.current?.abort();
      readRequest.current?.abort();
    },
    [],
  );
  const ack = useCallback(async (cursor: number, signal?: AbortSignal): Promise<void> => {
    if (
      cursor <= acknowledged.current ||
      document.visibilityState !== 'visible' ||
      readRequest.current
    )
      return;
    const controller = new AbortController(),
      cancel = (): void => controller.abort();
    readRequest.current = controller;
    signal?.addEventListener('abort', cancel, { once: true });
    const deadline = window.setTimeout(cancel, 15000);
    acknowledged.current = cursor;
    try {
      callback.current(
        await request<EventMeta>('/api/events/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cursor }),
          signal: controller.signal,
        }),
      );
    } catch {
      acknowledged.current = 0;
      if (!controller.signal.aborted) setError(tr('已读状态暂未保存。'));
    } finally {
      window.clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      if (readRequest.current === controller) readRequest.current = null;
    }
  }, []);
  useEffect(() => {
    if (!following.current || !root.current) return;
    root.current.scrollTop = root.current.scrollHeight;
    setViewport({
      top: root.current.scrollTop,
      height: root.current.clientHeight,
    });
    const frame = requestAnimationFrame(() => {
      const element = root.current;
      if (
        element &&
        following.current &&
        element.scrollHeight - element.scrollTop - element.clientHeight < 24
      )
        void ack(items.at(-1)?.id ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [items, ack]);
  const refresh = useCallback(async (signal: AbortSignal): Promise<SyncReadResult> => {
    try {
      let data = await request<EventsResponse>(
        `/api/events?${tail.current ? `after=${tail.current}` : `before=${Number.MAX_SAFE_INTEGER}`}&limit=100`,
        { signal },
      );
      if (tail.current && (data.cursorExpired || data.hasMore))
        data = await request<EventsResponse>(
          `/api/events?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
          { signal },
        );
      if (signal.aborted) return;
      openedReadCursor.current ??= data.meta.readCursor;
      callback.current(data.meta);
      setError('');
      setItems((previous) => {
        const all = [
          ...new Map([...previous, ...data.items].map((event) => [event.id, event])).values(),
        ].sort((a, b) => a.id - b.id);
        const merged = following.current ? all.slice(-500) : all.slice(0, 500);
        first.current = merged[0]?.id ?? 0;
        tail.current = merged.at(-1)?.id ?? 0;
        return merged;
      });
    } catch (cause) {
      const result = syncReadFailure(cause, signal);
      if (!signal.aborted || result.status === 'retry') setError(tr('历史事件暂不可用。'));
      return result;
    }
  }, []);
  useSyncRefresh(['events'], refresh);
  async function loadOlder(): Promise<void> {
    if (older || !hasOlder || !first.current || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setOlder(true);
    const height = root.current?.scrollHeight ?? 0;
    try {
      const data = await request<EventsResponse>(`/api/events?before=${first.current}&limit=100`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setItems((previous) => {
        const merged = [
          ...new Map([...data.items, ...previous].map((event) => [event.id, event])).values(),
        ]
          .sort((a, b) => a.id - b.id)
          .slice(0, 500);
        first.current = merged[0]?.id ?? 0;
        tail.current = merged.at(-1)?.id ?? 0;
        return merged;
      });
      callback.current(data.meta);
      requestAnimationFrame(() => {
        if (root.current && !controller.signal.aborted) {
          root.current.scrollTop += root.current.scrollHeight - height;
          setViewport({
            top: root.current.scrollTop,
            height: root.current.clientHeight,
          });
        }
      });
    } catch {
      if (!controller.signal.aborted) setError(tr('较早事件暂不可用。'));
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
      setOlder(false);
    }
  }
  return (
    <section className="history-panel">
      <div
        ref={root}
        className="event-feed"
        role="log"
        aria-live="polite"
        aria-label={tr('历史事件')}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          setViewport({ top: element.scrollTop, height: element.clientHeight });
          if (element.scrollTop < 24) void loadOlder();
          if (following.current) {
            if (end === items.length) void ack(tail.current);
            if (meta && meta.latestCursor > tail.current && !manualRequest.current) {
              const controller = new AbortController();
              manualRequest.current = controller;
              void refresh(controller.signal).finally(() => {
                if (manualRequest.current === controller) manualRequest.current = null;
              });
            }
          }
        }}
      >
        {hasOlder && (
          <p className="event-older">{older ? tr('读取更早事件…') : tr('向上滚动查看更早事件')}</p>
        )}
        {!items.length && !error && <p className="empty-mini">{tr('暂无历史事件')}</p>}
        <div aria-hidden="true" style={{ height: offsets[start] }} />
        {items.slice(start, end).map((event, localIndex) => {
          const view = eventPresentation(event);
          if (event.kind === 'status_changed') {
            const profile = subjects.find((row) => row.id === event.subjectId);
            if (profile)
              view.name = [profile.handle, profile.formerNames?.join(' / ')]
                .filter(Boolean)
                .join(' · ');
          }
          const index = start + localIndex,
            startsDay = index === 0 || dayKey(event.atMs) !== dayKey(items[index - 1].atMs);
          return (
            <article
              key={event.id}
              className={`history-event event-${view.color}${event.id > (openedReadCursor.current ?? readCursor) ? ' unread' : ''}`}
              data-event-id={event.id}
            >
              {startsDay && (
                <div className="history-day">
                  <span>{dayLabel(event.atMs)}</span>
                </div>
              )}
              <div className="history-event-line">
                <time
                  dateTime={new Date(event.atMs).toISOString()}
                  title={tr('观测时间 {{v0}}', { v0: formatDateTimePrecise(event.occurredAtMs) })}
                >
                  {clockLabel(event.atMs)}
                </time>
                {event.kind === 'status_changed' ? (
                  <HistorySubject
                    id={event.subjectId}
                    revision={imageRevision}
                    name={view.name}
                    onReveal={
                      subjects.some((subject) => subject.id === event.subjectId)
                        ? () => onReveal(event.subjectId)
                        : undefined
                    }
                  />
                ) : (
                  <>
                    <span className="history-program-icon">
                      <Icon name="settings" />
                    </span>
                    <strong>
                      <OverflowText text={view.name} />
                    </strong>
                  </>
                )}
                <span className="event-description">
                  <OverflowText text={view.text} />
                </span>
              </div>
            </article>
          );
        })}
        <div aria-hidden="true" style={{ height: offsets[items.length] - offsets[end] }} />
      </div>
      {error && <PanelFeedback kind="error">{error}</PanelFeedback>}
    </section>
  );
}
