import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildTranscript, getPrisma } from '@aegis/db';
import { requireGuild } from '../guard.js';

/* ═══════════════════════════════════════════════════════════════════════
   ARCHIVIO — accesso dal pannello

   Le trascrizioni si scaricano da qui invece che da un comando quando servono
   per un'indagine lunga: un file HTML in un canale Discord scade con la
   retention del canale stesso, un download no.

   L'accesso richiede il ruolo MOD sul pannello, non i permessi Discord: chi
   amministra un server non deve automaticamente poter scaricare l'intero
   archivio delle conversazioni.
   ═══════════════════════════════════════════════════════════════════════ */

export async function archiveRoutes(app: FastifyInstance): Promise<void> {
  /** Quanto è archiviato, canale per canale. */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/archive',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const [byChannel, total, deleted, attachments, oldest] = await Promise.all([
        prisma.messageArchive.groupBy({
          by: ['channelId'],
          where: { guildId: context.guildId },
          _count: true,
          orderBy: { _count: { channelId: 'desc' } },
          take: 50,
        }),
        prisma.messageArchive.count({ where: { guildId: context.guildId } }),
        prisma.messageArchive.count({
          where: { guildId: context.guildId, deletedAt: { not: null } },
        }),
        prisma.attachmentArchive.count({ where: { guildId: context.guildId } }),
        prisma.messageArchive.findFirst({
          where: { guildId: context.guildId },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);

      return {
        channels: byChannel.map((entry) => ({
          channelId: entry.channelId,
          messages: entry._count,
        })),
        total,
        deleted,
        attachments,
        oldest: oldest?.createdAt ?? null,
      };
    },
  );

  /** Trascrizione HTML di un canale, scaricabile come file. */
  app.get<{
    Params: { guildId: string; channelId: string };
    Querystring: Record<string, string>;
  }>('/api/guilds/:guildId/archive/:channelId/transcript', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
    if (!context) return;

    const query = z
      .object({
        days: z.coerce.number().int().min(1).max(3650).optional(),
        limit: z.coerce.number().int().min(1).max(20000).default(5000),
        name: z.string().max(100).default('canale'),
      })
      .safeParse(request.query);

    if (!query.success) {
      return reply.code(400).send({ error: 'parametri non validi' });
    }

    const prisma = getPrisma();
    const guild = await prisma.guild.findUnique({ where: { id: context.guildId } });

    const result = await buildTranscript({
      guildId: context.guildId,
      channelId: request.params.channelId,
      channelName: query.data.name,
      guildName: guild?.name ?? context.guildId,
      limit: query.data.limit,
      since: query.data.days ? new Date(Date.now() - query.data.days * 86_400_000) : undefined,
      includeDeleted: true,
    });

    await prisma.auditEvent
      .create({
        data: {
          guildId: context.guildId,
          type: 'ARCHIVE_EXPORTED',
          category: 'MODERATION',
          actorId: context.user.id,
          actorTag: context.user.tag,
          channelId: request.params.channelId,
          severity: 20,
          summary: `Trascrizione scaricata dal pannello: ${result.messageCount} messaggi`,
          payload: { messageCount: result.messageCount, deletedCount: result.deletedCount },
        },
      })
      .catch(() => undefined);

    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="trascrizione-${request.params.channelId}.html"`,
      )
      .send(result.html);
  });
}
