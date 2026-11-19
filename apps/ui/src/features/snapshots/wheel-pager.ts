/** Normalize wheel/trackpad bursts into bounded page intents, not a scroll list. */
export class WheelPager {
  private delta = 0;
  private observedAt = -Infinity;
  private turnedAt = -Infinity;
  step(delta: number, mode: number, height: number, now: number): -1 | 0 | 1 {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    if (now - this.observedAt > 180 || Math.sign(delta) !== Math.sign(this.delta)) this.delta = 0;
    this.observedAt = now;
    if (now - this.turnedAt < 220) return 0;
    this.delta += delta * (mode === 1 ? 16 : mode === 2 ? Math.max(80, height) : 1);
    if (Math.abs(this.delta) < 80) return 0;
    const direction = this.delta > 0 ? 1 : -1;
    this.delta = 0;
    this.turnedAt = now;
    return direction;
  }
}
