import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AccountSyncPort, ArchivePort } from '../ports.js';
import type { NetworkRouting } from '../network/network-routing.js';

export function registerNetworkRouting(
  app: FastifyInstance,
  network: NetworkRouting,
  account: Pick<AccountSyncPort, 'status'>,
  archive: Pick<ArchivePort, 'getSubject'>,
): void {
  app.get('/api/network/routes', () => network.status());
  app.put('/api/network/routes', (request) => network.update(request.body));
  app.post('/api/network/probe', async (request, reply) => {
    const input = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('sites') }).strict(),
        z
          .object({
            kind: z.literal('cdn'),
            subjectId: z
              .string()
              .regex(/^stripchat:[1-9]\d*$/)
              .optional(),
          })
          .strict(),
      ])
      .parse(request.body);
    if (input.kind === 'sites') {
      const state = account.status();
      if (state.connected || state.running)
        return reply.code(409).send({ error: 'account_origin_locked' });
      network.probeSites();
    } else {
      const subject = input.subjectId ? await archive.getSubject(input.subjectId) : null;
      network.probeCdns(subject?.providerStatus === 'PUBLIC' ? subject.providerId : undefined);
    }
    return reply.code(202).send(network.status());
  });
}
