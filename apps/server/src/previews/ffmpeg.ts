import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, setPriority } from 'node:os';

export interface DecodeInput {
  paths: readonly string[];
  offsetSeconds: number;
  endSeconds: number;
  signal: AbortSignal;
}
export type SnapshotDecoder = (input: DecodeInput) => Promise<Uint8Array>;
export class SnapshotDecodeError extends Error {
  constructor(readonly code: 'no_frame' | 'unavailable' | 'failed') {
    super('SNAPSHOT_DECODE_FAILED');
  }
}
let priorityWarningLogged = false;
export function jpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  );
}
export function decoderArgs(offsetSeconds: number, endSeconds: number): string[] {
  if (
    !Number.isFinite(offsetSeconds) ||
    offsetSeconds < 0 ||
    !Number.isFinite(endSeconds) ||
    endSeconds <= offsetSeconds ||
    endSeconds - offsetSeconds > 60
  )
    throw new SnapshotDecodeError('failed');
  // Default FFmpeg timestamp rebasing retains the elapsed time of dropped
  // leading non-keyframes. Never set STARTPTS from the first decoded frame.
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-max_alloc',
    '67108864',
    '-max_pixels',
    '8294400',
    '-protocol_whitelist',
    'pipe',
    '-f',
    'mp4',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `trim=start=${offsetSeconds.toFixed(6)}:end=${endSeconds.toFixed(6)},scale=320:180:force_original_aspect_ratio=decrease`,
    '-frames:v',
    '1',
    '-fps_mode',
    'passthrough',
    '-threads',
    '1',
    '-q:v',
    '5',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ];
}
export function createFfmpegDecoder(
  options: {
    ffmpegPath?: string;
    launch?: (args: string[]) => ChildProcessWithoutNullStreams;
  } = {},
): SnapshotDecoder {
  return async (input) => {
    if (input.signal.aborted || !input.paths.length) throw new SnapshotDecodeError('failed');
    const args = decoderArgs(input.offsetSeconds, input.endSeconds);
    const child = options.launch
      ? options.launch(args)
      : spawn(options.ffmpegPath ?? 'ffmpeg', args, {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
      } catch (error) {
        if (!priorityWarningLogged) {
          priorityWarningLogged = true;
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`Unable to lower snapshot decoder priority: ${reason}`);
        }
      }
    }
    const parts: Buffer[] = [];
    let size = 0,
      failed = false,
      spawnFailed = false,
      inputFailed = false;
    const stop = (): void => {
      failed = true;
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const finished = new Promise<void>((resolve, reject) => {
      child.once('error', () => {
        failed = true;
        spawnFailed = true;
      });
      child.once('close', (code) =>
        code === 0 && !failed && !inputFailed
          ? resolve()
          : reject(new SnapshotDecodeError(spawnFailed ? 'unavailable' : 'failed')),
      );
    });
    void finished.catch(() => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) stop();
      else parts.push(chunk);
    });
    child.stderr.resume(); // Drain diagnostics, never retain paths or media messages.
    input.signal.addEventListener('abort', stop, { once: true });
    async function* media(): AsyncGenerator<Buffer> {
      let total = 0;
      for (const filename of input.paths) {
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
          throw new Error('SNAPSHOT_DECODE_FAILED');
        const handle = await open(filename, 'r');
        try {
          const actual = await handle.stat();
          if (actual.dev !== info.dev || actual.ino !== info.ino || actual.size !== info.size)
            throw new Error('SNAPSHOT_DECODE_FAILED');
          for await (const value of handle.createReadStream({
            autoClose: false,
            highWaterMark: 65536,
          })) {
            const chunk = value as Buffer;
            total += chunk.length;
            if (total > 24 * 1024 * 1024 || input.signal.aborted)
              throw new Error('SNAPSHOT_DECODE_FAILED');
            yield chunk;
          }
        } finally {
          await handle.close();
        }
      }
    }
    const writing = pipeline(Readable.from(media(), { objectMode: false }), child.stdin).catch(
      (error: unknown) => {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
        // FFmpeg may close stdin as soon as its one requested image is ready.
        if (!['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(String(code))) {
          inputFailed = true;
          if (child.exitCode === null && child.signalCode === null) stop();
        }
      },
    );
    try {
      await finished;
      await writing;
      if (inputFailed || input.signal.aborted) throw new SnapshotDecodeError('failed');
      const bytes = Buffer.concat(parts);
      if (!bytes.length) throw new SnapshotDecodeError('no_frame');
      if (!jpeg(bytes)) throw new SnapshotDecodeError('failed');
      return bytes;
    } finally {
      input.signal.removeEventListener('abort', stop);
      stop();
      await Promise.allSettled([finished, writing]);
    }
  };
}

/** A successful encoder exit/header is insufficient: decode the JPEG to a tiny raster. */
export async function verifyJpeg(
  bytes: Uint8Array,
  signal: AbortSignal,
  options: {
    ffmpegPath?: string;
    launch?: (args: string[]) => ChildProcessWithoutNullStreams;
  } = {},
): Promise<void> {
  if (signal.aborted || !jpeg(bytes) || bytes.length > 512 * 1024)
    throw new SnapshotDecodeError('failed');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-xerror',
    '-nostdin',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-max_alloc',
    '67108864',
    '-max_pixels',
    '8294400',
    '-f',
    'mjpeg',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0',
    '-an',
    '-frames:v',
    '1',
    '-vf',
    'scale=16:16',
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
  const child = options.launch
    ? options.launch(args)
    : spawn(options.ffmpegPath ?? 'ffmpeg', args, {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
  let count = 0,
    failed = false,
    unavailable = false;
  const stop = (): void => {
    failed = true;
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  if (child.pid !== undefined)
    try {
      setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (error) {
      if (!priorityWarningLogged) {
        priorityWarningLogged = true;
        console.warn(
          'Unable to lower JPEG validation priority',
          error instanceof Error ? error.name : 'unknown',
        );
      }
    }
  const timer = setTimeout(stop, 5000);
  signal.addEventListener('abort', stop, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    count += chunk.length;
    if (count > 256) stop();
  });
  child.stderr.resume();
  child.stdin.on('error', () => {
    failed = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => {
        failed = true;
        unavailable = true;
      });
      child.once('close', (code) =>
        code === 0 && !failed && count === 256
          ? resolve()
          : reject(new SnapshotDecodeError(unavailable ? 'unavailable' : 'failed')),
      );
      child.stdin.end(bytes);
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    stop();
  }
}
