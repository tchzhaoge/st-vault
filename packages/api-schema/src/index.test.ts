import { describe, expect, it } from 'vitest';
import { accountSyncConfigSchema, playbackSchema, policySchema, timelineSchema } from './index.js';

const day = 86400000;

describe('request schema contracts', () => {
  it('retains defaults, coercion and complete seven-day playback windows', () => {
    expect(accountSyncConfigSchema.parse({ cookiesText: 'synthetic' })).toEqual({
      cookiesText: 'synthetic',
    });
    expect(timelineSchema.parse({ from: '0', to: String(7 * day) })).toEqual({
      from: 0,
      to: 7 * day,
      limit: 1000,
    });
    expect(
      playbackSchema.parse({ subjectId: 'stripchat:42', targetUtcMs: 0, fromMs: 0, toMs: 7 * day }),
    ).toMatchObject({ gapPolicy: 'report', fromMs: 0, toMs: 7 * day });
    expect(policySchema.parse({ autoRecord: false })).toEqual({ autoRecord: false });
  });

  it('preserves strict request shapes and cookie and synchronization limits', () => {
    expect(accountSyncConfigSchema.safeParse({ cookiesText: 'x'.repeat(65536) }).success).toBe(
      true,
    );
    for (const input of [
      { cookiesText: '' },
      { cookiesText: 'x'.repeat(65537) },
      { extra: true },
      { cookiesText: 'synthetic', intervalMinutes: 360 },
    ]) {
      expect(accountSyncConfigSchema.safeParse(input).success).toBe(false);
    }
    expect(policySchema.safeParse({}).success).toBe(false);
    expect(policySchema.safeParse({ autoRecord: true, extra: true }).success).toBe(false);
  });

  it('rejects unsafe timestamps, oversized windows, and targets outside a selection', () => {
    const playback = { subjectId: 'stripchat:42', targetUtcMs: 0, fromMs: 0, toMs: 7 * day };
    for (const input of [
      { ...playback, toMs: 10 * day },
      { ...playback, targetUtcMs: 7 * day },
      { ...playback, toMs: undefined },
      { ...playback, targetUtcMs: Number.MAX_SAFE_INTEGER + 1 },
      { ...playback, extra: true },
    ]) {
      expect(playbackSchema.safeParse(input).success).toBe(false);
    }
    for (const input of [
      { from: 0, to: 10 * day },
      { from: 10, to: 10 },
      { from: 0, to: day, limit: 2001 },
      { from: 'invalid', to: day },
    ]) {
      expect(timelineSchema.safeParse(input).success).toBe(false);
    }
  });
});
