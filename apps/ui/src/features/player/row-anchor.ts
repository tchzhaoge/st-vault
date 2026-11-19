export interface RowAnchor {
  y: number;
  offscreen: 'above' | 'below' | 'filtered' | null;
}

/** Scroll geometry belongs to the connection, not the workspace business state. */
export class RowAnchorStore {
  private value: RowAnchor | null = null;
  private readonly listeners = new Set<() => void>();
  readonly snapshot = (): RowAnchor | null => this.value;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly set = (value: RowAnchor | null): void => {
    if (this.value?.y === value?.y && this.value?.offscreen === value?.offscreen) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  };
}
