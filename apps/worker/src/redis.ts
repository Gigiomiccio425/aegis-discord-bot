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

/* ═══════════════════════════════════════════════════════════════════════
   UNA CONNESSIONE PER CIASCUNO, E PERCHÉ NON SI CONDIVIDE

   Un `Worker` di BullMQ aspetta i lavori con un comando **bloccante**
   (`bzpopmin`), e quando gli si passa un'istanza di ioredis la usa così com'è:
   nel suo sorgente, `this._client = wrapRedisInstance(opts)` — nessun
   duplicato — con `blockingConnection: true`.

   ioredis manda i comandi su una socket sola, in ordine. Dieci Worker che
   bloccano a turno sulla stessa connessione significa che ogni altro comando
   aspetta dietro di loro: con `drainDelay` a cinque secondi per Worker, un
   `SET` può restare fermo decine di secondi.

   Il sintomo non assomiglia alla causa. La chiave `version:worker` scade dopo
   180 secondi e il battito la riscrive ogni 60: se le scritture arrivano in
   ritardo, la chiave scade e il pannello scrive «worker: fermo» — di un
   processo vivo, che sta lavorando.
   ═══════════════════════════════════════════════════════════════════════ */

const nate: Redis[] = [];

/**
 * Una connessione nuova, per un solo `Worker`.
 *
 * Va chiamata una volta per Worker. Riusarne una per due significa rimettere
 * esattamente il guasto che questa funzione esiste per togliere.
 */
export function connessionePerCoda(url = process.env.REDIS_URL): Redis {
  if (!url) throw new Error('REDIS_URL non impostata');
  const nuova = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  nuova.on('error', (error: Error) => log.error({ err: error }, 'errore connessione di coda'));
  nate.push(nuova);
  return nuova;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    client?.quit().catch(() => undefined),
    ...nate.map((connessione) => connessione.quit().catch(() => undefined)),
  ]);
  nate.length = 0;
  client = null;
}
