// `import Redis from 'ioredis'` sotto NodeNext restituisce il namespace del
// modulo CommonJS, non la classe: serve l'export nominato.
import { Redis } from 'ioredis';
import { childLogger } from './logger.js';

const log = childLogger('redis');

/**
 * Tre connessioni distinte, non una sola.
 *
 * Una connessione in modalità subscribe non può eseguire altri comandi: se si
 * riusasse la stessa istanza, ogni scrittura fallirebbe appena il bot si mette
 * in ascolto degli aggiornamenti dal pannello.
 */
let main: Redis | null = null;
let subscriber: Redis | null = null;
let publisher: Redis | null = null;

function create(url: string, role: string): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null, // richiesto da BullMQ
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  client.on('error', (error: Error) => log.error({ err: error, role }, 'errore connessione Redis'));
  client.on('ready', () => log.debug({ role }, 'Redis pronto'));
  return client;
}

export function getRedis(url = process.env.REDIS_URL): Redis {
  if (main) return main;
  if (!url) throw new Error('REDIS_URL non impostata');
  main = create(url, 'main');
  return main;
}

export function getSubscriber(url = process.env.REDIS_URL): Redis {
  if (subscriber) return subscriber;
  if (!url) throw new Error('REDIS_URL non impostata');
  subscriber = create(url, 'subscriber');
  return subscriber;
}

export function getPublisher(url = process.env.REDIS_URL): Redis {
  if (publisher) return publisher;
  if (!url) throw new Error('REDIS_URL non impostata');
  publisher = create(url, 'publisher');
  return publisher;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([main?.quit(), subscriber?.quit(), publisher?.quit()]);
  main = subscriber = publisher = null;
}

/**
 * Contatore su finestra scorrevole.
 *
 * Implementato con un sorted set anziché con un semplice INCR+EXPIRE: una
 * finestra fissa lascerebbe passare il doppio degli eventi a cavallo di due
 * finestre, e per l'anti-raid quel doppio è esattamente l'attacco.
 * Lo script Lua rende l'operazione atomica, altrimenti sotto raid le corse
 * critiche falserebbero il conteggio.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return redis.call('ZCARD', key)
`;

export async function slidingWindowCount(
  key: string,
  windowMs: number,
  member: string,
  client: Redis = getRedis(),
): Promise<number> {
  const result = await client.eval(
    SLIDING_WINDOW_SCRIPT,
    1,
    key,
    Date.now().toString(),
    windowMs.toString(),
    member,
  );
  return Number(result);
}

/** Elementi presenti nella finestra, per sapere *chi* ha partecipato a un raid. */
export async function slidingWindowMembers(
  key: string,
  windowMs: number,
  client: Redis = getRedis(),
): Promise<string[]> {
  const min = Date.now() - windowMs;
  return client.zrangebyscore(key, min, '+inf');
}

export async function clearWindow(key: string, client: Redis = getRedis()): Promise<void> {
  await client.del(key);
}
