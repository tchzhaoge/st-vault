interface Message {
  id: number;
  method: string;
  input: unknown;
  backgroundRead?: boolean;
}
interface Reply {
  id: number;
  value?: unknown;
  error?: string;
  executionMs: number;
  handlerMs?: number;
  barrierMs?: number;
  slowestMethod?: string;
  slowestHandlerMs?: number;
}
interface Port {
  on(event: 'message', listener: (message: Message) => void): unknown;
  postMessage(reply: Reply): void;
  close(): void;
}
export function attachWorkerRpc(options: {
  port: Port;
  handlers: Record<string, (input: never) => unknown>;
  mutations: Set<string>;
  backgroundMutations?: Set<string>;
  transaction: (action: () => Promise<void>) => Promise<void>;
  savepoint: (sql: string) => Promise<void>;
  readTransaction?: <T>(
    action: () => Promise<T>,
    method: string,
    background: boolean,
  ) => Promise<T>;
  afterBatch: () => void | Promise<void>;
  commitHookPosition?: () => number;
  rollbackCommitHooks?: (position: number) => void;
}): void {
  const queue: Message[] = [],
    reads = new Set<Promise<void>>();
  let running = false,
    finishing = false,
    foregroundBatches = 0;
  const diagnostics = new Map<string, number>();
  const errorCode = (error: unknown, method: string): string => {
    if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) return error.message;
    const sqlState = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
    if (Date.now() - (diagnostics.get(sqlState) ?? 0) > 10000) {
      diagnostics.set(sqlState, Date.now());
      console.error(JSON.stringify({ event: 'metadata_operation_failed', method, sqlState }));
    }
    return 'METADATA_OPERATION_FAILED';
  };
  const dispatch = async (message: Message): Promise<unknown> => {
    const handler = options.handlers[message.method];
    if (typeof handler !== 'function') throw Error('UNKNOWN_METADATA_METHOD');
    return await handler(message.input as never);
  };
  const read = async (message: Message): Promise<void> => {
    const started = performance.now();
    try {
      const value = options.readTransaction
        ? await options.readTransaction(
            () => dispatch(message),
            message.method,
            message.backgroundRead === true,
          )
        : await dispatch(message);
      options.port.postMessage({ id: message.id, value, executionMs: performance.now() - started });
    } catch (error) {
      options.port.postMessage({
        id: message.id,
        error: errorCode(error, message.method),
        executionMs: performance.now() - started,
      });
    }
    await options.afterBatch();
  };
  const launchRead = (message: Message): void => {
    const work = read(message);
    reads.add(work);
    void work.then(
      () => reads.delete(work),
      (error: unknown) => {
        reads.delete(work);
        console.error('metadata_read_maintenance_failed', error);
        queueMicrotask(() => {
          throw error;
        });
      },
    );
  };
  const schedule = (): void => {
    if (running) return;
    running = true;
    setImmediate(() => {
      void drain().catch((error) => {
        console.error('metadata_dispatch_failed', error);
        options.port.close();
      });
    });
  };
  const drain = async (): Promise<void> => {
    try {
      if (queue[0]?.method === 'close') {
        const message = queue.shift()!,
          started = performance.now();
        await Promise.all([...reads]);
        try {
          const value = await dispatch(message);
          options.port.postMessage({
            id: message.id,
            value,
            executionMs: performance.now() - started,
          });
          options.port.close();
        } catch (error) {
          options.port.postMessage({
            id: message.id,
            error: errorCode(error, 'close'),
            executionMs: performance.now() - started,
          });
        }
        return;
      }
      const batch: Message[] = [];
      const background = (message: Message): boolean =>
        options.backgroundMutations?.has(message.method) === true;
      const foregroundIndex = queue.findIndex(
        (message) => message.method !== 'close' && !background(message),
      );
      const backgroundIndex = queue.findIndex(
        (message) => message.method !== 'close' && background(message),
      );
      // Maintenance owns one bounded transaction step, never an entire backlog.
      // User commands retain FIFO; every fourth foreground batch yields one
      // maintenance step so continuous interaction cannot starve recovery.
      const maintenance = backgroundIndex >= 0 && (foregroundIndex < 0 || foregroundBatches >= 4);
      if (maintenance) {
        batch.push(queue.splice(backgroundIndex, 1)[0]);
        foregroundBatches = 0;
      } else {
        while (batch.length < 16) {
          const index = queue.findIndex(
            (message) => message.method !== 'close' && !background(message),
          );
          if (index < 0) break;
          batch.push(queue.splice(index, 1)[0]);
        }
        foregroundBatches++;
      }
      const replies: Omit<Reply, 'executionMs'>[] = [],
        started = performance.now();
      let handlersMs = 0,
        slowestMethod = '',
        slowestHandlerMs = 0;
      try {
        await options.transaction(async () => {
          for (const message of batch) {
            const handlerStarted = performance.now(),
              hookPosition = options.commitHookPosition?.();
            await options.savepoint('SAVEPOINT rpc');
            try {
              const value = await dispatch(message);
              await options.savepoint('RELEASE rpc');
              replies.push({ id: message.id, value });
            } catch (error) {
              await options.savepoint('ROLLBACK TO rpc; RELEASE rpc');
              if (hookPosition !== undefined) options.rollbackCommitHooks?.(hookPosition);
              replies.push({ id: message.id, error: errorCode(error, message.method) });
            }
            const elapsed = performance.now() - handlerStarted;
            handlersMs += elapsed;
            if (elapsed > slowestHandlerMs) {
              slowestHandlerMs = elapsed;
              slowestMethod = message.method;
            }
            replies.at(-1)!.handlerMs = elapsed;
          }
        });
      } catch (error) {
        replies.splice(
          0,
          replies.length,
          ...batch.map((message) => ({ id: message.id, error: errorCode(error, message.method) })),
        );
      }
      const executionMs = performance.now() - started;
      for (const reply of replies)
        options.port.postMessage({
          ...reply,
          executionMs,
          barrierMs: Math.max(0, executionMs - handlersMs),
          slowestMethod,
          slowestHandlerMs,
        });
      await options.afterBatch();
    } finally {
      running = false;
      if (queue.length) schedule();
    }
  };
  options.port.on('message', (message) => {
    if (finishing) {
      options.port.postMessage({ id: message.id, error: 'METADATA_CLOSING', executionMs: 0 });
      return;
    }
    if (message.method === 'close') finishing = true;
    // Reads are independent from the moment of admission. A first read in the
    // same event-loop turn must not be swept into a later write's durable lock.
    if (message.method !== 'close' && !options.mutations.has(message.method)) launchRead(message);
    else {
      queue.push(message);
      schedule();
    }
  });
}
