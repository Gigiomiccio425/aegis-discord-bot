import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@aegis/db';
import {
  authorizeUrl,
  canManageGuild,
  ownerIds,
  ownersOnly,
  clearSessionCookie,
  createSession,
  exchangeCode,
  fetchDiscordUser,
  fetchUserGuilds,
  generateState,
  getSessionUser,
  setSessionCookie,
} from '../auth.js';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Avvio del flusso OAuth.
   *
   * Lo `state` è conservato in Redis con scadenza breve: serve contro il CSRF
   * sul callback, e tenerlo lato server invece che in un cookie evita che un
   * attaccante possa fabbricarne uno valido.
   */
  app.get('/api/auth/login', async (request, reply) => {
    const state = generateState();
    await getRedis().set(`oauth:state:${state}`, '1', 'EX', 600);
    return reply.redirect(authorizeUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/callback',
    async (request, reply) => {
      const { code, state, error } = request.query;

      if (error) return reply.redirect('/?errore=accesso_negato');
      if (!code || !state) return reply.redirect('/?errore=parametri_mancanti');

      const redis = getRedis();
      const valid = await redis.del(`oauth:state:${state}`);
      if (valid !== 1) return reply.redirect('/?errore=stato_non_valido');

      const tokens = await exchangeCode(code);
      if (!tokens) return reply.redirect('/?errore=scambio_fallito');

      const user = await fetchDiscordUser(tokens.accessToken);
      if (!user) return reply.redirect('/?errore=utente_non_recuperato');

      /**
       * Pannello riservato ai proprietari.
       *
       * Il controllo si fa qui, prima di creare la sessione: rifiutare più
       * avanti lascerebbe comunque un cookie valido in circolazione. Chi non è
       * in elenco non ottiene nulla, nemmeno una sessione vuota.
       */
      if (ownersOnly() && !ownerIds().includes(user.id)) {
        logger.warn(
          { userId: user.id, tag: user.username, ip: request.ip },
          'accesso al pannello rifiutato: utente non fra i proprietari',
        );
        return reply.redirect('/?errore=non_autorizzato');
      }

      const sessionId = await createSession(user, tokens, request);
      setSessionCookie(reply, sessionId);

      // I server amministrati dall'utente vengono messi in cache: l'elenco
      // richiede il token OAuth, che non si vuole riusare a ogni chiamata.
      const guilds = await fetchUserGuilds(tokens.accessToken);
      const managed = guilds.filter(canManageGuild);
      await redis.set(
        `panel:guilds:${user.id}`,
        JSON.stringify(managed),
        'EX',
        900,
      );

      const prisma = getPrisma();
      // Il primo accesso di chi amministra un server gli assegna il ruolo ADMIN
      // sul pannello, ma solo per i server dove il bot è presente.
      for (const guild of managed) {
        const known = await prisma.guild.findUnique({ where: { id: guild.id } });
        if (!known) continue;
        await prisma.panelAccess
          .upsert({
            where: { guildId_userId: { guildId: guild.id, userId: user.id } },
            create: { guildId: guild.id, userId: user.id, role: 'ADMIN', grantedBy: 'system' },
            update: { lastLoginAt: new Date() },
          })
          .catch(() => undefined);
      }

      // L'accesso al pannello va nel registro consultabile, non solo su stdout:
      // è un'azione con effetti sul server, e chi la compie deve risultare.
      for (const guild of managed) {
        const known = await prisma.guild.findUnique({ where: { id: guild.id } });
        if (!known) continue;
        await prisma.auditEvent
          .create({
            data: {
              guildId: guild.id,
              type: 'PANEL_LOGIN',
              category: 'BOT',
              actorId: user.id,
              actorTag: user.global_name ?? user.username,
              severity: 10,
              summary: `Accesso al pannello da ${request.ip}`,
              payload: {
                ip: request.ip,
                userAgent: request.headers['user-agent']?.slice(0, 200) ?? null,
              },
            },
          })
          .catch(() => undefined);
      }

      logger.info({ userId: user.id, guilds: managed.length }, 'accesso al pannello');
      return reply.redirect('/');
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const session = await getSessionUser(request);
    if (session) {
      const prisma = getPrisma();
      await prisma.panelSession
        .update({ where: { id: session.sessionId }, data: { revokedAt: new Date() } })
        .catch(() => undefined);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const session = await getSessionUser(request);
    if (!session) return reply.code(401).send({ error: 'non autenticato' });

    const redis = getRedis();
    const cached = await redis.get(`panel:guilds:${session.id}`);
    const managed = cached
      ? (JSON.parse(cached) as { id: string; name: string; icon: string | null }[])
      : [];

    const prisma = getPrisma();
    const access = await prisma.panelAccess.findMany({ where: { userId: session.id } });
    const accessMap = new Map(access.map((entry) => [entry.guildId, entry.role]));

    const known = await prisma.guild.findMany({
      where: { id: { in: [...accessMap.keys()] }, active: true },
      select: { id: true, name: true, iconHash: true, memberCount: true },
    });

    return {
      user: { id: session.id, tag: session.tag, avatar: session.avatar },
      guilds: known.map((guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.iconHash,
        memberCount: guild.memberCount,
        role: accessMap.get(guild.id),
      })),
      // I server dove l'utente è amministratore ma il bot non è ancora entrato:
      // servono a mostrare l'invito nel pannello.
      pendingInvite: managed
        .filter((guild) => !known.some((entry) => entry.id === guild.id))
        .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon })),
    };
  });

  /** Sessioni attive dell'utente, con possibilità di revocarle. */
  app.get('/api/auth/sessions', async (request, reply) => {
    const session = await getSessionUser(request);
    if (!session) return reply.code(401).send({ error: 'non autenticato' });

    const prisma = getPrisma();
    const sessions = await prisma.panelSession.findMany({
      where: { userId: session.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, lastSeenAt: true, ip: true, userAgent: true },
    });

    return sessions.map((entry) => ({ ...entry, current: entry.id === session.sessionId }));
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (request, reply) => {
    const session = await getSessionUser(request);
    if (!session) return reply.code(401).send({ error: 'non autenticato' });

    const prisma = getPrisma();
    await prisma.panelSession.updateMany({
      where: { id: request.params.id, userId: session.id },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  });
}
