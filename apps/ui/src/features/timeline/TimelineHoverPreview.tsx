import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { SnapshotItem } from '@st-vault/api-schema';
import { request, ApiError } from '../../shared/lib/api';
import { snapshotImages, ImagePendingError } from '../../shared/lib/image-loader';
import { tr } from '../../shared/lib/i18n';
import {
  previewPosition,
  samePreviewUnit,
  type PreviewBounds,
  type ResolvedPreviewUnit,
} from './hover-preview';

interface HoverPoint {
  id: string;
  at: number;
  revision: number;
  x: number;
  y: number;
  bounds: PreviewBounds;
}
export interface TimelineHoverHandle {
  show: (point: HoverPoint | null) => void;
}

/** One preview per board: pointer movement never rerenders virtualized rows. */
export const TimelineHoverPreview = forwardRef<TimelineHoverHandle>(
  function TimelineHoverPreview(_, ref) {
    const [sample, setSample] = useState<{ id: string; at: number; revision: number } | null>(null);
    const [image, setImage] = useState<string | null>(null);
    const root = useRef<HTMLDivElement>(null),
      point = useRef<HoverPoint | null>(null),
      resolved = useRef<ResolvedPreviewUnit | null>(null),
      identity = useRef(''),
      ownedSource = useRef(''),
      ownedImage = useRef('');
    const clearImage = (): void => {
      resolved.current = null;
      if (ownedImage.current) URL.revokeObjectURL(ownedImage.current);
      ownedImage.current = '';
      ownedSource.current = '';
      setImage(null);
    };
    useEffect(
      () => () => {
        if (ownedImage.current) URL.revokeObjectURL(ownedImage.current);
      },
      [],
    );
    const place = (): void => {
      const value = point.current;
      if (!root.current || !value) return;
      const position = previewPosition(value.x, value.y, value.bounds);
      root.current.style.visibility = position ? 'visible' : 'hidden';
      if (!position) return;
      root.current.style.width = `${position.width}px`;
      root.current.style.height = `${position.height}px`;
      root.current.style.left = `${position.left}px`;
      root.current.style.top = `${position.top}px`;
    };
    useImperativeHandle(ref, () => ({
      show(value) {
        point.current = value;
        if (value && samePreviewUnit(resolved.current, value)) {
          place();
          return;
        }
        const key = value ? `${value.id}:${value.revision}:${Math.round(value.at)}` : '';
        if (key !== identity.current) {
          if (!value || !identity.current.startsWith(`${value.id}:${value.revision}:`)) {
            clearImage();
          }
          resolved.current = null;
          identity.current = key;
          setSample(
            value ? { id: value.id, revision: value.revision, at: Math.round(value.at) } : null,
          );
        }
        place();
      },
    }));
    useLayoutEffect(place);
    useEffect(() => {
      if (!sample) return;
      const sampleKey = `${sample.id}:${sample.revision}:${sample.at}`;
      const controller = new AbortController();
      let url = '',
        retry: number | undefined,
        source = '';
      const run = async (): Promise<void> => {
        try {
          if (!source) {
            const item = await request<SnapshotItem | null>(
              `/api/subjects/${encodeURIComponent(sample.id)}/snapshot-point?at=${sample.at}`,
              { signal: controller.signal },
            );
            if (controller.signal.aborted || identity.current !== sampleKey) return;
            source = item?.url ?? '';
            if (!item) {
              clearImage();
              return;
            }
            resolved.current = {
              id: sample.id,
              revision: sample.revision,
              fromMs: item.slotFromMs,
              toMs: item.slotToMs,
            };
            if (source === ownedSource.current && ownedImage.current) return;
          }
          const blob = await snapshotImages.load(
            source,
            controller.signal,
            'interactive',
            30 * 60000,
          );
          if (controller.signal.aborted || identity.current !== sampleKey) return;
          url = URL.createObjectURL(blob);
          const bitmap = new Image();
          bitmap.src = url;
          await bitmap.decode();
          if (!controller.signal.aborted && identity.current === sampleKey) {
            const previous = ownedImage.current;
            ownedImage.current = url;
            ownedSource.current = source;
            setImage(url);
            url = '';
            if (previous) URL.revokeObjectURL(previous);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ImagePendingError) {
            retry = window.setTimeout(() => void run(), error.retryAfterMs);
          } else {
            resolved.current = null;
            if (!(error instanceof ApiError && error.status === 404))
              console.warn('Timeline screenshot preview unavailable', error);
          }
        }
      };
      void run();
      return () => {
        controller.abort();
        window.clearTimeout(retry);
        if (url) URL.revokeObjectURL(url);
      };
    }, [sample]);
    if (!sample) return null;
    return createPortal(
      <div
        ref={root}
        className="timeline-hover-preview"
        role="tooltip"
        aria-label={tr('时间段截图')}
        aria-busy={!image}
        data-subject-id={sample.id}
      >
        {image && <img src={image} alt="" />}
      </div>,
      document.body,
    );
  },
);
