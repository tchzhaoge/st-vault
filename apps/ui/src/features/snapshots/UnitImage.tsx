import { memo, useEffect, useRef, useState } from 'react';
import { snapshotImages, ImagePendingError } from '../../shared/lib/image-loader';
import { snapshotSeen } from './snapshot-seen';
export const UnitImage = memo(function UnitImage({
  src,
  subjectId,
  unitId,
  toMs,
}: {
  src: string;
  subjectId: string;
  unitId: string;
  toMs: number;
}): JSX.Element | null {
  // Unit identity stays fixed while its coverage grows. Decode new images
  // independently; metadata and neighboring pictures never wait for this one.
  const identity = src;
  const source = useRef(src);
  source.current = src;
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // Visibility admits the initial load; layout/FLIP movement must not
        // discard a decoded image. Virtualization owns eviction on unmount.
        setVisible(true);
        observer.disconnect();
      },
      { root: node.current.closest('.snapshot-grid'), rootMargin: '240px' },
    );
    observer.observe(node.current);
    return () => observer.disconnect();
  }, []);
  const boundary = useRef(toMs);
  boundary.current = toMs;
  const [image, setImage] = useState<{ src: string; url: string; toMs: number } | null>(null);
  const ownedUrls = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of ownedUrls.current) URL.revokeObjectURL(url);
      ownedUrls.current.clear();
    },
    [],
  );
  useEffect(
    () => () => {
      if (image?.url) {
        URL.revokeObjectURL(image.url);
        ownedUrls.current.delete(image.url);
      }
    },
    [image?.url],
  );
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let url = '',
      retry: number | undefined,
      failures = 0;
    const run = async () => {
      // Freeze before download: growth while loading must not become viewed evidence.
      const representedToMs = boundary.current;
      try {
        const blob = await snapshotImages.load(
          source.current,
          controller.signal,
          'visible',
          30 * 60000,
        );
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        ownedUrls.current.add(url);
        const bitmap = new Image();
        bitmap.src = url;
        await bitmap.decode();
        if (!controller.signal.aborted) {
          setImage({ src: source.current, url, toMs: representedToMs });
          url = '';
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (!(error instanceof ImagePendingError)) snapshotImages.invalidate(source.current);
          if (!(error instanceof ImagePendingError) && !failures)
            console.warn('Snapshot download failed; retrying', error);
          const delay =
            error instanceof ImagePendingError
              ? error.retryAfterMs
              : Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
          retry = window.setTimeout(() => {
            if (!controller.signal.aborted) {
              void run();
            }
          }, delay);
        }
      } finally {
        if (url) {
          URL.revokeObjectURL(url);
          ownedUrls.current.delete(url);
          url = '';
        }
      }
    };
    void run();
    return () => {
      controller.abort();
      window.clearTimeout(retry);
      if (url) URL.revokeObjectURL(url);
    };
  }, [identity, visible]);
  const displayed = image?.url;
  return (
    <span ref={node} className="minute-image">
      {displayed ? (
        <img
          src={displayed}
          alt=""
          onLoad={() => snapshotSeen.loaded(subjectId, unitId, image.toMs)}
        />
      ) : null}
    </span>
  );
});
