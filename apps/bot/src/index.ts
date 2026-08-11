import 'dotenv/config';
import { getPrisma, disconnectPrisma } from '@angel/db';
import { RedisKeys } from '@angel/shared';
import { createClient } from './core/client.js';
import { logger } from './core/logger.js';
import { closeRedis, getSubscriber } from './core/redis.js';
import { subscribeConfigInvalidation } from './core/config.js';
import { registerAllEvents } from './events/index.js';
import { flushBatches } from './logging/auditLogger.js';
import { closeFileSink } from './logging/fileSink.js';
import { invalidateCustomCommands } from './personas/customCommands.js';
import { handlePanelCommand } from './core/panelCommands.js';

/**
 * Avvio del bot.
 *
 * L'ordine è deliberato: prima database e Redis, poi le sottoscrizioni ai
 * canali del pannello, e solo alla fine il collegamento al gateway. Connettersi
 * a Discord prima di avere il database pronto significherebbe ricevere eventi
 * che non è ancora possibile registrare — e il primo minuto dopo un riavvio è
 * proprio quello in cui un attaccante approfitta della finestra.
 */
async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.fatal('DISCORD_TOKEN non impostato: impossibile avviare il bot.');
    process.exit(1);
  }

  const prisma = getPrisma();
  await prisma.$queryRaw`SELECT 1`;
  logger.info('database raggiungibile');

  subscribeConfigInvalidation();

  const client = createClient();
  registerAllEvents(client);

  // Canale di comando dal pannello: lockdown, ricarica comandi, emergenza.
  const subscriber = getSubscriber();
  await subscriber.subscribe(RedisKeys.commandChannel);
  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== RedisKeys.commandChannel) return;
    void handlePanelCommand(client, message).catch((error) =>
      logger.error({ err: error }, 'comando dal pannello fallito'),
    );
  });

  await login(client, token);

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
