import 'dotenv/config';
import { getPrisma, disconnectPrisma } from '@angel/db';
import { announceVersion, segnalaNelLog, runningVersion } from '@angel/shared';
import { ascoltaComandiDalPannello } from './core/ascoltoPannello.js';
import { createClient } from './core/client.js';
import { logger } from './core/logger.js';
import { closeRedis, getRedis } from './core/redis.js';
import { subscribeConfigInvalidation } from './core/config.js';
import { registerAllEvents } from './events/index.js';
import { flushBatches } from './logging/auditLogger.js';
import { closeFileSink } from './logging/fileSink.js';
import { invalidateCustomCommands } from './personas/customCommands.js';

/**
 * Avvio del bot.
 *
 * L'ordine è deliberato, e una parte è stata corretta dopo un guasto:
 *
 * • **il database per primo.** Collegarsi a Discord senza database pronto
 *   significa ricevere eventi che non si riescono a registrare, e il primo
 *   minuto dopo un riavvio è proprio quello in cui un attaccante ne approfitta;
 *
 * • **poi Discord**, e solo dopo l'ascolto dei comandi dal pannello. Prima era
 *   il contrario, e costava il bot intero: `subscribe` su una connessione con
 *   `maxRetriesPerRequest: null` non fallisce quando Redis non risponde — resta
 *   in coda, per sempre. L'attesa non finiva mai, `login` non veniva mai
 *   raggiunto, il bot non compariva su Discord, e nei log non c'era una riga
 *   che dicesse dove si era fermato. Adesso niente di ciò che riguarda Redis
 *   può trattenere il collegamento a Discord.
 */
async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.fatal('DISCORD_TOKEN non impostato: impossibile avviare il bot.');
    process.exit(1);
  }

  const prisma = getPrisma();
  await prisma.$queryRaw`SELECT 1`;
  logger.info({ versione: runningVersion() }, 'database raggiungibile');

  // Attesa, e prima di collegarsi a Discord: se il gateway rifiuta la
  // connessione, la versione di questo container si vede lo stesso dal
  // pannello — ed è proprio il caso in cui serve saperla. Senza l'attesa non
  // funzionava: al token rifiutato il processo esce dopo poche centinaia di
  // millisecondi, la scrittura resta per strada, e il pannello dice «non
  // risponde» a un container che invece c'è.
  await announceVersion(getRedis(), 'bot', segnalaNelLog(logger));

  subscribeConfigInvalidation();

  const client = createClient();
  registerAllEvents(client);

  await login(client, token);

  // Dopo il collegamento, e senza `await`: l'ascolto dei comandi riprova per
  // conto suo finché non ci riesce, e nel frattempo il bot difende il server.
  void ascoltaComandiDalPannello(client);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'spegnimento in corso');
    // Le code di log in sospeso vengono svuotate prima di chiudere: gli eventi
    // degli ultimi secondi sono spesso i più interessanti.
    await flushBatches(client).catch(() => undefined);
    await closeFileSink().catch(() => undefined);
    client.destroy();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'promise non gestita');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'eccezione non gestita');
    // Non si esce: un errore in un singolo handler non deve spegnere le difese
    // dell'intero server. Gli errori restano registrati e visibili nel pannello.
  });

  void invalidateCustomCommands;
}

/**
 * Collega il client, traducendo i due rifiuti tipici del gateway in istruzioni.
 *
 * Discord li segnala con messaggi di una riga sola, senza dire cosa fare: con
 * `restart: unless-stopped` il container riparte in ciclo e nei log resta solo
 * lo stack, che non aiuta chi sta installando il bot per la prima volta.
 */
async function login(client: ReturnType<typeof createClient>, token: string): Promise<void> {
  try {
    await client.login(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('disallowed intents')) {
      logger.fatal(
        'Discord ha rifiutato la connessione: intent privilegiati non concessi.\n' +
          'Developer Portal → la tua applicazione → Bot → Privileged Gateway Intents.\n' +
          'Servono accesi TUTTI E TRE: Presence, Server Members, Message Content.\n' +
          'Discord non li concede parzialmente: se ne manca uno chiude la connessione.',
      );
      process.exit(1);
    }

    if (message.includes('invalid token') || message.includes('TOKEN_INVALID')) {
      logger.fatal(
        'Discord ha rifiutato il token. Developer Portal → Bot → Reset Token, ' +
          'poi aggiorna DISCORD_TOKEN. Attenzione a non copiare il client secret al suo posto.',
      );
      process.exit(1);
    }

    throw error;
  }
}

void main().catch((error) => {
  logger.fatal({ err: error }, 'avvio fallito');
  process.exit(1);
});
