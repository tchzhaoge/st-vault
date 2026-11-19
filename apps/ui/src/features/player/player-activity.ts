/** Pointer activity owns a single deadline, independent of media/loading state. */
export class PlayerActivity {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interactive = false;
  constructor(
    private readonly onVisible: (visible: boolean) => void,
    private readonly delayMs = 1000,
  ) {}
  wake(): void {
    clearTimeout(this.timer);
    this.onVisible(true);
    if (!this.interactive) this.timer = setTimeout(() => this.onVisible(false), this.delayMs);
  }
  setInteractive(inside: boolean): void {
    if (inside === this.interactive) return;
    this.interactive = inside;
    this.wake();
  }
  hide(): void {
    this.interactive = false;
    clearTimeout(this.timer);
    this.onVisible(false);
  }
  dispose(): void {
    this.interactive = false;
    clearTimeout(this.timer);
  }
}
