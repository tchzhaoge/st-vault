/** Logical owners share immutable download buffers. Cost changes only at the
 * first retain and last release, rather than rescanning every producer ring. */
export class ByteLedger {
  private readonly references = new Map<Uint8Array, number>();
  private total = 0;
  get bytes(): number {
    return this.total;
  }
  retain(bytes: Uint8Array): void {
    const count = this.references.get(bytes) ?? 0;
    if (!count) this.total += bytes.byteLength;
    this.references.set(bytes, count + 1);
  }
  release(bytes: Uint8Array): void {
    const count = this.references.get(bytes);
    if (count === undefined) throw Error('UNOWNED_INGRESS_BUFFER');
    if (count === 1) {
      this.references.delete(bytes);
      this.total -= bytes.byteLength;
    } else this.references.set(bytes, count - 1);
  }
}
