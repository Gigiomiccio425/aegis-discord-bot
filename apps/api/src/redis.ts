import { Redis } from 'ioredis';
import { inviaAlBot, type ComandoBot, type Consegna } from '@angel/shared';
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
 * Il pannello non parla mai direttamente con il gateway Discord: chiede, e il
 * bot esegue. Passa dalla posta (`@angel/shared`), non più dal pub/sub: il
 * comando resta in coda se il bot è giù, e l'esito torna indietro.
 *
 * Con `attendiMs` aspetta l'esito; senza, ritorna appena il comando è in coda.
 */
export async function sendBotCommand(
  command: ComandoBot,
  opzioni: { attendiMs?: number; chiave?: string } = {},
): Promise<Consegna> {
  return inviaAlBot(getRedis(), command, opzioni);
}

/** Quanto il pannello aspetta l'esito prima di rispondere «in corso». */
export const ATTESA_PANNELLO_MS = 12_000;

/**
 * Da una consegna alla risposta HTTP.
 *
 * Un comando fallito risponde con un errore e il motivo scritto dal bot, che
 * il pannello mostra così com'è: «manca Gestisci ruoli» vale più di qualunque
 * codice. Uno non ancora finito risponde 202 con l'identificativo, per
 * chiederne l'esito dopo.
 */
export function rispostaDaConsegna(consegna: Consegna): {
  codice: number;
  corpo: Record<string, unknown>;
} {
  const esito = consegna.esito;
  if (esito?.stato === 'fatto') {
    return {
      codice: 200,
      corpo: { ok: true, stato: 'fatto', messaggio: esito.messaggio, dati: esito.dati ?? null },
    };
  }
  if (esito?.stato === 'scaduto') {
    return { codice: 504, corpo: { error: esito.messaggio, stato: 'scaduto' } };
  }
  if (esito?.stato === 'fallito') {
    return { codice: 502, corpo: { error: esito.messaggio, stato: 'fallito' } };
  }
  return {
    codice: 202,
    corpo: {
      ok: true,
      stato: 'in-corso',
      id: consegna.id,
      botInLinea: consegna.botInLinea,
      messaggio: consegna.botInLinea
        ? 'Il bot ci sta lavorando.'
        : 'Il bot non è collegato a Discord in questo momento: il comando è in coda e parte ' +
          'appena torna, se entro qualche minuto.',
    },
  };
}
