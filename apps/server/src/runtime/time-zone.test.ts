import { expect, it } from 'vitest';
import { deploymentTimeZone } from './time-zone.js';
it('accepts IANA zones and refuses invalid deployment configuration', () => {
  expect(deploymentTimeZone('America/New_York')).toBe('America/New_York');
  expect(deploymentTimeZone('UTC')).toBe('UTC');
  expect(() => deploymentTimeZone('Invalid/Zone')).toThrow('INVALID_TIME_ZONE');
});
