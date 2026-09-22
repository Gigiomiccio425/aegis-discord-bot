import type { FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import { RedisKeys } from '@angel/shared';
import { logger } from './logger.js';

let client: Redis | null = null;
let subscriber: Redis | null = null;

function create(url: string): Redis {
  const instance = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  instance.on('error', (error: Error) => logger.error({ err: error }, 'errore Redis'));
  return instance;
}

export function getRedis(url = process.env.REDIS_URL): Redis {
  if (client) return client;
  if (!url) throw new Error('REDIS_URL non impostata');
  client = create(url);
  return client;
}

export function getSubscriber(url = process.env.REDIS_URL): Redis {
  if (subscriber) return subscriber;
  if (!url) throw new Error('REDIS_URL non impostata');
  subscriber = create(url);
  return subscriber;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([client?.quit(), subscriber?.quit()]);
  client = subscriber = null;
}

/**
 * Invia un comando al bot.
 *
 * Il pannello non parla mai direttamente con il gateway Discord: pubblica
 * un'intenzione, il bot la esegue. Un solo processo connesso a Discord
 * significa rate limit gestiti in un punto solo e pannello riavviabile senza
 * far cadere la connessione.
 *
 * Restituisce quanti l'hanno ricevuto. Redis lo dice sempre, e per settimane
 * questo numero è stato buttato via: con zero ricevitori il pannello
 * rispondeva «fatto» a un comando che nessuno aveva sentito. Era la riga che
 * avrebbe detto subito dov'era il guasto — il bot e il pannello collegati a
 * due Redis diversi — e non veniva mai scritta.
 *
 * Non lancia, di proposito: alcuni chiamanti la usano dopo un salvataggio
 * già riuscito, e un errore qui farebbe sembrare fallito quello.
 */
export async function sendBotCommand(command: Record<string, unknown>): Promise<number> {
  const ricevitori = await getRedis().publish(RedisKeys.commandChannel, JSON.stringify(command));

  if (ricevitori === 0) {
    logger.warn(
      { azione: command.action, guildId: command.guildId, ricevitori },
      'comando pubblicato, ma nessuno l’ha ricevuto: il bot non è in ascolto su questo Redis. ' +
        'Se il bot risulta collegato a Discord, il pannello e il bot stanno usando due Redis ' +
        'diversi — controlla REDIS_URL.',
    );
  }

  return ricevitori;
}

/**
 * Il testo per chi ha premuto un pulsante il cui comando non è arrivato a
 * nessuno. Dice cosa è successo e cosa fare, non solo che è andata male.
 */
export const BOT_NON_IN_ASCOLTO =
  'Il bot non ha ricevuto il comando: non è in ascolto in questo momento. ' +
  'Riprova fra poco; se continua, guarda nei log del container se il bot è collegato.';

/**
 * La risposta per un comando che nessuno ha ricevuto.
 *
 * Prima il pannello rispondeva «fatto» comunque: è così che per settimane
 * lockdown e backup sono sembrati eseguiti senza che succedesse niente. Si
 * usa solo nelle rotte in cui il comando **è** l'azione. Dove parte dopo un
 * salvataggio già riuscito — la configurazione, i comandi personalizzati —
 * un errore farebbe sembrare fallito un salvataggio andato bene, e lì basta
 * la riga di log di `sendBotCommand`.
 */
export function botNonInAscolto(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ error: BOT_NON_IN_ASCOLTO });
}
