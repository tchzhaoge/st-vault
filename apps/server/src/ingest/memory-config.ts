const MIB = 1024 ** 2;
/** Leave room for JS, PostgreSQL, HTTP, and the separate FFmpeg screenshot process. */
export function ingressMemoryBytes(value?: string, limit = process.constrainedMemory()): number {
  const automatic = Math.min(4096 * MIB, limit > 0 ? Math.floor(limit / 3) : 4096 * MIB);
  const bytes = value?.trim() ? Number(value) * MIB : automatic;
  if (!Number.isSafeInteger(bytes) || bytes < 18 * MIB || (limit > 0 && bytes > limit - 256 * MIB))
    throw new Error(
      'INVALID_STV_INGRESS_MEMORY_MB: use at least 18 MiB and leave 256 MiB of container headroom',
    );
  return bytes;
}
