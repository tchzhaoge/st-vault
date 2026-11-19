import { expect, it } from 'vitest';
import { ByteLedger } from './byte-ledger.js';

it('matches the complete shared-buffer scan across producer, recorder and cancellation owners', () => {
  const ledger = new ByteLedger();
  const buffers = Array.from({ length: 47 }, (_, index) => new Uint8Array(index * 13));
  const owners: Uint8Array[][] = Array.from({ length: 64 }, () => []);
  let random = 17;
  for (let step = 0; step < 20000; step++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const owner = owners[random % owners.length];
    if (owner.length && random & 128) ledger.release(owner.shift()!);
    else {
      const bytes = buffers[(random >>> 8) % buffers.length];
      owner.push(bytes);
      ledger.retain(bytes);
    }
    expect(ledger.bytes).toBe(
      [...new Set(owners.flat())].reduce((sum, bytes) => sum + bytes.byteLength, 0),
    );
  }
  for (const owner of owners) for (const bytes of owner) ledger.release(bytes);
  expect(ledger.bytes).toBe(0);
  expect(() => ledger.release(buffers[0])).toThrow('UNOWNED_INGRESS_BUFFER');
});
