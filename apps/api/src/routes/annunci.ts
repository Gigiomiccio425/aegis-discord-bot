import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@angel/db';
import { requireGuild } from '../guard.js';

/**
 * La stessa regola che applica il worker: HTTPS **e** porta 443.
 *
 * Duplicarla qui sarebbe stato più rapido e sarebbe divergito al primo
 * cambiamento: il pannello direbbe che va bene mentre il worker rifiuta, o il
 * contrario, e nessuno dei due avrebbe torto guardando solo il proprio codice.
 */
function callbackValido(url: string): boolean {
  try {
    const indirizzo = new URL(url);
    if (indirizzo.protocol !== 'https:') return false;
    return indirizzo.port === '' || indirizzo.port === '443';
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   STATO DELLE FONTI

   «Non funziona» è una diagnosi che non esiste. Le cose che possono fermare un
   annuncio sono cinque, tutte silenziose: le credenziali Twitch mancanti, il
   modulo spento, la voce sospesa, la fonte che risponde con un errore, e il
   fatto che semplicemente non sia ancora uscito niente di nuovo.

   Dal pannello si vedevano solo le prime tre — le altre due stavano nei log
   del container, cioè dove non guarda chi si sta chiedendo perché l'annuncio
   non è arrivato. Qui ci sono tutte e cinque, ognuna con la sua data.
   ═══════════════════════════════════════════════════════════════════════ */

export async function annunciRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/annunci/stato',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const [fonti, twitch] = await Promise.all([
        prisma.socialSource.findMany({
          where: { guildId: context.guildId },
          orderBy: { lastCheckedAt: 'desc' },
          take: 100,
        }),
        prisma.twitchSubscription.findMany({
          where: { guildId: context.guildId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);

      const publicUrl = process.env.PUBLIC_URL ?? '';

      return {
        /*
         * Lo stato dell'ambiente, che nessuna configurazione può raccontare.
         * Nessun segreto esce da qui: solo se ci sia o meno qualcosa dentro.
         */
        ambiente: {
          twitchCredenziali: Boolean(
            process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET,
          ),
          twitchEventsubSegreto: Boolean(process.env.TWITCH_EVENTSUB_SECRET),
          // EventSub richiede un indirizzo pubblico in HTTPS: Twitch deve poter
          // chiamare il callback. Con un indirizzo interno o in HTTP resta il
          // controllo periodico, più lento ma funzionante.
          callbackPubblico: callbackValido(publicUrl),
          publicUrl,
        },
        fonti: fonti.map((fonte) => ({
          piattaforma: fonte.platform,
          identificativo: fonte.identifier,
          nome: fonte.displayName,
          ultimoControllo: fonte.lastCheckedAt,
          ultimoElemento: fonte.lastItemAt,
          errori: fonte.failureCount,
          ultimoErrore: fonte.lastError,
        })),
        twitch: twitch.map((riga) => ({
          login: riga.twitchLogin,
          tipo: riga.eventsubType,
          eventsubAttivo: riga.eventsubId !== null,
          inDirettaDa: riga.lastLiveAt,
          ultimoAnnuncio: riga.lastAnnouncedAt,
          ultimoControlloClip: riga.lastClipCheckAt,
        })),
      };
    },
  );
}
