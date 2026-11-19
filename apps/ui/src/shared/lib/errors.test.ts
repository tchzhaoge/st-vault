import { afterEach, expect, it } from 'vitest';
import { ApiError, MutationOutcomeUnknown } from './api';
import { messageFor } from './errors';
import { i18n } from './i18n';
afterEach(() => i18n.changeLanguage('zh-CN'));
it('explains admission pressure and uncertain writes in both languages', async () => {
  const busy = new ApiError('archive_busy', 503);
  expect(messageFor(busy)).toContain('归档请求较多');
  expect(messageFor(new MutationOutcomeUnknown(new Error('synthetic')))).toContain('尚未确认');
  await i18n.changeLanguage('en');
  expect(messageFor(busy)).toContain('archive is busy');
  expect(messageFor(new MutationOutcomeUnknown(new Error('synthetic')))).toContain('unconfirmed');
});
