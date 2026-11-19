import { expect, it } from 'vitest';
import { credentialTransport } from './access-transport.js';

it('allows private HTTP behind the gateway without Secure cookies', () => {
  expect(
    credentialTransport({ host: 'localhost', origin: 'http://192.168.3.2:5666' }, 'http', true),
  ).toEqual({ allowed: true, secureCookie: false });
});
it('never treats a public HTTP origin as local just because the proxy is local', () => {
  expect(
    credentialTransport({ host: 'localhost', origin: 'http://public.example' }, 'http', true)
      .allowed,
  ).toBe(false);
  expect(
    credentialTransport({ host: 'localhost', origin: 'https://public.example' }, 'http', true),
  ).toEqual({ allowed: true, secureCookie: true });
});
