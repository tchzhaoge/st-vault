import { tr } from '../../shared/lib/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { coverImages, type ImagePriority } from '../../shared/lib/image-loader';
import { getSyncIntervalMs } from '../../shared/lib/sync';
import { Icon } from '../../design/Icon';

export function CoverImage({
  id,
  revision,
  status,
  priority = 'visible',
  children,
  variant = 'cover',
}: {
  id: string;
  revision: number;
  status: string;
  priority?: ImagePriority;
  children?: ReactNode;
  variant?: 'cover' | 'avatar';
}): JSX.Element {
  const src = `/api/subjects/${encodeURIComponent(id)}/${variant}.jpg`;
  const [image, setImage] = useState(() => {
    const blob = coverImages.peek(src);
    return { id, blob, url: blob ? URL.createObjectURL(blob) : '' };
  });
  const current = useRef(image);
  current.current = image;
  const [loading, setLoading] = useState(!image.url),
    [message, setMessage] = useState('');
  useEffect(
    () => () => {
      if (image.url) URL.revokeObjectURL(image.url);
    },
    [image.url],
  );
  useEffect(() => {
    const controller = new AbortController();
    let candidate = '',
      retry: number | undefined;
    setLoading(true);
    setMessage('');
    const load = async (attempt = 0): Promise<void> => {
      try {
        const blob = await coverImages.load(src, controller.signal, priority, getSyncIntervalMs());
        if (controller.signal.aborted) return;
        if (current.current.id === id && current.current.blob === blob) {
          setLoading(false);
          return;
        }
        candidate = URL.createObjectURL(blob);
        const next = new Image();
        next.src = candidate;
        await next.decode();
        if (controller.signal.aborted) return;
        setImage({ id, blob, url: candidate });
        candidate = '';
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        coverImages.invalidate(src);
        if (variant === 'cover' && attempt < 2)
          retry = window.setTimeout(
            () => {
              void load(attempt + 1);
            },
            1500 * (attempt + 1),
          );
        else {
          setMessage(tr(variant === 'avatar' ? '头像暂不可用' : '封面暂不可用'));
          setLoading(false);
          if (variant === 'cover') console.warn('Cover image unavailable', error);
        }
      } finally {
        if (candidate) {
          URL.revokeObjectURL(candidate);
          candidate = '';
        }
      }
    };
    // Overscan is a preload zone. A fast scroll cancels it before network work starts.
    const delay =
      priority === 'prefetch'
        ? window.setTimeout(() => {
            void load();
          }, 100)
        : undefined;
    if (delay === undefined) void load();
    return () => {
      controller.abort();
      window.clearTimeout(delay);
      window.clearTimeout(retry);
    };
  }, [id, src, revision, status, priority, variant]);
  const url = image.id === id ? image.url : '';
  return (
    <span
      className={`track-cover-wrap${variant === 'avatar' ? ' subject-avatar' : ''}${loading && !url ? ' is-loading' : ''}`}
      aria-busy={loading}
    >
      {url ? (
        <img className="track-cover" src={url} alt="" decoding="async" />
      ) : (
        <span className="cover-placeholder" title={message}>
          {variant === 'avatar' ? <Icon name="user" /> : message}
        </span>
      )}
      {children}
    </span>
  );
}
