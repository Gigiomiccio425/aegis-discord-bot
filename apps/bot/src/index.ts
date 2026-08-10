import 'dotenv/config';
import { getPrisma, disconnectPrisma } from '@aegis/db';
import { RedisKeys } from '@aegis/shared';
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

  await client.login(token);

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

void main().catch((error) => {
  logger.fatal({ err: error }, 'avvio fallito');
  process.exit(1);
});
