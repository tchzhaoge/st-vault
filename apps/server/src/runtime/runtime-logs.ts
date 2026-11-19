import { AsyncLocalStorage } from 'node:async_hooks';
import { Writable } from 'node:stream';
import { constants, appendFileSync } from 'node:fs';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'node:util';

export const logContext = new AsyncLocalStorage<{ requestId: string }>();
export let runtimeLogDestination: Writable | undefined;
const secretField =
  /password|cookie|authorization|secret|token|psch|pkey|signature|captcha|passcode|verificationCode|^(?:keys|key|headers|body|otp|totp|otpCode|totpCode|oneTimeCode|pin|confirmPin|stv_setup)$/i;
function cleanText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/g, (address) => {
      try {
        return `${new URL(address).origin}/[redacted]`;
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/\b(?:Bearer\s+)[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b((?:stv_next|stv_setup|cf_clearance|password|cookie|token|secret|authorization|psch|pkey|otp|captcha|passcode|verificationCode|pin|confirmPin)\s*[=:]\s*)[^\s;,]+/gi,
      '$1[redacted]',
    );
}
export function redactLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') return cleanText(value).slice(0, 32768);
  if (value instanceof Error)
    return {
      type: value.name,
      message: cleanText(value.message),
      stack: cleanText(value.stack ?? ''),
      cause: redactLog(value.cause, depth + 1, seen),
      ...(value instanceof AggregateError
        ? { errors: redactLog(value.errors, depth + 1, seen) }
        : {}),
    };
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactLog(item, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        secretField.test(key) ? '[redacted]' : redactLog(item, depth + 1, seen),
      ]),
  );
}
interface LogOptions {
  directory: string;
  role: 'app' | 'supervisor' | 'launcher';
  maxBytes?: number;
  maxFiles?: number;
  maxQueuedBytes?: number;
  mirror?: (line: string) => void;
}
/** Serialized asynchronous writes preserve ordering; rotation never runs on the media path. */
export function createRuntimeLog(options: LogOptions): Writable {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024,
    maxFiles = options.maxFiles ?? 8,
    maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 256 ||
    maxBytes > 100 * 1024 * 1024 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 32 ||
    !Number.isSafeInteger(maxQueuedBytes) ||
    maxQueuedBytes < 256 ||
    maxQueuedBytes > 16 * 1024 * 1024
  )
    throw Error('INVALID_LOG_LIMITS');
  const file = path.join(options.directory, `${options.role}.jsonl`);
  let handle: FileHandle | undefined,
    size = 0,
    failures = 0,
    retryAt = 0,
    persistenceDropped = 0;
  const mirror =
    options.mirror ??
    ((line: string) => {
      process.stdout.write(line);
    });
  const normalize = (line: string): string => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = { message: line };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      value = { message: String(value) };
    const fields = value as Record<string, unknown>;
    // Existing modules emit JSON through console; retain those event fields.
    if (typeof fields.message === 'string' && fields.message.startsWith('{')) {
      try {
        const inner: unknown = JSON.parse(fields.message);
        if (inner && typeof inner === 'object' && !Array.isArray(inner))
          Object.assign(fields, inner, { message: undefined });
      } catch {
        /* Ordinary text, not a structured event. */
      }
    }
    const level =
      typeof fields.level === 'number'
        ? ((
            {
              10: 'trace',
              20: 'debug',
              30: 'info',
              40: 'warn',
              50: 'error',
              60: 'fatal',
            } as Record<number, string>
          )[fields.level] ?? 'info')
        : (fields.level ?? 'info');
    return (
      JSON.stringify(
        redactLog({
          ...fields,
          level,
          at: new Date().toISOString(),
          role: options.role,
          pid: process.pid,
          requestId: fields.requestId ?? fields.reqId,
        }),
      ) + '\n'
    );
  };
  const write = async (data: string): Promise<void> => {
    if (!handle) {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      size = (await handle.stat()).size;
    }
    if (size && size + Buffer.byteLength(data) > maxBytes) {
      await handle.close();
      handle = undefined;
      if (maxFiles === 1) await rm(file, { force: true });
      else {
        await rm(`${file}.${maxFiles - 1}`, { force: true });
        for (let index = maxFiles - 2; index >= 0; index--) {
          try {
            await rename(index ? `${file}.${index}` : file, `${file}.${index + 1}`);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
              throw error;
          }
        }
      }
      handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      size = 0;
    }
    await handle.writeFile(data);
    size += Buffer.byteLength(data);
  };
  // Console and HTTP writers cannot await disk backpressure. Admit synchronously
  // into our own byte budget instead of retaining arbitrary Writable chunks.
  const queue: { data: string; size: number }[] = [];
  let queuedBytes = 0,
    dropped = 0,
    pumping: Promise<void> | undefined;
  const pump = (): void => {
    if (pumping) return;
    pumping = (async () => {
      while (queue.length || dropped) {
        const item = queue.shift();
        const representedRecords = item ? 1 : dropped;
        let data: string;
        if (item) data = item.data;
        else {
          data = normalize(JSON.stringify({ event: 'log_queue_overflow', level: 'warn', dropped }));
          dropped = 0;
          mirror(data);
        }
        try {
          await write(data);
          if (failures) {
            const recovered = normalize(
              JSON.stringify({
                event: 'log_persistence_recovered',
                level: 'warn',
                failures,
                dropped: persistenceDropped,
              }),
            );
            await write(recovered);
            mirror(recovered);
            failures = 0;
            persistenceDropped = 0;
            retryAt = 0;
          }
        } catch (error) {
          failures++;
          retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
          persistenceDropped += representedRecords + queue.length + dropped;
          queue.length = 0;
          dropped = 0;
          queuedBytes = item?.size ?? 0;
          let closeError: unknown;
          try {
            await handle?.close();
          } catch (cause) {
            closeError = redactLog(cause);
          }
          handle = undefined;
          mirror(
            normalize(
              JSON.stringify({
                event: 'log_persistence_failed',
                level: 'error',
                error: redactLog(error),
                failures,
                retryAt,
                ...(closeError ? { closeError } : {}),
              }),
            ),
          );
        } finally {
          if (item) queuedBytes -= item.size;
        }
      }
    })().finally(() => {
      pumping = undefined;
      if (queue.length || dropped) pump();
    });
  };
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const data = chunk.toString('utf8').split('\n').filter(Boolean).map(normalize).join('');
      mirror(data);
      const size = Buffer.byteLength(data);
      const critical = /"level":"(?:warn|error|fatal)"/.test(data);
      const ceiling = critical
        ? maxQueuedBytes
        : maxQueuedBytes - Math.min(65536, Math.floor(maxQueuedBytes / 4));
      // Retry eligibility is driven by later log traffic, never a timer or a
      // producer wait. A broken disk therefore cannot create an unbounded queue.
      if (Date.now() < retryAt) persistenceDropped++;
      else if (size <= ceiling - queuedBytes) {
        queue.push({ data, size });
        queuedBytes += size;
      } else dropped++;
      pump();
      callback(); // The bounded persistence queue owns completion, not the producer.
    },
    final(callback) {
      void (async () => {
        while (pumping) await pumping;
        if (!failures) await handle?.sync();
        await handle?.close();
      })().then(() => callback(), callback);
    },
  });
}

