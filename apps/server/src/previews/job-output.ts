import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { jpeg } from './ffmpeg.js';
import type { AtomicDerivativeWriter } from './atomic-derivative.js';
import { ioCode } from './derivative-diagnostics.js';

export interface SnapshotFrame {
  bytes: Uint8Array;
  throughMs: number;
  mediaIds?: string[];
}
interface ArtifactJob {
  readonly subject: string;
  readonly unit: string;
  readonly at: number;
  readonly end: number;
}
export const snapshotDigest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export const validSnapshotMediaIds = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 600 &&
  value.every((id) => typeof id === 'string' && id.length > 0);

/** Artifact I/O borrows the queue's writer; ownership and durable state stay in its caller. */
export class SnapshotJobOutput {
  constructor(
    private readonly writer: AtomicDerivativeWriter,
    private readonly filename: (job: ArtifactJob) => string,
    private readonly library: boolean,
    private readonly validate: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>,
  ) {}
  async adopt(job: ArtifactJob, signal: AbortSignal): Promise<SnapshotFrame | null> {
    if (!this.library) return null;
    const filename = this.filename(job);
    try {
      const info = await lstat(filename);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 512 * 1024 ||
        (await realpath(filename)) !== path.resolve(filename)
      )
        throw Error('INVALID_SCREENSHOT');
      const bytes = await readFile(filename),
        sidecar = await lstat(filename + '.json');
      if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.size > 65536)
        throw Error('INVALID_SCREENSHOT');
      const metadata = JSON.parse(await readFile(filename + '.json', 'utf8')) as {
        hash: string;
        throughMs: number;
        mediaIds: string[];
      };
      if (
        !jpeg(bytes) ||
        metadata.hash !== snapshotDigest(bytes) ||
        !validSnapshotMediaIds(metadata.mediaIds) ||
        !Number.isFinite(metadata.throughMs)
      )
        throw Error('INVALID_SCREENSHOT');
      await this.validate(bytes, signal);
      return { bytes, throughMs: metadata.throughMs, mediaIds: metadata.mediaIds };
    } catch (error) {
      if (
        ioCode(error) === 'ENOENT' ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === 'INVALID_SCREENSHOT')
      )
        return null;
      throw error;
    }
  }
  private async discard(filenames: string[]): Promise<void> {
    for (const filename of filenames)
      try {
        await unlink(filename);
      } catch (error) {
        if (ioCode(error) !== 'ENOENT') throw error;
      }
  }
  async publish(
    job: ArtifactJob,
    frame: Readonly<SnapshotFrame>,
    current: () => Promise<boolean>,
    source: () => Promise<boolean>,
  ): Promise<Uint8Array | null> {
    const filename = this.filename(job),
      directory = path.dirname(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw Error('UNSAFE_SCREENSHOT_PATH');
    const beforePublish = async () => {
      if (!(await current()))
        throw Object.assign(Error('Screenshot publication cancelled'), { name: 'AbortError' });
    };
    await this.writer.write(filename, frame.bytes, { sync: true, beforePublish });
    // Invalidation can complete while an asynchronous rename is in flight.
    if (!(await current())) {
      await this.discard([filename]);
      return null;
    }
    const disk = await readFile(filename);
    if (snapshotDigest(disk) !== snapshotDigest(frame.bytes))
      throw Error('SCREENSHOT_WRITE_MISMATCH');
    if (!(await source())) return null;
    if (this.library) {
      await this.writer.write(
        filename + '.json',
        Buffer.from(
          JSON.stringify({
            hash: snapshotDigest(disk),
            throughMs: frame.throughMs,
            mediaIds: frame.mediaIds,
          }),
        ),
        { sync: true, beforePublish },
      );
      if (!(await current())) {
        await this.discard([filename, filename + '.json']);
        return null;
      }
    }
    return disk;
  }
}
