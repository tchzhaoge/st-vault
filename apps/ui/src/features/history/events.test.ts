import { expect, it } from 'vitest';
import type { PublicStatus } from '@st-vault/api-schema';
import { eventPresentation } from './events';
it('gives each of the six confirmed state transitions a unique description', () => {
  const descriptions = new Set<string>(),
    states: PublicStatus[] = ['PUBLIC', 'PRIVATE', 'OFFLINE'];
  for (const fromStatus of states)
    for (const toStatus of states)
      if (fromStatus !== toStatus) {
        const result = eventPresentation({
          id: 1,
          atMs: 1,
          occurredAtMs: 1,
          kind: 'status_changed',
          subjectId: 'stripchat:42',
          handle: 'Name',
          fromStatus,
          toStatus,
          reason: 'observation',
        });
        expect(result.name).toBe('Name');
        expect(result.color).toBe(toStatus.toLowerCase());
        expect(result.text).not.toBe('状态更新');
        descriptions.add(result.text);
      }
  expect(descriptions.size).toBe(6);
});
it('uses one program color and distinguishes graceful shutdown from a detected crash', () => {
  const base = {
    id: 1,
    atMs: 10,
    occurredAtMs: 5,
    runId: 'r',
    startedAtMs: 1,
    lastHeartbeatAtMs: 5,
    stoppedAtMs: null,
    uncertainUntilMs: 10,
  };
  const events = (['run_started', 'run_stopped', 'run_abnormal'] as const).map((kind) =>
    eventPresentation({ ...base, kind }),
  );
  expect(events.every((event) => event.color === 'program')).toBe(true);
  expect(new Set(events.map((event) => event.text)).size).toBe(3);
});
