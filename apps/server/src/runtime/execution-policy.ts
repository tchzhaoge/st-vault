import { readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';

const MIB = 1024 ** 2;
const bounded = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, Math.floor(value)));

export interface ExecutionPolicy {
  cpuCount: number;
  memoryBytes: number;
  ioConcurrency: number;
  networkConcurrency: number;
  nodeHeapMb: number;
  previews: {
    decoderConcurrency: number;
    networkConcurrency: number;
    readConcurrency: number;
    publishConcurrency: number;
  };
  live: {
    openConcurrency: number;
    manifestConcurrency: number;
    mediaConcurrency: number;
    maxRequests: number;
    maxSessions: number;
    maxOwnerSessions: number;
  };
  status: { publicConcurrency: number; monitorConcurrency: number };
  archive: { backgroundConcurrency: number; gcConcurrency: number; hashConcurrency: number };
  database: {
    interactiveConnections: number;
    backgroundConnections: number;
    playbackConnections: number;
    writerConnections: number;
    snapshotConnections: number;
    jobsInteractiveConnections: number;
    jobsBackgroundConnections: number;
    maxConnections: number;
    sharedBuffersMb: number;
    workMemMb: number;
    maintenanceWorkMemMb: number;
  };
}

interface Inputs {
  cpuCount: number;
  memoryBytes: number;
  decoderConcurrency?: number;
  ioConcurrency?: number;
  networkConcurrency?: number;
}

/** Pure planning: resource classes have different costs; they are not one global semaphore. */
export function deriveExecutionPolicy(input: Inputs): ExecutionPolicy {
  if (
    !Number.isFinite(input.cpuCount) ||
    input.cpuCount <= 0 ||
    !Number.isSafeInteger(input.memoryBytes) ||
    input.memoryBytes < 256 * MIB
  )
    throw Error('INVALID_EXECUTION_RESOURCES');
  for (const value of [input.decoderConcurrency, input.ioConcurrency, input.networkConcurrency])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 256))
      throw Error('INVALID_EXECUTION_CONCURRENCY');
  const cpu = Math.max(1, Math.floor(input.cpuCount));
  const memoryMb = Math.floor(input.memoryBytes / MIB);
  const io = input.ioConcurrency ?? bounded(cpu * 2, 4, 32);
  const network = input.networkConcurrency ?? bounded(cpu * 4, 8, 64);
  // A decoder includes native frame buffers, not just its small output JPEG.
  // Reserve the rest for shared media, V8, PostgreSQL and concurrent I/O.
  const decoderMemorySlots = Math.max(1, Math.floor((memoryMb * 3) / 8 / 256));
  const decoders = Math.min(
    input.decoderConcurrency ?? bounded(cpu / 2, 1, 16),
    decoderMemorySlots,
    64,
  );
  const interactive = bounded(cpu * 2, 4, 16);
  const background = bounded(cpu / 4, 2, 4);
  const playback = bounded(Math.ceil(cpu / 4), 2, 4);
  const snapshots = bounded(cpu / 2, 4, 8);
  const jobsInteractive = bounded(cpu / 2, 2, 4);
  const jobsBackground = bounded(cpu / 4, 1, 4);
  return {
    cpuCount: input.cpuCount,
    memoryBytes: input.memoryBytes,
    ioConcurrency: io,
    networkConcurrency: network,
    nodeHeapMb: bounded(memoryMb / 8, 256, 2048),
    previews: {
      decoderConcurrency: decoders,
      networkConcurrency: bounded(network / 2, 1, 64),
      readConcurrency: Math.max(1, Math.floor(io / 2)),
      publishConcurrency: Math.max(1, Math.floor(io / 2)),
    },
    live: {
      openConcurrency: Math.max(1, Math.floor(network / 2)),
      manifestConcurrency: network,
      mediaConcurrency: network,
      maxRequests: network * 4,
      maxSessions: bounded(cpu * 4, 16, 128),
      maxOwnerSessions: bounded(cpu * 2, 4, 32),
    },
    status: {
      publicConcurrency: network,
      monitorConcurrency: Math.max(1, Math.floor(network / 2)),
    },
    // Physical cleanup competes with capture and playback on the same disk.
    // Allocate a share of I/O, preserving capacity for the foreground paths.
    archive: {
      backgroundConcurrency: bounded(cpu / 2, 2, 8),
      gcConcurrency: bounded(io / 4, 1, 64),
      hashConcurrency: bounded(cpu / 4, 1, 8),
    },
    database: {
      interactiveConnections: interactive,
      backgroundConnections: background,
      playbackConnections: playback,
      writerConnections: 1,
      snapshotConnections: snapshots,
      jobsInteractiveConnections: jobsInteractive,
      jobsBackgroundConnections: jobsBackground,
      // Private settings need two connections; management/recovery reserve eight.
      maxConnections: Math.max(
        32,
        Math.ceil(
          (interactive +
            background +
            playback +
            snapshots +
            jobsInteractive +
            jobsBackground +
            11) /
            16,
        ) * 16,
      ),
      sharedBuffersMb: bounded(memoryMb / 16, 128, 1024),
      workMemMb: memoryMb >= 8192 ? 8 : 4,
      maintenanceWorkMemMb: bounded(memoryMb / 64, 64, 256),
    },
  };
}

export function cpuQuota(value: string): number | undefined {
  const [quota, period] = value.trim().split(/\s+/);
  if (quota === 'max') return undefined;
  const numerator = Number(quota),
    denominator = Number(period);
  return numerator > 0 && denominator > 0 && Number.isFinite(numerator / denominator)
    ? numerator / denominator
    : undefined;
}

function readQuota(filename: string): string | undefined {
  try {
    return readFileSync(filename, 'utf8');
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR'].includes(String(error.code))
    ))
      console.warn(
        JSON.stringify({
          event: 'execution_resource_probe_failed',
          code: error instanceof Error && 'code' in error ? error.code : 'UNKNOWN',
        }),
      );
    return undefined;
  }
}

let cached: ExecutionPolicy | undefined;
export function getExecutionPolicy(): ExecutionPolicy {
  if (cached) return cached;
  let cpu = availableParallelism();
  if (process.platform === 'linux') {
    const v2 = readQuota('/sys/fs/cgroup/cpu.max');
    const quota =
      v2 === undefined
        ? cpuQuota(
            `${readQuota('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') ?? 'max'} ${readQuota('/sys/fs/cgroup/cpu/cpu.cfs_period_us') ?? '100000'}`,
          )
        : cpuQuota(v2);
    if (quota !== undefined) cpu = Math.min(cpu, quota);
  }
  const constrained = process.constrainedMemory();
  const override = (name: string): number | undefined =>
    process.env[name]?.trim() ? Number(process.env[name]) : undefined;
  cached = deriveExecutionPolicy({
    cpuCount: cpu,
    memoryBytes: constrained > 0 ? Math.min(constrained, totalmem()) : totalmem(),
    decoderConcurrency: override('STV_DECODE_WORKERS'),
    ioConcurrency: override('STV_IO_WORKERS'),
    networkConcurrency: override('STV_NETWORK_WORKERS'),
  });
  return cached;
}
