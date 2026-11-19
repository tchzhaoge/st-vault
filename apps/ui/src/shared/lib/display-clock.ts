/** Interpolate server UTC locally; sampling never triggers data synchronization. */
export class DisplayClock {
  private anchorAt: number;
  private lastSecond: number | undefined;
  constructor(
    private atMs: number,
    private readonly monotonic: () => number = () => performance.now(),
  ) {
    this.anchorAt = monotonic();
  }
  synchronize(atMs: number): void {
    this.atMs = atMs;
    this.anchorAt = this.monotonic();
  }
  now(): number {
    return Math.floor(this.atMs + Math.max(0, this.monotonic() - this.anchorAt));
  }
  sample(): number | null {
    const at = this.now(),
      second = Math.floor(at / 1000);
    if (second === this.lastSecond) return null;
    this.lastSecond = second;
    return at;
  }
}
