interface ShutdownOptions {
  closeProducers: () => Promise<void>;
  closeArchive: () => Promise<void>;
  deadlineMs?: number;
  forceExit?: () => void;
}
/** Start all cancellations before waiting; do not abandon slow writers on another close failure. */
export async function drainServices(services: readonly (() => unknown)[]): Promise<void> {
  const results = await Promise.allSettled(services.map((close) => Promise.resolve().then(close)));
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (errors.length) throw new AggregateError(errors, 'SERVICE_DRAIN_FAILED');
}
/** Never close metadata under live writers; a failed drain keeps the hard deadline. */
export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  let task: Promise<void> | undefined;
  return () => {
    task ??= (async () => {
      const deadline = setTimeout(
        options.forceExit ?? (() => process.exit(1)),
        options.deadlineMs ?? 60000,
      );
      deadline.unref();
      let finished = false;
      try {
        await options.closeProducers();
        await options.closeArchive();
        finished = true;
      } finally {
        if (finished) clearTimeout(deadline);
      }
    })();
    return task;
  };
}
