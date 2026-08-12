import type { FastifyInstance } from 'fastify';
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
