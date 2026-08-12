import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getPrisma } from '@angel/db';
import { GuildConfigSchema } from '@angel/shared';
import { safeEqual } from '../crypto.js';
import { logger } from '../logger.js';
import { getRedis } from '../redis.js';

/* ═══════════════════════════════════════════════════════════════════════
   WEBHOOK TWITCH (EventSub)

   Due regole non negoziabili del protocollo:

   1. Al momento della sottoscrizione Twitch invia un messaggio di verifica e
      si aspetta come risposta la stringa `challenge` in chiaro, con stato 200.
      Rispondere JSON, o con qualsiasi altra cosa, lascia la sottoscrizione in
      attesa per sempre.

   2. Ogni messaggio va verificato con HMAC-SHA256 su
      `messageId + timestamp + corpo grezzo`. Senza questa verifica chiunque
      conosca l'URL può far annunciare una diretta inesistente.

   Il corpo va confrontato *grezzo*: rifarne il JSON.stringify dopo il parsing
   cambia gli spazi e la firma non torna più.
   ═══════════════════════════════════════════════════════════════════════ */

interface TwitchNotification {
  subscription: { id: string; type: string };
  event?: {
    broadcaster_user_id: string;
    broadcaster_user_login: string;
    broadcaster_user_name: string;
  };
  challenge?: string;
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/webhooks/twitch',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const secret = process.env.TWITCH_EVENTSUB_SECRET;
      if (!secret) return reply.code(503).send('integrazione Twitch non configurata');

      const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      if (!verifySignature(request, raw, secret)) {
        logger.warn({ ip: request.ip }, 'firma EventSub non valida');
        return reply.code(403).send('firma non valida');
      }

      const messageType = request.headers['twitch-eventsub-message-type'];
      const body = request.body as TwitchNotification;

      // Verifica della sottoscrizione: risposta in testo semplice, nient'altro.
      if (messageType === 'webhook_callback_verification') {
        return reply.type('text/plain').code(200).send(body.challenge ?? '');
      }

      if (messageType === 'revocation') {
        logger.warn({ subscription: body.subscription.id }, 'sottoscrizione EventSub revocata');
        await getPrisma()
          .twitchSubscription.updateMany({
            where: { eventsubId: body.subscription.id },
            data: { eventsubId: null },
          })
          .catch(() => undefined);
        return reply.code(204).send();
      }

      if (messageType !== 'notification' || !body.event) return reply.code(204).send();

      // Deduplicazione: Twitch ripete la consegna se non riceve un 2xx in
      // tempo, e senza questo controllo lo stesso annuncio uscirebbe due volte.
      const messageId = request.headers['twitch-eventsub-message-id'] as string | undefined;
      if (messageId) {
        const fresh = await getRedis().set(`twitch:msg:${messageId}`, '1', 'EX', 600, 'NX');
        if (fresh === null) return reply.code(204).send();
      }

      // La risposta va data subito: Twitch considera fallita una consegna che
      // supera i 10 secondi. L'annuncio prosegue in background.
      void handleNotification(body).catch((error) =>
        logger.error({ err: error }, 'gestione evento Twitch fallita'),
      );

      return reply.code(204).send();
    },
  );
}

function verifySignature(request: FastifyRequest, raw: string, secret: string): boolean {
  const messageId = request.headers['twitch-eventsub-message-id'];
  const timestamp = request.headers['twitch-eventsub-message-timestamp'];
  const signature = request.headers['twitch-eventsub-message-signature'];

  if (
    typeof messageId !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof signature !== 'string'
  ) {
    return false;
  }

  // Messaggi troppo vecchi rifiutati: senza questo controllo una firma valida
  // catturata in passato potrebbe essere riusata all'infinito.
  const age = Date.now() - new Date(timestamp).getTime();
  if (Number.isNaN(age) || Math.abs(age) > 600_000) return false;

  const expected =
    'sha256=' +
    createHmac('sha256', secret)
      .update(messageId + timestamp + raw)
      .digest('hex');

  return safeEqual(expected, signature);
}

async function handleNotification(body: TwitchNotification): Promise<void> {
  if (!body.event) return;
  const prisma = getPrisma();

  // Il tipo va filtrato: lo stesso canale Twitch ha una riga per l'inizio della
  // diretta e una per la fine, e senza filtro un evento di inizio verrebbe
  // trattato una volta per riga — cioè annunciato due volte.
  const subscriptions = await prisma.twitchSubscription.findMany({
    where: {
      twitchUserId: body.event.broadcaster_user_id,
      eventsubType: body.subscription.type,
      enabled: true,
    },
  });

  // Un server può avere due righe per lo stesso canale Twitch — una per
  // `stream.online` e una per `stream.offline` — e senza questo la fine della
  // diretta verrebbe messa in coda due volte.
  const finiti = new Set<string>();

  for (const subscription of subscriptions) {
    if (body.subscription.type === 'stream.offline') {
      if (finiti.has(subscription.guildId)) continue;
      finiti.add(subscription.guildId);

      await prisma.twitchSubscription.update({
        where: { id: subscription.id },
        data: { lastLiveAt: null },
      });

      // Il ruolo «in diretta» lo toglie il worker, che ha il client REST: qui
      // si accoda soltanto. Senza questo passaggio il ruolo resterebbe addosso
      // fino al riavvio successivo, cioè per giorni.
      await getRedis().lpush(
        'twitch:announce',
        JSON.stringify({
          guildId: subscription.guildId,
          login: subscription.twitchLogin,
          userId: subscription.twitchUserId,
          fine: true,
        }),
      );
      continue;
    }

    const guild = await prisma.guild.findUnique({ where: { id: subscription.guildId } });
    if (!guild) continue;

    const parsed = GuildConfigSchema.safeParse(guild.config);
    if (!parsed.success) continue;

    const streamer = parsed.data.integrations.twitch.streamers.find(
      (entry) => entry.login.toLowerCase() === subscription.twitchLogin,
    );
    if (!streamer) continue;

    const recentlyAnnounced =
      subscription.lastAnnouncedAt &&
      Date.now() - subscription.lastAnnouncedAt.getTime() < streamer.cooldownMinutes * 60_000;
    if (recentlyAnnounced) continue;

    // L'annuncio vero e proprio lo pubblica il worker, che ha già il client
    // REST e la logica dei template: qui si accoda soltanto.
    await getRedis().lpush(
      'twitch:announce',
      JSON.stringify({
        guildId: subscription.guildId,
        login: subscription.twitchLogin,
        userId: subscription.twitchUserId,
      }),
    );

    await prisma.twitchSubscription.update({
      where: { id: subscription.id },
      data: { lastLiveAt: new Date(), lastAnnouncedAt: new Date() },
    });
  }
}
