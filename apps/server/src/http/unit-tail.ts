import type { ArchivePort } from '../ports.js';
import type { SyncClock } from '../runtime/sync-clock.js';

/** Wait for a growing selected unit, not for an unrelated next recording. */
export async function waitUnitTail(
  archive: ArchivePort,
  clock: SyncClock,
  subject: string,
  unit: string,
  at: number,
  signal: AbortSignal,
) {
  let wake: () => void = () => undefined;
  const detach = archive.subscribeMedia?.((change) => {
    const id = change.kind === 'commit' ? change.segment.subjectId : change.subjectId;
    if (id === subject) wake();
  });
  const detachClock = clock.subscribe(`unit-tail:${crypto.randomUUID()}`, () => wake());
  const changed = () => wake();
  signal.addEventListener('abort', changed);
  try {
    while (!signal.aborted) {
      let notify!: () => void;
      const pending = new Promise<void>((resolve) => {
        notify = resolve;
      });
      wake = notify;
      const range = await archive.unitRange!(subject, unit);
      if (!range || range.toMs > at || !range.open) return range;
      await pending;
    }
    signal.throwIfAborted();
  } finally {
    detach?.();
    detachClock();
    signal.removeEventListener('abort', changed);
  }
  return null;
}
