import { expect, it } from 'vitest';
import { readCookieDraft, writeCookieDraft } from './cookie-draft';

it('persists one site-bound draft, replaces it and removes manually cleared cookies', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  expect(readCookieDraft(storage)).toBeNull();
  writeCookieDraft(storage, 'session=first', 'https://stripchat.com');
  expect(readCookieDraft(storage)).toEqual({
    cookiesText: 'session=first',
    origin: 'https://stripchat.com',
  });
  writeCookieDraft(storage, 'session=second', 'https://stripchat.com');
  expect(readCookieDraft(storage)?.cookiesText).toBe('session=second');
  writeCookieDraft(storage, '', 'https://stripchat.org');
  expect(readCookieDraft(storage)).toBeNull();
  expect(values.size).toBe(0);
});

it('rejects malformed drafts and surfaces unavailable browser storage', () => {
  const storage = {
    getItem: () => '{"cookiesText":"secret","origin":"http://unsafe"}',
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  expect(() => readCookieDraft(storage)).toThrow();
  expect(() =>
    writeCookieDraft(
      {
        ...storage,
        setItem: () => {
          throw new Error('quota');
        },
      },
      'secret',
      'https://stripchat.com',
    ),
  ).toThrow('quota');
});
