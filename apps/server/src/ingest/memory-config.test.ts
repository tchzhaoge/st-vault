import { expect, it } from 'vitest';
import { ingressMemoryBytes } from './memory-config.js';
const MIB = 1024 ** 2;
it('reserves a third of effective memory for shared media, leaving space for parallel work', () => {
  expect(ingressMemoryBytes(undefined, 2048 * MIB)).toBe(Math.floor((2048 * MIB) / 3));
  expect(ingressMemoryBytes('', 1024 * MIB)).toBe(Math.floor((1024 * MIB) / 3));
  expect(ingressMemoryBytes(undefined, 0)).toBe(4096 * MIB);
  expect(ingressMemoryBytes(undefined, 8 * 1024 * MIB)).toBe(Math.floor((8 * 1024 * MIB) / 3));
  expect(ingressMemoryBytes(undefined, 32 * 1024 * MIB)).toBe(4096 * MIB);
  expect(ingressMemoryBytes('640', 2048 * MIB)).toBe(640 * MIB);
});
it.each(['NaN', '-1', '17', '2048'])('rejects an invalid or unsafe media budget: %s', (value) => {
  expect(() => ingressMemoryBytes(value, 2048 * MIB)).toThrow('INVALID_STV_INGRESS_MEMORY_MB');
});
