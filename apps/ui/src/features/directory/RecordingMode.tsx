import { tr } from '../../shared/lib/i18n';
import { useRef, useState } from 'react';
import type { CaptureState, PublicStatus } from '@st-vault/api-schema';
import { messageFor } from '../../shared/lib/errors';
import { ProgressRing } from '../../shared/ui/ProgressRing';

export function RecordingMode({
  value,
  label,
  disabled = false,
  appearance = 'switch',
  onChange,
  captureState,
  providerStatus,
}: {
  value: boolean;
  label: string;
  disabled?: boolean;
  appearance?: 'switch' | 'record';
  onChange: (record: boolean) => Promise<void>;
  captureState?: CaptureState;
  providerStatus?: PublicStatus;
}): JSX.Element {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const pointer = useRef<{ x: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const current = pending ?? value;
  const recording =
    appearance === 'record'
      ? value === true && pending !== false && captureState === 'CAPTURING'
      : current === true;
  const starting =
    appearance === 'record' &&
    !recording &&
    (pending === true ||
      (current === true && ['QUEUED', 'RESOLVING'].includes(captureState ?? '')));
  const text =
    appearance === 'record' && recording
      ? tr('录制中')
      : pending !== null
        ? appearance === 'record'
          ? tr(pending ? '启动中' : '停止中')
          : tr('保存中')
        : appearance === 'record' && current === true
          ? recording
            ? tr('录制中')
            : starting
              ? tr(captureState === 'QUEUED' ? '等待录制名额' : '启动中')
              : tr(
                  captureState === 'BACKOFF'
                    ? '等待重试'
                    : providerStatus === 'PUBLIC'
                      ? '等待启动'
                      : '等待公开直播',
                )
          : current
            ? tr('已开启')
            : tr('已关闭');
  const description =
    appearance === 'record'
      ? `${tr(current ? '自动录制已开启' : '自动录制已关闭')} · ${text}`
      : text;
  async function save(record: boolean): Promise<void> {
    if (lock.current || disabled || record === value) return;
    lock.current = true;
    setPending(record);
    setError('');
    try {
      await onChange(record);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      lock.current = false;
      setPending(null);
    }
  }
  return (
    <span className={`recording-mode${appearance === 'record' ? ' recording-icon' : ''}`}>
      <button
        type="button"
        role="switch"
        className={`recording-toggle${appearance === 'record' ? ' record-button' : ''}${recording ? ' is-recording' : ''}${starting ? ' is-starting' : ''}`}
        disabled={disabled || pending !== null}
        aria-checked={current === true}
        aria-busy={starting || pending !== null}
        aria-label={label}
        aria-description={error || description}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (appearance === 'record') return;
          if (event.button !== 0) return;
          pointer.current = { x: event.clientX, moved: false };
          dragged.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pointer.current && Math.abs(event.clientX - pointer.current.x) >= 4)
            pointer.current.moved = true;
        }}
        onPointerUp={(event) => {
          if (pointer.current?.moved) {
            dragged.current = true;
            const box = event.currentTarget.getBoundingClientRect();
            void save(event.clientX >= box.left + box.width / 2);
          }
          pointer.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          pointer.current = null;
          dragged.current = true;
        }}
        onLostPointerCapture={() => {
          pointer.current = null;
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          void save(!current);
        }}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') dragged.current = false;
          if (
            ['ArrowLeft', 'ArrowDown', 'Home', 'ArrowRight', 'ArrowUp', 'End'].includes(event.key)
          ) {
            event.preventDefault();
            void save(['ArrowRight', 'ArrowUp', 'End'].includes(event.key));
          }
        }}
      >
        {starting || (appearance === 'record' && pending === false) ? <ProgressRing /> : <i />}
      </button>
      {error && (
        <span className="mode-error" role="alert" aria-label={error}>
          !
        </span>
      )}
    </span>
  );
}

export function GlobalRecordingSettings({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (record: boolean) => Promise<void>;
}): JSX.Element {
  return (
    <section className="global-recording-settings">
      <span>{tr('全部主播录制')}</span>
      <RecordingMode value={value} label={tr('全部主播是否录制')} onChange={onChange} />
    </section>
  );
}
