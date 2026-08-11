import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma, serializeBigInt } from '@angel/db';
import { requireGuild } from '../guard.js';
import { sendBotCommand } from '../redis.js';

export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  /* ── Casi ──────────────────────────────────────────────────────────── */
  app.get<{ Params: { guildId: string }; Querystring: Record<string, string> }>(
    '/api/guilds/:guildId/cases',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const query = z
        .object({
          status: z.string().optional(),
          type: z.string().optional(),
          targetId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          skip: z.coerce.number().int().min(0).default(0),
        })
        .parse(request.query);

      const prisma = getPrisma();
      const [cases, total] = await Promise.all([
        prisma.case.findMany({
          where: {
            guildId: context.guildId,
            ...(query.status ? { status: query.status as never } : {}),
            ...(query.type ? { type: query.type as never } : {}),
            ...(query.targetId ? { targetId: query.targetId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          skip: query.skip,
        }),
        prisma.case.count({ where: { guildId: context.guildId } }),
      ]);

      return { cases, total };
    },
  );

  app.post<{ Params: { guildId: string; caseId: string }; Body: { reason?: string } }>(
    '/api/guilds/:guildId/cases/:caseId/revoke',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const record = await prisma.case.findUnique({ where: { id: request.params.caseId } });
      if (!record || record.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'caso non trovato' });
      }

      await prisma.case.update({
        where: { id: record.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: context.user.id },
      });

      // Revocare dal pannello deve avere un effetto reale su Discord: un caso
      // marcato «revocato» mentre la persona resta bandita o isolata è peggio
      // di non avere il pulsante.
      await sendBotCommand({
        action: 'case.undo',
        guildId: context.guildId,
        actorId: context.user.id,
        caseType: record.type,
        targetId: record.targetId,
        reason: request.body?.reason ?? `Caso #${record.number} revocato dal pannello`,
      });

      return { ok: true };
    },
  );

  /* ── Appelli ───────────────────────────────────────────────────────── */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/appeals',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      return prisma.case.findMany({
        where: { guildId: context.guildId, appealAt: { not: null }, appealResolvedAt: null },
        orderBy: { appealAt: 'asc' },
        take: 100,
      });
    },
  );

  app.post<{
    Params: { guildId: string; caseId: string };
    Body: { accepted?: boolean; note?: string };
  }>('/api/guilds/:guildId/cases/:caseId/appeal', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
    if (!context) return;

    const accepted = request.body?.accepted === true;
    const prisma = getPrisma();
    const record = await prisma.case.findUnique({ where: { id: request.params.caseId } });
    if (!record || record.guildId !== context.guildId || !record.appealAt) {
      return reply.code(404).send({ error: 'appello non trovato' });
    }

    await prisma.case.update({
      where: { id: record.id },
      data: {
        appealResolvedAt: new Date(),
        appealResolvedBy: context.user.id,
        status: accepted ? 'REVOKED' : 'UPHELD',
        ...(accepted ? { revokedAt: new Date(), revokedBy: context.user.id } : {}),
      },
    });

    if (accepted) {
      await sendBotCommand({
        action: 'case.undo',
        guildId: context.guildId,
        actorId: context.user.id,
        caseType: record.type,
        targetId: record.targetId,
        reason: `Appello accolto sul caso #${record.number}`,
      });
    }

    await prisma.auditEvent
      .create({
        data: {
          guildId: context.guildId,
          type: 'MOD_APPEAL_RESOLVED',
          category: 'MODERATION',
          actorId: context.user.id,
          actorTag: context.user.tag,
          targetId: record.targetId,
          caseId: record.id,
          severity: 20,
          summary:
            `Appello sul caso #${record.number} ${accepted ? 'accolto' : 'respinto'} dal pannello` +
            (request.body?.note ? `\n${request.body.note}` : ''),
        },
      })
      .catch(() => undefined);

    return { ok: true, accepted };
  });

  /* ── Sincronizzazione AutoMod su richiesta ─────────────────────────── */
  app.post<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/actions/automod-sync',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      await sendBotCommand({
        action: 'automod.sync',
        guildId: context.guildId,
        actorId: context.user.id,
      });
      return { ok: true };
    },
  );

  /* ── Incidenti ─────────────────────────────────────────────────────── */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/incidents',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      return prisma.incident.findMany({
        where: { guildId: context.guildId },
        orderBy: { startedAt: 'desc' },
        take: 50,
      });
    },
  );

  /**
   * Riabilitazione di massa dopo un raid.
   *
   * È la contropartita necessaria di una difesa automatica: se il bot mette in
   * quarantena quaranta persone e cinque erano utenti veri, deve esistere un
   * modo per rimediare in un clic. Senza, si finisce per disattivare l'anti-raid.
   */
  app.post<{ Params: { guildId: string; incidentId: string }; Body: { userIds?: string[] } }>(
    '/api/guilds/:guildId/incidents/:incidentId/release',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const incident = await prisma.incident.findUnique({
        where: { id: request.params.incidentId },
      });
      if (!incident || incident.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'incidente non trovato' });
      }

      const targets = request.body?.userIds?.length
        ? request.body.userIds.filter((id) => incident.affectedUserIds.includes(id))
        : incident.affectedUserIds;

      for (const userId of targets) {
        await sendBotCommand({
          action: 'quarantine.lift',
          guildId: context.guildId,
          actorId: context.user.id,
          userId,
        });
      }

      await prisma.incident.update({
        where: { id: incident.id },
        data: { resolvedBy: context.user.id, endedAt: incident.endedAt ?? new Date() },
      });

      return { ok: true, released: targets.length };
    },
  );

  /* ── Azioni immediate ──────────────────────────────────────────────── */
  app.post<{ Params: { guildId: string }; Body: { reason?: string; minutes?: number } }>(
    '/api/guilds/:guildId/actions/lockdown',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      await sendBotCommand({
        action: 'lockdown.enable',
        guildId: context.guildId,
        actorId: context.user.id,
        reason: request.body?.reason ?? `Lockdown richiesto da ${context.user.tag}`,
        durationSec: (request.body?.minutes ?? 0) * 60,
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/actions/lockdown',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      await sendBotCommand({
        action: 'lockdown.disable',
        guildId: context.guildId,
        actorId: context.user.id,
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/users/:userId/quarantine/lift',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      await sendBotCommand({
        action: 'quarantine.lift',
        guildId: context.guildId,
        actorId: context.user.id,
        userId: request.params.userId,
      });
      return { ok: true };
    },
  );

  app.post<{
    Params: { guildId: string; userId: string };
    Body: { reason?: string };
  }>('/api/guilds/:guildId/users/:userId/quarantine', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
    if (!context) return;

    await sendBotCommand({
      action: 'quarantine.apply',
      guildId: context.guildId,
      actorId: context.user.id,
      userId: request.params.userId,
      reason: request.body?.reason ?? `Quarantena decisa da ${context.user.tag}`,
    });
    return { ok: true };
  });

  /* ── Sorveglianza ──────────────────────────────────────────────────────
     Non è una sanzione e non compare all'interessato: mette in evidenza le
     sue azioni nel registro. Basta il livello MOD proprio perché non toglie
     nulla a nessuno — chiedere ADMIN significherebbe non usarla mai. */

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/users/watched',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const rows = await prisma.userProfile.findMany({
        where: {
          guildId: context.guildId,
          watchedAt: { not: null },
          OR: [{ watchExpiresAt: null }, { watchExpiresAt: { gt: new Date() } }],
        },
        orderBy: { watchedAt: 'desc' },
        select: {
          userId: true,
          username: true,
          displayName: true,
          riskScore: true,
          watchedAt: true,
          watchedBy: true,
          watchReason: true,
          watchExpiresAt: true,
        },
      });
      return serializeBigInt(rows);
    },
  );

  app.post<{
    Params: { guildId: string; userId: string };
    Body: { reason?: string; hours?: number };
  }>('/api/guilds/:guildId/users/:userId/watch', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
    if (!context) return;

    await sendBotCommand({
      action: 'watch.add',
      guildId: context.guildId,
      actorId: context.user.id,
      userId: request.params.userId,
      reason: request.body?.reason ?? `Sorveglianza avviata da ${context.user.tag}`,
      hours: Math.min(Math.max(request.body?.hours ?? 0, 0), 8760),
    });
    return { ok: true };
  });

  app.delete<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/users/:userId/watch',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      await sendBotCommand({
        action: 'watch.remove',
        guildId: context.guildId,
        actorId: context.user.id,
        userId: request.params.userId,
      });
      return { ok: true };
    },
  );

  /* ── Voce del bot ──────────────────────────────────────────────────────
     Il pannello non parla con Discord: pubblica l'intenzione e il bot la
     esegue, con le stesse regole di `/dì`. Nessuna menzione di massa parte
     da qui, e ogni invio resta tracciato con il nome di chi lo ha chiesto. */

  app.post<{
    Params: { guildId: string };
    Body: {
      channelId?: string;
      text?: string;
      imageUrl?: string | null;
      embed?: boolean;
      title?: string | null;
      editMessageId?: string | null;
    };
  }>('/api/guilds/:guildId/say', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
    if (!context) return;

    const body = request.body ?? {};
    if (!body.channelId) return reply.code(400).send({ error: 'canale mancante' });
    if (!body.text && !body.imageUrl) {
      return reply.code(400).send({ error: 'serve almeno un testo o un\'immagine' });
    }
    // Stesso vincolo del comando: un allegato pubblicato dal bot sembra venire
    // dallo staff, e non è il caso di prestare quella credibilità a un file
    // qualunque servito da un host qualunque.
    if (body.imageUrl && !/^https:\/\/\S+\.(png|jpe?g|gif|webp|apng|avif)(\?\S*)?$/i.test(body.imageUrl)) {
      return reply
        .code(400)
        .send({ error: 'il link deve essere https e puntare a un\'immagine o a una GIF' });
    }

    await sendBotCommand({
      action: 'message.send',
      guildId: context.guildId,
      actorId: context.user.id,
      channelId: body.channelId,
      text: (body.text ?? '').slice(0, 1900),
      imageUrl: body.imageUrl ?? null,
      embed: body.embed ?? false,
      title: body.title ?? null,
      editMessageId: body.editMessageId ?? null,
    });
    return { ok: true };
  });

  /* ── Utenti a rischio ──────────────────────────────────────────────── */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/users/risky',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const users = await prisma.userProfile.findMany({
        where: { guildId: context.guildId, leftAt: null, riskScore: { gte: 40 } },
        orderBy: { riskScore: 'desc' },
        take: 100,
      });
      return serializeBigInt(users);
    },
  );

  /* ── Inventario di sicurezza ───────────────────────────────────────── */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/security/inventory',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const [webhooks, bots, invitesAtRisk] = await Promise.all([
        prisma.webhookRecord.findMany({
          where: { guildId: context.guildId, deletedAt: null },
          orderBy: { approved: 'asc' },
        }),
        prisma.botRecord.findMany({
          where: { guildId: context.guildId, removedAt: null },
          orderBy: { riskScore: 'desc' },
        }),
        prisma.inviteRecord.findMany({
          where: { guildId: context.guildId, atRisk: true },
        }),
      ]);

      return { webhooks, bots, invitesAtRisk };
    },
  );
}
