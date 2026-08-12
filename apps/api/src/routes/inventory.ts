import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@angel/db';
import { RedisKeys } from '@angel/shared';
import { requireGuild } from '../guard.js';
import { getRedis } from '../redis.js';

/* ═══════════════════════════════════════════════════════════════════════
   CANALI E RUOLI DEL SERVER

   Li scrive il bot in Redis, qui si rileggono e basta. Il pannello li usa per
   far scegliere un canale da un elenco invece di far incollare un ID: un ID
   sbagliato non dà errore, punta a un altro canale, e ce se ne accorge il
   giorno in cui l'avviso non arriva.
   ═══════════════════════════════════════════════════════════════════════ */

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Ricerca di un membro per nome.
   *
   * I membri non stanno nell'inventario: un server grande ne ha decine di
   * migliaia, e riversarli tutti nel pannello a ogni apertura sarebbe assurdo.
   * Si cerca invece fra i profili che il bot ha già visto passare, che sono
   * quelli che interessano — chi non ha mai scritto né è mai entrato mentre il
   * bot era acceso non è qualcuno da collegare a un canale Twitch.
   */
  app.get<{ Params: { guildId: string }; Querystring: { q?: string } }>(
    '/api/guilds/:guildId/utenti',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const query = (request.query.q ?? '').trim();
      const prisma = getPrisma();

      // Un ID incollato si risolve direttamente: è il caso di chi ha già copiato
      // l'ID da Discord e non ha voglia di cercare il nome.
      if (/^\d{17,20}$/.test(query)) {
        const profilo = await prisma.userProfile.findUnique({
          where: { guildId_userId: { guildId: context.guildId, userId: query } },
          select: { userId: true, username: true, displayName: true },
        });
        return [profilo ?? { userId: query, username: null, displayName: null }];
      }

      if (query.length < 2) return [];

      return prisma.userProfile.findMany({
        where: {
          guildId: context.guildId,
          OR: [
            { username: { contains: query, mode: 'insensitive' } },
            { displayName: { contains: query, mode: 'insensitive' } },
          ],
        },
        orderBy: { lastSeenAt: 'desc' },
        take: 15,
        select: { userId: true, username: true, displayName: true },
      });
    },
  );

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/inventario',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'VIEWER');
      if (!context) return;

      const raw = await getRedis()
        .get(RedisKeys.guildInventory(context.guildId))
        .catch(() => null);

      if (!raw) {
        // Il bot non l'ha ancora scritto — è appena partito, o non è connesso.
        // Si risponde comunque: il pannello mostra i campi ID a mano invece di
        // un errore, che sarebbe un modo elaborato di dire «riprova più tardi».
        return { channels: [], roles: [], updatedAt: null, pronto: false };
      }

      return { ...(JSON.parse(raw) as object), pronto: true };
    },
  );
}
