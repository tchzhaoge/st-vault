import { MEDIA_MOTION } from '../../design/layout-motion';

/** Page navigation owns a single bounded pair of surfaces. Live updates still
 * use keyed card motion; a new page moves as one surface, never thirty fades. */
export class SnapshotPageMotion {
  private scope = '';
  private page = 0;
  private nodes: HTMLElement[] = [];
  private animations: Animation[] = [];
  private exit: HTMLElement | null = null;

  update(root: HTMLElement, scope: string, page: number): void {
    if (scope !== this.scope) {
      this.clear();
      this.scope = scope;
    }
    if (this.page && page && page !== this.page && typeof root.animate === 'function') {
      this.cancel();
      const direction = Math.sign(page - this.page);
      const exit = document.createElement('div');
      exit.className = 'snapshot-page-exit snapshot-exits';
      exit.inert = true;
      exit.setAttribute('aria-hidden', 'true');
      for (const previous of this.nodes) {
        // Detached images retain decoded pixels even when UnitImage releases
        // its URL. Do not clone images or issue another image request.
        const node = previous.isConnected ? (previous.cloneNode(true) as HTMLElement) : previous;
        for (const animation of node.getAnimations()) animation.cancel();
        if (node.classList.contains('snapshot-cell'))
          node.classList.replace('snapshot-cell', 'snapshot-ghost');
        for (const element of [node, ...node.querySelectorAll<HTMLElement>('*')])
          for (const attr of [
            'data-key',
            'data-at',
            'data-unit-index',
            'data-motion-key',
            'aria-current',
          ])
            element.removeAttribute(attr);
        exit.append(node);
      }
      root.parentElement!.append(exit);
      this.exit = exit;
      this.animations = [
        root.animate(
          [{ transform: `translateY(${direction * 100}%)` }, { transform: 'translateY(0%)' }],
          { ...MEDIA_MOTION, id: 'snapshot-page-enter' },
        ),
        exit.animate(
          [{ transform: 'translateY(0%)' }, { transform: `translateY(${-direction * 100}%)` }],
          { ...MEDIA_MOTION, id: 'snapshot-page-exit' },
        ),
      ];
      this.animations[1].onfinish = () => this.cancel();
    }
    this.page = page;
    this.nodes = [...root.children] as HTMLElement[];
  }

  private cancel(): void {
    for (const animation of this.animations) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.animations = [];
    this.exit?.remove();
    this.exit = null;
  }

  clear(): void {
    this.cancel();
    this.nodes = [];
    this.scope = '';
    this.page = 0;
  }
}
