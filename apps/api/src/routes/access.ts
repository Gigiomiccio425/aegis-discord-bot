import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma, type PanelRole } from '@aegis/db';
import { requireGuild } from '../guard.js';

/* ═══════════════════════════════════════════════════════════════════════
   PERMESSI DEL PANNELLO

   Sono separati da quelli Discord di proposito: amministrare un server non
   implica il diritto di scaricare l'archivio di tutte le conversazioni. Finora
   però l'unico modo di assegnarli era il primo accesso, che dava ADMIN a
   chiunque avesse MANAGE_GUILD — e nessun modo di correggerlo se non toccando
   il database.

   Due garanzie non negoziabili:
     • solo OWNER può creare altri OWNER, altrimenti la gerarchia non esiste;
     • nessuno può modificare o revocare il proprio livello, altrimenti basta
       un account compromesso per prendersi tutto e chiudere fuori gli altri.
   ═══════════════════════════════════════════════════════════════════════ */

const RANK: Record<PanelRole, number> = { VIEWER: 1, MOD: 2, ADMIN: 3, OWNER: 4 };

export async function accessRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/access',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const entries = await prisma.panelAccess.findMany({
        where: { guildId: context.guildId },
        orderBy: [{ role: 'asc' }, { grantedAt: 'asc' }],
      });

      return {
        entries,
        // Il pannello deve sapere cosa può fare chi guarda, per non offrire
        // pulsanti che il server rifiuterà.
        yourRole: context.role,
        yourId: context.user.id,
      };
    },
  );

  app.put<{
    Params: { guildId: string; userId: string };
    Body: { role?: string };
  }>('/api/guilds/:guildId/access/:userId', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
    if (!context) return;

    const parsed = z
      .object({ role: z.enum(['OWNER', 'ADMIN', 'MOD', 'VIEWER']) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ruolo non valido' });

    const target = request.params.userId;
    if (!/^\d{17,20}$/.test(target)) {
      return reply.code(400).send({ error: 'ID utente non valido' });
    }
    if (target === context.user.id) {
      return reply.code(400).send({
        error:
          'Non puoi modificare il tuo livello di accesso: serve un altro amministratore. ' +
          'È la garanzia che un account compromesso non possa prendersi tutto.',
      });
    }
    if (parsed.data.role === 'OWNER' && context.role !== 'OWNER') {
      return reply.code(403).send({ error: 'Solo un OWNER può nominare un altro OWNER.' });
    }

    const prisma = getPrisma();
    const existing = await prisma.panelAccess.findUnique({
      where: { guildId_userId: { guildId: context.guildId, userId: target } },
    });

    // Non si tocca chi sta più in alto: un ADMIN non può degradare un OWNER.
    if (existing && RANK[existing.role] > RANK[context.role]) {
      return reply.code(403).send({ error: 'Non puoi modificare un livello superiore al tuo.' });
    }

    const record = await prisma.panelAccess.upsert({
      where: { guildId_userId: { guildId: context.guildId, userId: target } },
      create: {
        guildId: context.guildId,
        userId: target,
        role: parsed.data.role,
        grantedBy: context.user.id,
      },
      update: { role: parsed.data.role, grantedBy: context.user.id },
    });

    await prisma.auditEvent
      .create({
        data: {
          guildId: context.guildId,
          type: 'PANEL_ACTION',
          category: 'BOT',
          actorId: context.user.id,
          actorTag: context.user.tag,
          targetId: target,
          severity: 40,
          summary:
            `Accesso al pannello: <@${target}> impostato a **${parsed.data.role}**` +
            (existing ? ` (era ${existing.role})` : ' (nuovo)'),
          payload: { before: existing?.role ?? null, after: parsed.data.role },
        },
      })
      .catch(() => undefined);

    return record;
  });

  app.delete<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/access/:userId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const target = request.params.userId;
      if (target === context.user.id) {
        return reply.code(400).send({ error: 'Non puoi revocare il tuo stesso accesso.' });
      }

      const prisma = getPrisma();
      const existing = await prisma.panelAccess.findUnique({
        where: { guildId_userId: { guildId: context.guildId, userId: target } },
      });
      if (!existing) return reply.code(404).send({ error: 'accesso non trovato' });
      if (RANK[existing.role] > RANK[context.role]) {
        return reply.code(403).send({ error: 'Non puoi revocare un livello superiore al tuo.' });
      }

      await prisma.panelAccess.delete({ where: { id: existing.id } });

      // Revocare l'accesso senza chiudere le sessioni lascerebbe la persona
      // dentro fino alla scadenza del cookie: sarebbe una revoca solo formale.
      await prisma.panelSession
        .updateMany({
          where: { userId: target, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        .catch(() => undefined);

      await prisma.auditEvent
        .create({
          data: {
            guildId: context.guildId,
            type: 'PANEL_ACTION',
            category: 'BOT',
            actorId: context.user.id,
            actorTag: context.user.tag,
            targetId: target,
            severity: 50,
            summary: `Accesso al pannello revocato a <@${target}> (era ${existing.role})`,
            payload: { revokedRole: existing.role },
          },
        })
        .catch(() => undefined);

      return { ok: true };
    },
  );
}
