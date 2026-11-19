import { expect, it } from 'vitest';
import { z } from 'zod';

it('rejects oversized constrained collections before allocating per-element validation issues', () => {
  // Small reproduction of GHSA-mrhx-c7xc-m3w5; avoid an actual memory exhaustion fixture.
  const result = z
    .array(z.string())
    .max(1000)
    .safeParse(Array.from({ length: 1001 }, () => null));
  expect(result.success).toBe(false);
  expect(result.error?.issues).toEqual([
    expect.objectContaining({ code: 'too_big', maximum: 1000 }),
  ]);
});
