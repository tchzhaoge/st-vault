import { expect, it } from 'vitest';
import { planRowMotion, type RowWindow } from './row-motion';

const ids = Array.from({ length: 10000 }, (_, i) => String(i));
const view = (values = ids, top = 0): RowWindow => ({ ids: values, top, height: 500 });
it('moves rank 1 out through the viewport edge without mounting rank 26', () => {
  const next = [...ids.slice(1, 26), ids[0], ...ids.slice(26)];
  const moves = planRowMotion(view(), view(next), 100);
  expect(moves.find((move) => move.id === '0')).toMatchObject({ from: 0, to: 500, exit: true });
  expect(moves.find((move) => move.id === '1')).toMatchObject({ from: 100, to: 0, exit: false });
  expect(moves.find((move) => move.id === '5')).toMatchObject({ from: 500, to: 400 });
  expect(moves).toHaveLength(6);
});
it('brings a far-away row in from the correct edge and shifts only visible neighbors', () => {
  const next = [ids[25], ...ids.slice(0, 25), ...ids.slice(26)];
  expect(planRowMotion(view(), view(next), 100).find((move) => move.id === '25')).toMatchObject({
    from: 500,
    to: 0,
    exit: false,
  });
});
it('fades removals and additions while preserving partially visible rows', () => {
  const moves = planRowMotion(view(['a', 'b', 'c'], 25), view(['d', 'b', 'c'], 25), 100);
  expect(moves.find((move) => move.id === 'a')).toMatchObject({ opacity: [1, 0], exit: true });
  expect(moves.find((move) => move.id === 'd')).toMatchObject({ opacity: [0, 1], exit: false });
  expect(moves.some((move) => move.id === 'b')).toBe(false);
});
it('does not animate changes wholly outside the viewport or anchored neighbors', () => {
  const next = [...ids];
  [next[900], next[901]] = [next[901], next[900]];
  expect(planRowMotion(view(), view(next), 100)).toEqual([]);
  expect(planRowMotion(view(ids, 1000), view(['new', ...ids], 1100), 100)).toEqual([]);
});
it('continues interrupted motion from its current visual position', () => {
  const next = [ids[1], ids[0], ...ids.slice(2)];
  const moves = planRowMotion(view(next), view(), 100, new Map([['0', 40]]));
  expect(moves.find((move) => move.id === '0')).toMatchObject({ from: 40, to: 0 });
});
