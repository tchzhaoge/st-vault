type Box = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
export const MEDIA_MOTION = { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' };
/** Viewport eviction is not data deletion; only in-window removals need an exit. */
export function exitWithinViewport(index: number, from?: number, to?: number): boolean {
  return (
    from === undefined ||
    to === undefined ||
    !Number.isFinite(index) ||
    (index >= from && index < to)
  );
}
export function layoutDelta(first: Box, last: Box): { translate: string; scale: string } | null {
  if (first.width <= 0 || first.height <= 0 || last.width <= 0 || last.height <= 0) return null;
  const x = first.left - last.left + (first.width - last.width) / 2,
    y = first.top - last.top + (first.height - last.height) / 2;
  if (
    Math.abs(x) < 0.5 &&
    Math.abs(y) < 0.5 &&
    Math.abs(first.width - last.width) < 0.5 &&
    Math.abs(first.height - last.height) < 0.5
  )
    return null;
  return {
    translate: `${x}px ${y}px`,
    scale: `${first.width / last.width} ${first.height / last.height}`,
  };
}
interface Entry {
  node: HTMLElement;
  box: Box;
  opacity: number;
  animation?: Animation;
}
/** Keyed FLIP using individual transforms: selection scaling and parent timeline
 * panning keep their own transform. Exits retain decoded DOM, never refetch images. */
export class LayoutMotion {
  private entries = new Map<string, Entry>();
  private exits = new Set<HTMLElement>();
  private layer: HTMLElement | null = null;
  private known = new Set<string>();
  private scope = '';
  update(root: HTMLElement, scope: string, selector = '[data-motion-key]', animate = true): void {
    if (typeof root.animate !== 'function') return;
    if (this.scope !== scope) {
      this.clear();
      this.scope = scope;
    }
    const origin = root.getBoundingClientRect();
    if (
      origin.bottom < 0 ||
      origin.top > window.innerHeight ||
      origin.right < 0 ||
      origin.left > window.innerWidth
    ) {
      this.clear();
      return;
    }
    const all = [...root.querySelectorAll<HTMLElement>(selector)].filter(
      (node) => !node.closest('[data-motion-exit]'),
    );
    let nodes = all;
    if (root.classList.contains('snapshot-grid')) {
      // A fullscreen prefix may contain thousands of cached cards. Grid rows are
      // ordered, so measure only the visible neighborhood via binary search.
      const lower = (top: number): number => {
        let lo = 0,
          hi = all.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (all[mid].offsetTop < top) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      nodes = all.slice(
        lower(root.scrollTop - 240),
        lower(root.scrollTop + root.clientHeight + 240),
      );
    }
    const next = new Map<string, Entry>();
    const start = document.timeline.currentTime;
    // Capture interrupted visual positions before cancelling any animation. Then
    // cancel together, measure destinations together, and finally start motion.
    const interrupted = new Map<string, { box: Box; opacity: number }>();
    if (animate) {
      for (const node of nodes) {
        const old = this.entries.get(node.dataset.motionKey!);
        if (old?.animation?.playState !== 'running') continue;
        const style = getComputedStyle(old.node);
        const translate = style.translate.split(' ').map(parseFloat);
        const scale = style.scale.split(' ').map(parseFloat);
        const x = Number.isFinite(translate[0]) ? translate[0] : 0;
        const y = Number.isFinite(translate[1]) ? translate[1] : 0;
        const sx = Number.isFinite(scale[0]) ? scale[0] : 1;
        const sy = Number.isFinite(scale[1]) ? scale[1] : sx;
        interrupted.set(node.dataset.motionKey!, {
          opacity: Number(style.opacity),
          box: {
            left: old.box.left + x - (old.box.width * (sx - 1)) / 2,
            top: old.box.top + y - (old.box.height * (sy - 1)) / 2,
            width: old.box.width * sx,
            height: old.box.height * sy,
          },
        });
      }
      for (const entry of this.entries.values()) entry.animation?.cancel();
    }
    const pending: { entry: Entry; frames: Keyframe[] }[] = [];
    const parentBounds = root.classList.contains('snapshot-grid')
      ? root.parentElement?.getBoundingClientRect()
      : undefined;
    for (const node of nodes) {
      const key = node.dataset.motionKey!;
      const old = this.entries.get(key);
      if (!animate) {
        // Live cursor ticks update the baseline without introducing playback lag
        // or interrupting an in-flight interval projection.
        const rect = node.getBoundingClientRect(),
          style = getComputedStyle(node);
        const translate = style.translate.split(' ').map(parseFloat),
          scale = style.scale.split(' ').map(parseFloat);
        const x = Number.isFinite(translate[0]) ? translate[0] : 0,
          y = Number.isFinite(translate[1]) ? translate[1] : 0;
        const sx = Number.isFinite(scale[0]) && scale[0] > 0 ? scale[0] : 1,
          sy = Number.isFinite(scale[1]) && scale[1] > 0 ? scale[1] : sx;
        const width = rect.width / sx,
          height = rect.height / sy;
        next.set(key, {
          node,
          box: {
            left: rect.left - origin.left + root.scrollLeft - x + (width * (sx - 1)) / 2,
            top: rect.top - origin.top + root.scrollTop - y + (height * (sy - 1)) / 2,
            width,
            height,
          },
          opacity: old?.opacity ?? Number(style.opacity),
          animation: old?.animation,
        });
        continue;
      }
      const first = interrupted.get(key)?.box ?? old?.box;
      const firstOpacity = interrupted.get(key)?.opacity ?? old?.opacity;
      const rect = node.getBoundingClientRect(),
        opacity = Number(getComputedStyle(node).opacity);
      const box = {
        left: rect.left - origin.left + root.scrollLeft,
        top: rect.top - origin.top + root.scrollTop,
        width: rect.width,
        height: rect.height,
      };
      const entry: Entry = { node, box, opacity };
      next.set(key, entry);
      const delta = first ? layoutDelta(first, box) : null;
      const frames = delta
        ? [
            { ...delta, opacity: firstOpacity ?? opacity },
            { translate: '0px 0px', scale: '1 1', opacity },
          ]
        : old && firstOpacity !== opacity
          ? [{ opacity: firstOpacity }, { opacity }]
          : !old && !this.known.has(key) && this.entries.size
            ? [
                { opacity: 0, scale: '.96' },
                { opacity, scale: '1' },
              ]
            : null;
      if (frames) pending.push({ entry, frames });
    }
    for (const { entry, frames } of pending) {
      const animation = entry.node.animate(frames, { ...MEDIA_MOTION, id: 'media-layout' });
      animation.startTime = start;
      entry.animation = animation;
    }
    for (const [key, entry] of this.entries) {
      if (next.has(key)) continue;
      entry.animation?.cancel();
      if (
        root.dataset.virtualized === 'true' &&
        !exitWithinViewport(
          Number(entry.node.dataset.slot),
          Number(root.dataset.virtualStart),
          Number(root.dataset.virtualEnd),
        )
      )
        continue;
      if (entry.node.isConnected || entry.box.width <= 0 || this.exits.size >= 64) continue;
      const ghost = document.createElement('div');
      ghost.dataset.motionExit = 'true';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      if (entry.node.classList.contains('snapshot-cell')) {
        entry.node.classList.replace('snapshot-cell', 'snapshot-ghost');
        entry.node.removeAttribute('data-at');
        for (const button of entry.node.querySelectorAll('button')) {
          button.classList.remove('selected');
          for (const attr of [
            'data-unit-index',
            'data-at',
            'aria-current',
            'aria-pressed',
            'aria-label',
          ])
            button.removeAttribute(attr);
        }
      }
      Object.assign(ghost.style, {
        position: 'absolute',
        pointerEvents: 'none',
        margin: '0',
        left: `${entry.box.left}px`,
        top: `${entry.box.top}px`,
        width: `${entry.box.width}px`,
        height: `${entry.box.height}px`,
        zIndex: '3',
      });
      // React has already unmounted this node; retaining it preserves its decoded
      // image through object-URL revocation without cloning or allocating a blob.
      Object.assign(entry.node.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        right: 'auto',
        bottom: 'auto',
        margin: '0',
        width: '100%',
        height: '100%',
        transform: 'none',
        translate: 'none',
        scale: 'none',
      });
      ghost.append(entry.node);
      if (root.classList.contains('snapshot-grid')) {
        // Exit pixels live beside the React grid, never among its minute cells.
        // This keeps grid placement, keyboard selection and child indices exact.
        const parent = root.parentElement!;
        if (!this.layer) {
          this.layer = document.createElement('div');
          this.layer.className = 'snapshot-exits';
          this.layer.dataset.motionExit = 'true';
          this.layer.setAttribute('aria-hidden', 'true');
          this.layer.inert = true;
          parent.append(this.layer);
        }
        const bounds = parentBounds!;
        Object.assign(this.layer.style, {
          left: `${origin.left - bounds.left}px`,
          top: `${origin.top - bounds.top}px`,
          width: `${origin.width}px`,
          height: `${origin.height}px`,
        });
        ghost.style.left = `${entry.box.left - root.scrollLeft}px`;
        ghost.style.top = `${entry.box.top - root.scrollTop}px`;
        this.layer.append(ghost);
      } else root.append(ghost);
      this.exits.add(ghost);
      const animation = ghost.animate(
        [
          { opacity: entry.opacity, scale: '1' },
          { opacity: 0, scale: '.94' },
        ],
        { duration: 200, easing: MEDIA_MOTION.easing, id: 'media-exit' },
      );
      animation.startTime = start;
      void animation.finished.then(
        () => {
          ghost.remove();
          this.exits.delete(ghost);
          if (!this.exits.size) {
            this.layer?.remove();
            this.layer = null;
          }
        },
        (error) => {
          ghost.remove();
          this.exits.delete(ghost);
          if (!this.exits.size) {
            this.layer?.remove();
            this.layer = null;
          }
          if (!(error instanceof DOMException && error.name === 'AbortError'))
            console.warn('Media exit animation failed', error);
        },
      );
    }
    this.entries = next;
    this.known = new Set(all.map((node) => node.dataset.motionKey!));
  }
  clear(): void {
    for (const entry of this.entries.values()) entry.animation?.cancel();
    this.entries.clear();
    this.known.clear();
    for (const ghost of this.exits) {
      ghost.getAnimations().forEach((animation) => animation.cancel());
      ghost.remove();
    }
    this.exits.clear();
    this.layer?.remove();
    this.layer = null;
  }
}
