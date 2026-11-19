import type { SnapshotPagesResponse } from '@st-vault/api-schema';

/** One read owner gates both request order and monotonic archive visibility. */
export class SnapshotViewController {
  private generation = 0;
  private readonly deletions = new Map<string, number>();
  invalidate(): number {
    return ++this.generation;
  }
  current(generation: number): boolean {
    return generation === this.generation;
  }
  accept(generation: number, packet: SnapshotPagesResponse): boolean {
    if (!this.current(generation)) return false;
    const previous = this.deletions.get(packet.subjectId) ?? -1;
    if (packet.deletionRevision < previous) return false;
    this.deletions.delete(packet.subjectId);
    this.deletions.set(packet.subjectId, packet.deletionRevision);
    if (this.deletions.size > 64) this.deletions.delete(this.deletions.keys().next().value!);
    return true;
  }
}
