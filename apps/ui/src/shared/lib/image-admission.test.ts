import { expect, it } from 'vitest';
import { ImageAdmission, type ImagePriority } from './image-admission';
import { ImageLoader } from './image-loader';
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it('shares capacity, promotes queued work and releases an attempt only once', async () => {
  const admission = new ImageAdmission(1),
    abort = new AbortController();
  const first = await admission.acquire(abort.signal, () => 'visible');
  let priority: ImagePriority = 'prefetch';
  const order: string[] = [];
  const background = admission
    .acquire(abort.signal, () => priority)
    .then((release) => {
      order.push('promoted');
      return release;
    });
  const visible = admission
    .acquire(abort.signal, () => 'visible')
    .then((release) => {
      order.push('visible');
      return release;
    });
  priority = 'interactive';
  first();
  first();
  await tick();
  expect(order).toEqual(['promoted']);
  (await background)();
  (await visible)();
});
it('cancels queued image work without consuming a future slot', async () => {
  const admission = new ImageAdmission(1),
    first = await admission.acquire(new AbortController().signal, () => 'visible');
  const abort = new AbortController();
  const canceled = admission.acquire(abort.signal, () => 'interactive');
  const rejected = expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await rejected;
  first();
  const next = await admission.acquire(new AbortController().signal, () => 'visible');
  next();
});
it('bounds transfers across separate caches and keeps cached blobs independently', async () => {
  const admission = new ImageAdmission(2),
    gates: (() => void)[] = [];
  let active = 0,
    maximum = 0;
  const fetch = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => gates.push(resolve));
    active--;
    return new Response(new Blob(['image'], { type: 'image/jpeg' }));
  };
  const covers = new ImageLoader({ admission, fetch }),
    snapshots = new ImageLoader({ admission, fetch });
  const work = [covers.load('/a'), covers.load('/b'), snapshots.load('/c')];
  await tick();
  expect(maximum).toBe(2);
  gates.shift()!();
  await work[0];
  await tick();
  expect(maximum).toBe(2);
  for (const release of gates) release();
  await Promise.all(work);
  covers.clear();
  expect(snapshots.peek('/c')).not.toBeNull();
  snapshots.clear();
});
