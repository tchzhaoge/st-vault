import { afterEach, expect, it } from 'vitest';
import { i18n, setLanguage, tr } from './i18n';
import en from '../../locales/en.json';
afterEach(async () => {
  await setLanguage('zh-CN');
});
it('uses compact English only where requested and keeps ordinary Chinese labels', async () => {
  expect(tr('自动', { context: 'compact' })).toBe('自动');
  await setLanguage('en');
  expect(tr('自动', { context: 'compact' })).toBe('Auto');
  expect(tr('自动')).toBe('Automatic');
});
it('switches static and interpolated messages with a Chinese fallback', async () => {
  expect(tr('设置')).toBe('设置');
  await setLanguage('en');
  expect(tr('设置')).toBe('Settings');
  expect(tr('关注 {{v0}} 位', { v0: 42 })).toBe('Following 42');
  expect(tr('剩余 {{v0}}', { v0: '2 GiB' })).toBe('Free 2 GiB');
  expect(tr('待处理 {{v0}} · 完成 {{v1}}', { v0: 12, v1: 34 })).toBe('Pending 12 · Complete 34');
  expect(tr('未配置的文案')).toBe('未配置的文案');
  await i18n.changeLanguage('fr');
  expect(tr('设置')).toBe('设置');
});
it('keeps placeholder contracts and has complete English messages', () => {
  for (const [key, value] of Object.entries(en)) {
    expect(value.trim(), key).not.toBe('');
    expect(value, key).not.toMatch(/[\u3400-\u9fff]/);
    expect([...value.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort(), key).toEqual(
      [...key.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort(),
    );
  }
});
it('keeps Chinese count labels plain while selecting English singular and plural forms', async () => {
  expect(tr('{{v0}} 个密钥', { v0: 1, count: 1 })).toBe('1 个密钥');
  expect(tr('{{v0}} 个密钥', { v0: 2, count: 2 })).toBe('2 个密钥');
  await setLanguage('en');
  expect(tr('{{v0}} 个密钥', { v0: 1, count: 1 })).toBe('1 key');
  expect(tr('{{v0}} 个密钥', { v0: 2, count: 2 })).toBe('2 keys');
});
