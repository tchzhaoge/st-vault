import { expect, it } from 'vitest';
import { allowsCredentialUrl } from './access-transport.js';

it.each([
  'localhost',
  '127.0.0.1',
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.3.2',
  '[::1]',
  '[fd12::1]',
  '[fe80::1]',
])('allows LAN HTTP at %s', (host) => {
  expect(allowsCredentialUrl(`http://${host}:5666/`)).toBe(true);
});
it.each([
  '172.15.0.1',
  '172.32.0.1',
  '8.8.8.8',
  '192.168.3.2.evil.test',
  'nas.example.com',
  '[2001:db8::1]',
])('requires HTTPS at %s', (host) => {
  expect(allowsCredentialUrl(`http://${host}/`)).toBe(false);
  expect(allowsCredentialUrl(`https://${host}/`)).toBe(true);
});
it('rejects invalid or non-HTTP URLs', () => {
  expect(allowsCredentialUrl('not a url')).toBe(false);
  expect(allowsCredentialUrl('file:///tmp')).toBe(false);
});
