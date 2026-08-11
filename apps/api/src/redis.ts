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
 */
export async function sendBotCommand(command: Record<string, unknown>): Promise<void> {
  await getRedis().publish(RedisKeys.commandChannel, JSON.stringify(command));
}
