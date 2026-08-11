import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '@angel/db';
import { requireGuild } from '../guard.js';

const NewSignature = z.object({
  kind: z.enum(['DOMAIN', 'URL', 'IMAGE_PHASH', 'FILE_SHA256', 'REGEX', 'KEYWORD']),
  value: z.string().min(1).max(2000),
  severity: z.number().int().min(0).max(100).default(70),
  campaign: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
});

export async function threatRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string }; Querystring: Record<string, string> }>(
    '/api/guilds/:guildId/threats',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const query = z
        .object({
          kind: z.string().optional(),
          source: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(request.query);

      const prisma = getPrisma();
      const [own, globalCount, byKind] = await Promise.all([
        // Solo le firme di questo server: le blocklist pubbliche contano
        // centinaia di migliaia di voci e non hanno senso in una tabella
        // sfogliabile a mano.
        prisma.threatSignature.findMany({
          where: {
            guildId: context.guildId,
            ...(query.kind ? { kind: query.kind as never } : {}),
            ...(query.source ? { source: query.source } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: query.limit,
        }),
        prisma.threatSignature.count({ where: { guildId: null, enabled: true } }),
        prisma.threatSignature.groupBy({
          by: ['source'],
          where: { enabled: true },
          _count: true,
        }),
      ]);

      return {
        signatures: own,
        globalCount,
        sources: byKind.map((entry) => ({ source: entry.source, count: entry._count })),
      };
    },
  );

  app.post<{ Params: { guildId: string }; Body: unknown }>(
    '/api/guilds/:guildId/threats',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const parsed = NewSignature.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'firma non valida', dettagli: parsed.error.issues });
      }

      // Una regex scritta male non deve arrivare al bot: verrebbe compilata a
      // ogni messaggio e fallirebbe in silenzio.
      if (parsed.data.kind === 'REGEX') {
        try {
          new RegExp(parsed.data.value);
        } catch (error) {
          return reply.code(400).send({
            error: `Espressione regolare non valida: ${(error as Error).message}`,
          });
        }
      }

      const prisma = getPrisma();
      const created = await prisma.threatSignature
        .upsert({
          where: {
            kind_value_guildId: {
              kind: parsed.data.kind,
              value: parsed.data.value,
              guildId: context.guildId,
            },
          },
          create: {
            guildId: context.guildId,
            kind: parsed.data.kind,
            value: parsed.data.value,
            severity: parsed.data.severity,
            campaign: parsed.data.campaign ?? null,
            description: parsed.data.description ?? null,
            source: 'manual',
            createdBy: context.user.id,
          },
          update: {
            severity: parsed.data.severity,
            campaign: parsed.data.campaign ?? null,
            description: parsed.data.description ?? null,
            enabled: true,
          },
        })
        .catch(() => null);

      if (!created) return reply.code(500).send({ error: 'salvataggio fallito' });
      return created;
    },
  );

  app.delete<{ Params: { guildId: string; signatureId: string } }>(
    '/api/guilds/:guildId/threats/:signatureId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const signature = await prisma.threatSignature.findUnique({
        where: { id: request.params.signatureId },
      });
      if (!signature || signature.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'firma non trovata' });
      }

      await prisma.threatSignature.delete({ where: { id: signature.id } });
      return { ok: true };
    },
  );
}
