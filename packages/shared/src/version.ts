/* ═══════════════════════════════════════════════════════════════════════
   VERSIONE DEI PROCESSI

   I quattro servizi — migrazione, bot, worker, pannello — usano la stessa
   immagine ma sono container distinti. Un aggiornamento può ricrearne tre su
   quattro: succede quando l'ambiente di destinazione conserva una propria
   copia della definizione, come fa l'app store di ZimaOS espandendo le àncore
   YAML al momento dell'installazione.

   Il guasto che ne deriva è il peggiore da diagnosticare, perché non assomiglia
   a un guasto: il pannello mostra la versione nuova, il bot continua a
   comportarsi come prima, e la conclusione naturale è che la correzione non
   funzioni.

   Ogni processo dichiara qui la propria versione, con una scadenza. Il
   pannello le confronta e segnala chi è rimasto indietro, con il nome esatto
   del container da ricreare.
   ═══════════════════════════════════════════════════════════════════════ */

import { RedisKeys, VERSION_HEARTBEAT_SEC, VERSION_TTL_SEC } from './index.js';

export type ServiceName = 'bot' | 'worker' | 'api';

/** Versione scritta nell'immagine dalla CI. `sviluppo` quando manca. */
export function runningVersion(): string {
  return process.env.ANGEL_VERSION ?? 'sviluppo';
}

/** Minimo indispensabile del client Redis, per non legare questo modulo a ioredis. */
interface RedisLike {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/**
 * Dichiara la propria versione e continua a riaffermarla.
 *
 * Il battito serve perché la chiave scade: senza, un servizio spento
 * resterebbe nell'elenco per sempre e un container morto sembrerebbe vivo e
 * aggiornato — che è esattamente il contrario di ciò che questo meccanismo
 * deve dire.
 */
export function announceVersion(redis: RedisLike, service: ServiceName): NodeJS.Timeout {
  const write = (): void => {
    void redis
      .set(RedisKeys.serviceVersion(service), runningVersion(), 'EX', VERSION_TTL_SEC)
      .catch(() => undefined);
  };

  write();
  const timer = setInterval(write, VERSION_HEARTBEAT_SEC * 1000);
  // Non deve tenere vivo il processo da solo.
  timer.unref?.();
  return timer;
}

export interface ServiceVersions {
  /** Versione per servizio; `null` per chi non risponde. */
  services: Record<ServiceName, string | null>;
  /** Tutti i servizi vivi girano la stessa versione? */
  aligned: boolean;
  /** Chi è rimasto indietro, o non risponde affatto. */
  stale: ServiceName[];
}

const ALL: ServiceName[] = ['bot', 'worker', 'api'];

export async function readServiceVersions(
  redis: RedisLike,
  expected = runningVersion(),
): Promise<ServiceVersions> {
  const entries = await Promise.all(
    ALL.map(async (service) => {
      const value = await redis.get(RedisKeys.serviceVersion(service)).catch(() => null);
      return [service, value] as const;
    }),
  );

  const services = Object.fromEntries(entries) as Record<ServiceName, string | null>;
  // Chi non risponde è «indietro» quanto chi risponde con la versione
  // sbagliata: in entrambi i casi non sta girando ciò che dovrebbe.
  const stale = ALL.filter((service) => services[service] !== expected);

  return { services, aligned: stale.length === 0, stale };
}
