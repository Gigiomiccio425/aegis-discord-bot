/* ═══════════════════════════════════════════════════════════════════════
   ANGEL per Twitch — avvio

   Due cose che partono insieme e vivono separate: il motore, che sta in chat,
   e il pannello, che sta su una porta esposta.

   La separazione è il punto. Il requisito era che il bot funzioni «anche
   senza pannello», e qui si mantiene in tre modi:

   1. Il pannello parte **dopo** il motore, e se non parte non lo ferma. Una
      porta occupata, un errore di configurazione, un file mancante nella
      build del pannello: il bot resta in chat.

   2. Il motore non chiama mai il pannello. Il flusso va in una direzione
      sola, e quello che non si chiama non può bloccare.

   3. Senza database il motore parte lo stesso, dalla copia su disco dei
      canali. Il pannello in quel caso non serve a niente — dei dati vive — e
      lo dice invece di restituire pagine vuote.

   ── Le credenziali del bot ─────────────────────────────────────────────

   Servono due cose diverse e vale la pena non confonderle: l'**applicazione**
   Twitch (client id e secret, che identificano il programma) e l'**account**
   da cui il bot parla in chat. Il secondo è un account Twitch normale, che
   autorizza l'applicazione una volta sola e il cui refresh token va nel
   compose. Senza, il bot può leggere ma non scrivere: legge la chat con i
   permessi degli streamer, e per parlare serve una bocca.
   ═══════════════════════════════════════════════════════════════════════ */

import 'dotenv/config';
import { disconnectPrisma, getPrisma } from '@angel/db';
import { announceVersion, runningVersion } from '@angel/shared';
import { logger } from './logger.js';
import { closeRedis, getRedis } from './redis.js';
import { Motore } from './motore.js';
import { avviaPannello } from './pannello/server.js';

/** Porta del pannello degli streamer. Diversa da quella del pannello Discord. */
const PORTA = Number(process.env.TWITCH_PANEL_PORT ?? 781);

function mancante(nome: string): string | null {
  const valore = process.env[nome];
  return valore && valore.trim() ? valore.trim() : null;
}

async function main(): Promise<void> {
  const clientId = mancante('TWITCH_CLIENT_ID');
  const clientSecret = mancante('TWITCH_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    // Non è un errore da far fallire: l'immagine è la stessa per chi usa solo
    // la parte Discord, e uscire con codice diverso da zero farebbe riavviare
    // il container all'infinito per una funzione che nessuno ha chiesto.
    logger.warn(
      'TWITCH_CLIENT_ID o TWITCH_CLIENT_SECRET mancanti: il bot Twitch resta spento. ' +
        'Si accende compilandoli nel compose — le altre parti di ANGEL funzionano lo stesso.',
    );
    return;
  }

  const botId = mancante('TWITCH_BOT_USER_ID');
  const botLogin = mancante('TWITCH_BOT_LOGIN');
  const botToken = mancante('TWITCH_BOT_ACCESS_TOKEN');
  const botRefresh = mancante('TWITCH_BOT_REFRESH_TOKEN');

  if (!botId || !botLogin || !botToken) {
    logger.warn(
      'Credenziali dell’account bot mancanti (TWITCH_BOT_USER_ID, TWITCH_BOT_LOGIN, ' +
        'TWITCH_BOT_ACCESS_TOKEN): il bot Twitch resta spento. Sono le credenziali ' +
        'dell’account da cui il bot parla in chat, non quelle dell’applicazione.',
    );
    return;
  }

  void announceVersion(getRedis(), 'twitch');
  logger.info({ versione: runningVersion(), bot: botLogin }, 'ANGEL per Twitch');

  const motore = new Motore({
    clientId,
    clientSecret,
    bot: {
      id: botId,
      login: botLogin,
      accessToken: botToken,
      refreshToken: botRefresh,
    },
    hostMalevolo: await caricaBlocklist(),
  });

  await motore.avvia();

  /*
   * Il pannello dopo, e in un `catch` che non propaga.
   *
   * È la riga che mantiene la promessa: qualunque cosa vada storta qui —
   * porta occupata, build del pannello mancante, Redis che non risponde al
   * limite di frequenza — il bot resta in chat con i suoi comandi.
   */
  const publicUrl = mancante('TWITCH_PUBLIC_URL') ?? `http://localhost:${PORTA}`;

  const pannello = await avviaPannello({
    motore,
    clientId,
    clientSecret,
    publicUrl,
    porta: PORTA,
  }).catch((errore: unknown) => {
    logger.error(
      { err: errore, porta: PORTA },
      'pannello non avviato: il bot resta in chat e continua a moderare. ' +
        'Si governa con `!angel` finché non si risolve.',
    );
    return null;
  });

  const spegni = async (segnale: string): Promise<void> => {
    logger.info({ segnale }, 'spegnimento');
    await pannello?.close().catch(() => undefined);
    await motore.ferma();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void spegni('SIGTERM'));
  process.on('SIGINT', () => void spegni('SIGINT'));
  process.on('unhandledRejection', (motivo) =>
    logger.error({ err: motivo }, 'promise non gestita'),
  );
}

/**
 * Le blocklist già scaricate per il bot Discord.
 *
 * URLhaus, Phishing.Database e le firme raccolte dallo scanner sono
 * aggiornate ogni sei ore dal worker: usarle qui costa una query all'avvio e
 * un aggiornamento periodico, mentre tenerne una copia propria significherebbe
 * scaricare due volte le stesse centinaia di migliaia di righe.
 *
 * Vive in memoria come `Set`: la valutazione di un messaggio non può
 * permettersi una query, e un `Set` da qualche centinaio di migliaia di voci
 * occupa qualche decina di megabyte e risponde in microsecondi.
 */
async function caricaBlocklist(): Promise<(host: string) => boolean> {
  const domini = new Set<string>();

  const ricarica = async (): Promise<void> => {
    try {
      const righe = await getPrisma().threatSignature.findMany({
        where: {
          kind: 'DOMAIN',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { value: true },
        take: 500_000,
      });

      domini.clear();
      for (const riga of righe) domini.add(riga.value.toLowerCase());
      logger.info({ domini: domini.size }, 'blocklist condivisa caricata');
    } catch (errore) {
      // Senza blocklist il modulo dei link funziona lo stesso: restano le
      // regole locali, i domini noti e il riconoscimento delle imitazioni.
      logger.warn({ err: errore }, 'blocklist condivisa non caricata: uso le sole regole locali');
    }
  };

  await ricarica();
  const timer = setInterval(() => void ricarica(), 3_600_000);
  timer.unref?.();

  return (host: string) => domini.has(host) || domini.has(host.replace(/^www\./, ''));
}

void main().catch((errore) => {
  logger.fatal({ err: errore }, 'avvio del bot Twitch fallito');
  process.exit(1);
});
