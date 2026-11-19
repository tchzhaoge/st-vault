type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
/** Every UTC-positioned layer shares a clock and retains its in-flight displacement. */
export function panTimeline(
  nodes: HTMLElement[],
  deltaPx: number,
  previous: Animation[],
): Animation[] {
  if (!deltaPx) {
    previous.forEach((animation) => animation.cancel());
    return [];
  }
  const anchor = previous
    .map((animation) => (animation.effect as KeyframeEffect | null)?.target)
    .find((target) => nodes.includes(target as HTMLElement));
  const offset = anchor ? new DOMMatrixReadOnly(getComputedStyle(anchor).transform).m41 : 0;
  previous.forEach((animation) => animation.cancel());
  const start = document.timeline.currentTime;
  return nodes.map((node) => {
    const animation = node.animate(
      [{ transform: `translateX(${deltaPx + offset}px)` }, { transform: 'translateX(0)' }],
      { id: 'timeline-pan', duration: 420, easing: 'cubic-bezier(.22,.61,.36,1)' },
    );
    animation.startTime = start;
    return animation;
  });
}
/** Virtual rows can mount midway through a pan; join its existing phase before paint. */
export function joinTimelinePan(nodes: HTMLElement[], previous: Animation[]): Animation[] {
  const active = previous.filter((animation) => {
    const effect = animation.effect as KeyframeEffect | null;
    if (animation.playState === 'running' && effect?.target?.isConnected) return true;
    animation.cancel();
    return false;
  });
  const anchor = active[0];
  const startTime = anchor?.startTime;
  if (startTime === undefined || startTime === null) return active;
  const effect = anchor.effect as KeyframeEffect;
  const targets = new Set(active.map((animation) => (animation.effect as KeyframeEffect).target));
  const timing = effect.getTiming();
  const frames = effect
    .getKeyframes()
    .map((frame) => ({ transform: String(frame.transform), offset: frame.offset }));
  return [
    ...active,
    ...nodes
      .filter((node) => !targets.has(node))
      .map((node) => {
        const animation = node.animate(frames, {
          id: 'timeline-pan',
          duration: timing.duration,
          easing: timing.easing,
        });
        animation.startTime = startTime;
        return animation;
      }),
  ];
}
/** A transient locator cue; no row size, playback selection or persistent styling changes. */
export function indicateRow(node: HTMLElement): void {
  for (const animation of node.getAnimations({ subtree: true }))
    if (animation.id === 'row-reveal') animation.cancel();
  node.animate(
    [
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 0.08 },
      { opacity: 0.9, offset: 0.58 },
      { opacity: 0, offset: 1 },
    ],
    {
      id: 'row-reveal',
      duration: 2600,
      easing: 'cubic-bezier(.22,.61,.36,1)',
      fill: 'none',
      pseudoElement: '::after',
    },
  );
}
const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, value));
export function surfaceKeyframes(
  panel: Rect,
  trigger: Rect,
  closing: boolean,
): { origin: string; frames: Keyframe[] } {
  const x = trigger.left + trigger.width / 2 - panel.left;
  const y = trigger.top + trigger.height / 2 - panel.top;
  const offset = Math.max(-24, Math.min(24, y - panel.height / 2));
  const scaleX = Math.max(0.12, Math.min(0.86, trigger.width / Math.max(1, panel.width)));
  const scaleY = Math.max(0.14, Math.min(0.78, trigger.height / Math.max(1, panel.height)));
  const frames: Keyframe[] = [
    {
      opacity: 0,
      transform: `translateY(${offset}px) scale(${scaleX}, ${scaleY})`,
      borderRadius: '36px',
      offset: 0,
    },
    { opacity: 1, transform: 'scale(1.012, 1.01)', borderRadius: '24px', offset: 0.68 },
    { opacity: 1, transform: 'scale(.998, .997)', borderRadius: '24px', offset: 0.86 },
    { opacity: 1, transform: 'none', borderRadius: '24px', offset: 1 },
  ];
  return {
    origin: `${clamp(x, panel.width)}px ${clamp(y, panel.height)}px`,
    frames: closing
      ? frames.reverse().map((frame) => ({ ...frame, offset: 1 - Number(frame.offset) }))
      : frames,
  };
}
export function animateSurface(
  node: HTMLElement,
  trigger: HTMLElement,
  closing: boolean,
  interrupted?: Keyframe,
): Animation | null {
  if (typeof node.animate !== 'function') return null;
  const motion = surfaceKeyframes(
    node.getBoundingClientRect(),
    trigger.getBoundingClientRect(),
    closing,
  );
  node.style.transformOrigin = motion.origin;
  const style = getComputedStyle(node);
  for (const frame of motion.frames)
    if (frame.opacity === 1) frame.borderRadius = style.borderRadius || '24px';
  if (interrupted) motion.frames[0] = interrupted;
  // CSS minifiers may rewrite milliseconds as seconds; WAAPI always expects milliseconds.
  const time = style.getPropertyValue('--motion-surface').trim();
  const duration = parseFloat(time) * (time.endsWith('ms') ? 1 : 1000) || 320;
  return node.animate(motion.frames, {
    duration: duration * (closing ? 0.6 : 1),
    easing: style.getPropertyValue('--motion-ease').trim() || 'ease-out',
    fill: closing ? 'forwards' : 'none',
  });
}

/** Carry the current presentation into the next phase before cancelling it. */
export function interruptSurface(
  animation: Animation | null,
  node: HTMLElement,
): Keyframe | undefined {
  let frame: Keyframe | undefined;
  if (animation && animation.playState !== 'finished' && animation.playState !== 'idle') {
    const style = getComputedStyle(node);
    frame = {
      opacity: style.opacity,
      transform: style.transform,
      borderRadius: style.borderRadius,
    };
  }
  animation?.cancel();
  return frame;
}
