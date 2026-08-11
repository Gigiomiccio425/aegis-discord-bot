import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@angel/db';
import { requireGuild } from '../guard.js';
import { sendBotCommand } from '../redis.js';

/* ═══════════════════════════════════════════════════════════════════════
   SONDAGGI E GIVEAWAY — lettura e comandi dal pannello

   La creazione resta nei comandi slash: un sondaggio va pubblicato in un
   canale, e scegliere il canale dal pannello per poi non vedere il risultato è
   più scomodo che scriverlo direttamente in chat. Dal pannello si osserva
   l'andamento e si chiude in anticipo, che è ciò che serve davvero.
   ═══════════════════════════════════════════════════════════════════════ */

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/polls',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'VIEWER');
      if (!context) return;

      const prisma = getPrisma();
      const polls = await prisma.poll.findMany({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { votes: { select: { optionIds: true } } },
      });

      return polls.map((poll) => {
        const options = poll.options as unknown as { index: number; label: string }[];
        const tally = new Map<number, number>();
        for (const vote of poll.votes) {
          for (const index of vote.optionIds) tally.set(index, (tally.get(index) ?? 0) + 1);
        }

        return {
          id: poll.id,
          question: poll.question,
          channelId: poll.channelId,
          messageId: poll.messageId,
          anonymous: poll.anonymous,
          multiSelect: poll.multiSelect,
          createdAt: poll.createdAt,
          closesAt: poll.closesAt,
          closedAt: poll.closedAt,
          voters: poll.votes.length,
          // I risultati si mostrano nel pannello anche a sondaggio aperto: chi
          // amministra deve poter vedere l'andamento, e non sta votando.
          results: options.map((option) => ({
            label: option.label,
            count: tally.get(option.index) ?? 0,
          })),
        };
      });
    },
  );

  app.post<{ Params: { guildId: string; pollId: string } }>(
    '/api/guilds/:guildId/polls/:pollId/close',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const poll = await prisma.poll.findUnique({ where: { id: request.params.pollId } });
      if (!poll || poll.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'sondaggio non trovato' });
      }
      if (poll.closedAt) return reply.code(409).send({ error: 'sondaggio già chiuso' });

      await sendBotCommand({
        action: 'poll.close',
        guildId: context.guildId,
        pollId: poll.id,
      });
      return { ok: true };
    },
  );

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/giveaways',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'VIEWER');
      if (!context) return;

      const prisma = getPrisma();
      const giveaways = await prisma.giveaway.findMany({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { _count: { select: { entries: true } } },
      });

      return giveaways.map((giveaway) => ({
        id: giveaway.id,
        prize: giveaway.prize,
        channelId: giveaway.channelId,
        winnerCount: giveaway.winnerCount,
        hostId: giveaway.hostId,
        createdAt: giveaway.createdAt,
        endsAt: giveaway.endsAt,
        endedAt: giveaway.endedAt,
        winnerIds: giveaway.winnerIds,
        entries: giveaway._count.entries,
        requirements: giveaway.requirements,
      }));
    },
  );

  app.post<{ Params: { guildId: string; giveawayId: string } }>(
    '/api/guilds/:guildId/giveaways/:giveawayId/draw',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const giveaway = await prisma.giveaway.findUnique({
        where: { id: request.params.giveawayId },
      });
      if (!giveaway || giveaway.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'giveaway non trovato' });
      }

      await sendBotCommand({
        action: 'giveaway.draw',
        guildId: context.guildId,
        giveawayId: giveaway.id,
      });
      return { ok: true };
    },
  );

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/reaction-roles',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      return prisma.reactionRoleSet.findMany({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
      });
    },
  );
}