/** A blocked Docker pipe must not become a second unbounded logging queue. */
export function boundedLogMirror(
  write: (line: string) => boolean,
  pendingBytes: () => number,
  onDrain: (listener: () => void) => void,
  budget = 1024 * 1024,
): (line: string) => void {
  let dropped = 0,
    watching = false;
  const flush = (): void => {
    if (!dropped) return;
    const summary =
      JSON.stringify({
        event: 'log_stdout_overflow',
        level: 'warn',
        dropped,
        at: new Date().toISOString(),
      }) + '\n';
    if (Buffer.byteLength(summary) > budget - pendingBytes()) return;
    dropped = 0;
    write(summary);
  };
  return (line) => {
    flush();
    if (Buffer.byteLength(line) <= budget - pendingBytes()) write(line);
    else {
      dropped++;
      if (pendingBytes() === 0) flush();
      else if (!watching) {
        watching = true;
        onDrain(() => {
          watching = false;
          flush();
        });
      }
    }
  };
}
export function installRuntimeLogs(directory: string, role: 'app' | 'supervisor'): void {
  if (runtimeLogDestination) throw Error('LOGGING_ALREADY_INITIALIZED');
  const output = process.stdout.write.bind(process.stdout);
  const sink = (runtimeLogDestination = createRuntimeLog({
    directory,
    role,
    maxBytes: Number(process.env.STV_LOG_MAX_MB ?? 10) * 1024 * 1024,
    maxFiles: Number(process.env.STV_LOG_FILES ?? 8),
    mirror: boundedLogMirror(
      output,
      () => process.stdout.writableLength,
      (listener) => process.stdout.once('drain', listener),
    ),
  }));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...values: unknown[]): void => {
      sink.write(
        JSON.stringify({
          level: level === 'log' ? 'info' : level,
          ...logContext.getStore(),
          message: format(...values.map((value) => redactLog(value))),
        }) + '\n',
      );
    };
  }
  process.on('uncaughtExceptionMonitor', (error) => {
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        level: 'fatal',
        event: 'uncaught_exception',
        role,
        error: redactLog(error),
      }) + '\n';
    output(line);
    try {
      appendFileSync(path.join(directory, `${role}.jsonl`), line, { mode: 0o600 });
    } catch (cause) {
      output(JSON.stringify({ event: 'fatal_log_write_failed', error: redactLog(cause) }) + '\n');
    }
  });
  console.info(
    JSON.stringify({
      event: 'logging_initialized',
      maxBytes: Number(process.env.STV_LOG_MAX_MB ?? 10) * 1024 * 1024,
      maxFiles: Number(process.env.STV_LOG_FILES ?? 8),
    }),
  );
}
export async function closeRuntimeLogs(): Promise<void> {
  const sink = runtimeLogDestination;
  if (!sink || sink.writableFinished) return;
  await new Promise<void>((resolve, reject) => {
    sink.once('error', reject);
    sink.end(resolve);
  });
}
