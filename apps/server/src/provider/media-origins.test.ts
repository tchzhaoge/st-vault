import { expect, it } from 'vitest';
import { HLS_EDGES, mediaHost } from './media-origins.js';
it('keeps every advertised edge inside the media boundary without suffix impersonation', () => {
  for (const host of HLS_EDGES) expect(mediaHost(new URL(`https://${host}/`))).toBe(true);
  expect(mediaHost(new URL('https://doppiocdn.net/'))).toBe(true);
  expect(mediaHost(new URL('https://doppiocdn.net.attacker.invalid/'))).toBe(false);
  expect(mediaHost(new URL('https://notdoppiocdn.net/'))).toBe(false);
  expect(mediaHost(new URL('https://stripchat.com/'))).toBe(false);
});
