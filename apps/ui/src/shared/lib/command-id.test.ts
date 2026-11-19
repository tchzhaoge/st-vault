import { expect, it } from 'vitest';
import { newCommandId } from './command-id';
it('creates unique UUIDv4 command keys without the secure-context-only randomUUID API', () => {
  const ids = Array.from({ length: 100 }, newCommandId);
  expect(new Set(ids).size).toBe(100);
  for (const id of ids)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
