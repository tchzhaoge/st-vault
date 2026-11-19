import { expect, it } from 'vitest';
import { acceptsRequestOrigin } from './request-origin.js';

it.each(['http', 'https'])('accepts same-origin %s requests', (scheme) => {
  const host = '192.168.3.2:10002';
  expect(acceptsRequestOrigin({ host, origin: scheme + '://' + host })).toBe(true);
});

it('rejects different origins even if the claimed browser metadata or forwarded host matches', () => {
  expect(
    acceptsRequestOrigin({
      host: 'nas.test:10002',
      origin: 'https://nas.test:10003',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': 'nas.test:10003',
    }),
  ).toBe(false);
});

it('allows requests without an Origin and explicit development origins', () => {
  expect(acceptsRequestOrigin({ host: 'localhost:10002' })).toBe(true);
  expect(
    acceptsRequestOrigin({ host: 'localhost:10002', origin: 'http://localhost:5174' }, [
      'http://localhost:5174',
    ]),
  ).toBe(true);
});
