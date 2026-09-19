import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma, serializeBigInt } from '@angel/db';
import { Posta, RedisKeys, leggiEsito } from '@angel/shared';
import { requireGuild } from '../guard.js';
import {
  ATTESA_PANNELLO_MS,
  getRedis,
  rispostaDaConsegna,
  sendBotCommand,
} from '../redis.js';

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

      const where = {
        guildId: context.guildId,
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.type ? { type: query.type as never } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
      };

      const prisma = getPrisma();
      // Il totale con gli stessi filtri dell'elenco: prima contava tutti i
      // casi del server, e con un filtro attivo la paginazione proponeva
      // pagine che non contenevano niente.
      const [cases, total] = await Promise.all([
        prisma.case.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          skip: query.skip,
        }),
        prisma.case.count({ where }),
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

      // Prima l'effetto su Discord, poi lo stato nel database. Un caso segnato
      // «revocato» mentre la persona resta bandita è peggio di non avere il
      // pulsante: chi lo guarda dopo crede che sia tutto a posto.
      const consegna = await sendBotCommand(
        {
          action: 'case.undo',
          guildId: context.guildId,
          actorId: context.user.id,
          caseType: record.type,
          targetId: record.targetId,
          reason: request.body?.reason ?? `Caso #${record.number} revocato dal pannello`,
        },
        { attendiMs: ATTESA_PANNELLO_MS },
      );
      const risposta = rispostaDaConsegna(consegna);
      if (risposta.codice >= 400) return reply.code(risposta.codice).send(risposta.corpo);

      await prisma.case.update({
        where: { id: record.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: context.user.id },
      });

      return reply.code(risposta.codice).send(risposta.corpo);
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

    let messaggio: string | null = null;
    if (accepted) {
      const consegna = await sendBotCommand(
        {
          action: 'case.undo',
          guildId: context.guildId,
          actorId: context.user.id,
          caseType: record.type,
          targetId: record.targetId,
          reason: `Appello accolto sul caso #${record.number}`,
        },
        { attendiMs: ATTESA_PANNELLO_MS },
      );
      const risposta = rispostaDaConsegna(consegna);
      // Appello accolto ma provvedimento rimasto: si dice e non si chiude, così
      // resta in coda e si può riprovare quando il motivo è stato risolto.
      if (risposta.codice >= 400) return reply.code(risposta.codice).send(risposta.corpo);
      messaggio = String(risposta.corpo.messaggio ?? '');
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

    return { ok: true, accepted, messaggio };
  });

  /* ── Sincronizzazione AutoMod su richiesta ─────────────────────────── */
  app.post<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/actions/automod-sync',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const consegna = await sendBotCommand(
        { action: 'automod.sync', guildId: context.guildId, actorId: context.user.id },
        { attendiMs: ATTESA_PANNELLO_MS },
      );
      const risposta = rispostaDaConsegna(consegna);
      return reply.code(risposta.codice).send(risposta.corpo);
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

      // Tutte insieme, con un'attesa sola: una alla volta, quaranta persone
      // farebbero aspettare il pannello per minuti.
      const consegne = await Promise.all(
        targets.map((userId) =>
          sendBotCommand(
            {
              action: 'quarantine.lift',
              guildId: context.guildId,
              actorId: context.user.id,
              userId,
            },
            { attendiMs: ATTESA_PANNELLO_MS },
          ),
        ),
      );

      const falliti = consegne
        .map((consegna, i) => ({ userId: targets[i]!, esito: consegna.esito }))
        .filter(
          (voce) =>
            voce.esito?.stato === 'fallito' &&
            // Chi non era più in quarantena non è un fallimento: è già libero.
            !voce.esito.messaggio.includes('non risulta in quarantena'),
        );
      const inCorso = consegne.filter((consegna) => consegna.esito === null).length;
      const riusciti = targets.length - falliti.length - inCorso;

      await prisma.incident.update({
        where: { id: incident.id },
        data: { resolvedBy: context.user.id, endedAt: incident.endedAt ?? new Date() },
      });

      return {
        ok: falliti.length === 0,
        released: riusciti,
        inCorso,
        falliti: falliti.map((voce) => ({ userId: voce.userId, motivo: voce.esito?.messaggio })),
        messaggio:
          `Riabilitati: ${riusciti} su ${targets.length}.` +
          (inCorso ? ` In corso: ${inCorso}.` : '') +
          (falliti.length
            ? ` Non riusciti: ${falliti.length} — ${falliti[0]!.esito?.messaggio ?? ''}`
            : ''),
      };
    },
  );

  /* ── Azioni immediate ──────────────────────────────────────────────── */

  /**
   * Stato del lockdown, letto direttamente dallo stato che il bot scrive.
   *
   * Prima il pannello non lo mostrava: dopo aver premuto il pulsante l'unico
   * modo di sapere se il server era chiuso era andare su Discord a guardare.
   */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/lockdown',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'VIEWER');
      if (!context) return;

      const redis = getRedis();
      const [grezzo, pronto] = await Promise.all([
        redis.get(RedisKeys.lockdown(context.guildId)).catch(() => null),
        redis.get(Posta.pronto).catch(() => null),
      ]);

      let stato: {
        reason?: string;
        channels?: string[];
        startedAt?: number;
        expiresAt?: number;
        ruoli?: unknown[];
        falliti?: { canaleId: string; nome: string; motivo: string }[];
      } | null = null;
      try {
        stato = grezzo ? JSON.parse(grezzo) : null;
      } catch {
        stato = null;
      }

      return {
        attivo: Boolean(stato),
        motivo: stato?.reason ?? null,
        dal: stato?.startedAt ?? null,
        scade: stato?.expiresAt || null,
        canali: stato?.channels?.length ?? 0,
        ruoli: stato?.ruoli?.length ?? 0,
        falliti: stato?.falliti ?? [],
        botInLinea: pronto !== null,
      };
    },
  );

  app.post<{ Params: { guildId: string }; Body: { reason?: string; minutes?: number } }>(
    '/api/guilds/:guildId/actions/lockdown',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const minuti = Math.min(
        Math.max(Math.round(Number(request.body?.minutes ?? 0)) || 0, 0),
        1440,
      );
      const consegna = await sendBotCommand(
        {
          action: 'lockdown.enable',
          guildId: context.guildId,
          actorId: context.user.id,
          reason: (request.body?.reason ?? `Lockdown richiesto da ${context.user.tag}`).slice(0, 400),
          durationSec: minuti * 60,
        },
        { attendiMs: ATTESA_PANNELLO_MS },
      );
      const risposta = rispostaDaConsegna(consegna);
      return reply.code(risposta.codice).send(risposta.corpo);
    },
  );

  app.delete<{ Params: { guildId: string }; Querystring: { forza?: string } }>(
    '/api/guilds/:guildId/actions/lockdown',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const consegna = await sendBotCommand(
        {
          action: 'lockdown.disable',
          guildId: context.guildId,
          actorId: context.user.id,
          forza: request.query.forza === '1' || request.query.forza === 'true',
        },
        { attendiMs: ATTESA_PANNELLO_MS },
      );
      const risposta = rispostaDaConsegna(consegna);
      return reply.code(risposta.codice).send(risposta.corpo);
    },
  );

  app.post<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/users/:userId/quarantine/lift',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const consegna = await sendBotCommand(
        {
          action: 'quarantine.lift',
          guildId: context.guildId,
          actorId: context.user.id,
          userId: request.params.userId,
        },
        { attendiMs: ATTESA_PANNELLO_MS },
      );
      const risposta = rispostaDaConsegna(consegna);
      return reply.code(risposta.codice).send(risposta.corpo);
    },
  );

  app.post<{
    Params: { guildId: string; userId: string };
    Body: { reason?: string };
  }>('/api/guilds/:guildId/users/:userId/quarantine', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
    if (!context) return;

    const consegna = await sendBotCommand(
      {
        action: 'quarantine.apply',
        guildId: context.guildId,
        actorId: context.user.id,
        userId: request.params.userId,
        reason: (request.body?.reason ?? `Quarantena decisa da ${context.user.tag}`).slice(0, 400),
      },
      { attendiMs: ATTESA_PANNELLO_MS },
    );
    const risposta = rispostaDaConsegna(consegna);
    return reply.code(risposta.codice).send(risposta.corpo);
  });

  /* ── Predisposizione del server ────────────────────────────────────────
     Crea solo ciò che manca. È idempotente per costruzione: i ruoli e i
     canali si cercano per nome, e un campo già compilato non viene toccato.
     Premerlo dieci volte di fila non produce dieci copie di niente. */

  app.post<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/actions/setup',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const consegna = await sendBotCommand(
        { action: 'server.setup', guildId: context.guildId, actorId: context.user.id },
        { attendiMs: ATTESA_PANNELLO_MS, chiave: `server.setup:${context.guildId}` },
      );
      const risposta = rispostaDaConsegna(consegna);
      return reply.code(risposta.codice).send(risposta.corpo);
    },
  );

  /* ── Esito di un comando ───────────────────────────────────────────────
     Per i comandi che non hanno finito entro l'attesa della richiesta: il
     pannello riceve un identificativo e torna a chiedere. L'esito appartiene
     al server che l'ha chiesto, e a nessun altro. */

  app.get<{ Params: { guildId: string; id: string } }>(
    '/api/guilds/:guildId/bot/esiti/:id',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'VIEWER');
      if (!context) return;

      if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) {
        return reply.code(400).send({ error: 'identificativo non valido' });
      }

      const redis = getRedis();
      const esito = await leggiEsito(redis, request.params.id);
      if (esito && esito.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'esito non trovato' });
      }
      const botInLinea = (await redis.get(Posta.pronto).catch(() => null)) !== null;
      const risposta = rispostaDaConsegna({ id: request.params.id, botInLinea, esito });
      return reply.code(risposta.codice).send(risposta.corpo);
    },
  );

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

    if (!/^\d{17,20}$/.test(request.params.userId)) {
      return reply.code(400).send({ error: 'identificativo utente non valido: sono 17-20 cifre' });
    }

    const consegna = await sendBotCommand(
      {
        action: 'watch.add',
        guildId: context.guildId,
        actorId: context.user.id,
        userId: request.params.userId,
        reason: (request.body?.reason ?? `Sorveglianza avviata da ${context.user.tag}`).slice(0, 500),
        hours: Math.min(Math.max(Math.round(Number(request.body?.hours ?? 0)) || 0, 0), 8760),
      },
      { attendiMs: ATTESA_PANNELLO_MS },
    );
    const risposta = rispostaDaConsegna(consegna);
    return reply.code(risposta.codice).send(risposta.corpo);
  });

  app.delete<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/users/:userId/watch',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const consegna = await sendBotCommand(
        {
          action: 'watch.remove',
          guildId: context.guildId,
          actorId: context.user.id,
          userId: request.params.userId,
        },
        { attendiMs: ATTESA_PANNELLO_MS },
      );
      const risposta = rispostaDaConsegna(consegna);
      return reply.code(risposta.codice).send(risposta.corpo);
    },
  );

  /* ── Voce del bot ──────────────────────────────────────────────────────
     Il pannello non parla con Discord: chiede al bot, che esegue con le
     stesse regole di `/dì`. Nessuna menzione di massa parte da qui, e ogni
     invio resta tracciato con il nome di chi lo ha chiesto. */

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
    if (!body.channelId || !/^\d{17,20}$/.test(body.channelId)) {
      return reply.code(400).send({ error: 'canale mancante' });
    }
    if (body.editMessageId && !/^\d{17,20}$/.test(body.editMessageId)) {
      return reply.code(400).send({ error: 'identificativo del messaggio non valido' });
    }
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

    const consegna = await sendBotCommand(
      {
        action: 'message.send',
        guildId: context.guildId,
        actorId: context.user.id,
        channelId: body.channelId,
        text: (body.text ?? '').slice(0, 1900),
        imageUrl: body.imageUrl ?? null,
        embed: body.embed ?? false,
        title: body.title?.slice(0, 200) ?? null,
        editMessageId: body.editMessageId ?? null,
      },
      { attendiMs: ATTESA_PANNELLO_MS },
    );
    const risposta = rispostaDaConsegna(consegna);
    return reply.code(risposta.codice).send(risposta.corpo);
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
