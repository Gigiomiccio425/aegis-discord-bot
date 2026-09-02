import { Redis } from 'ioredis';
import { childLogger } from './logger.js';

const log = childLogger('redis');

let client: Redis | null = null;

export function getRedis(url = process.env.REDIS_URL): Redis {
  if (client) return client;
  if (!url) throw new Error('REDIS_URL non impostata');
  client = new Redis(url, {
    // BullMQ richiede che i comandi bloccanti non abbiano un limite di tentativi.
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  client.on('error', (error: Error) => log.error({ err: error }, 'errore connessione Redis'));
  return client;
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined);
  client = null;
}
