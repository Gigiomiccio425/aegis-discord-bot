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

export type ServiceName = 'bot' | 'worker' | 'api' | 'twitch';

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
 * Quanto si aspetta la prima dichiarazione prima di proseguire.
 *
 * Serve un tetto perché con Redis irraggiungibile ioredis non fallisce: mette
 * i comandi in coda e li tiene lì. Senza, l'attesa non finirebbe mai, e
 * bloccherebbe l'avvio proprio quando conviene partire lo stesso per poter
 * dire cosa non va.
 */
const PRIMA_ATTESA_MS = 2000;

/**
 * Cosa può andare storto in una dichiarazione, detto a parole.
 *
 * Prima non lo diceva nessuno: la scrittura aveva `() => undefined` su
 * entrambi i rami, quindi un rifiuto di Redis spariva. Il sintomo era il
 * pannello che scriveva «bot: fermo» per un processo vivo e funzionante, e
 * nessuna riga da nessuna parte che dicesse perché.
 */
export type ProblemaVersione =
  | { tipo: 'scrittura'; errore: unknown }
  | { tipo: 'lenta'; attesaMs: number }
  | { tipo: 'rilettura'; letto: string | null; atteso: string };

/**
 * Una scrittura sola: non solleva mai, non aspetta oltre il tetto, e dice
 * cosa è andato storto invece di ingoiarlo.
 */
async function scrivi(
  redis: RedisLike,
  service: ServiceName,
  attesaMs: number,
  segnala?: (problema: ProblemaVersione) => void,
): Promise<void> {
  let finita = false;

  const set = redis
    .set(RedisKeys.serviceVersion(service), runningVersion(), 'EX', VERSION_TTL_SEC)
    .then(
      () => {
        finita = true;
      },
      (errore: unknown) => {
        finita = true;
        segnala?.({ tipo: 'scrittura', errore });
      },
    );

  await Promise.race([
    set,
    new Promise<void>((risolvi) => {
      const t = setTimeout(risolvi, attesaMs);
      t.unref?.();
    }),
  ]);

  /*
   * Con Redis irraggiungibile ioredis non fallisce: accoda e tiene lì. La
   * promessa non si risolve né si rifiuta, quindi «nessun errore» non vuol
   * dire «scritto». Se allo scadere del tetto non è ancora finita, è quello
   * che sta succedendo — e va detto, perché da fuori si vede solo un
   * processo che risulta fermo.
   */
  if (!finita) segnala?.({ tipo: 'lenta', attesaMs });
}

/**
 * Dichiara la propria versione e continua a riaffermarla.
 *
 * Il battito serve perché la chiave scade: senza, un servizio spento
 * resterebbe nell'elenco per sempre e un container morto sembrerebbe vivo e
 * aggiornato — che è esattamente il contrario di ciò che questo meccanismo
 * deve dire.
 *
 * La prima scrittura si può attendere, e il bot lo fa. Prima non lo faceva, e
 * il risultato era una diagnosi sbagliata: quando Discord rifiuta il token il
 * processo chiama process.exit poche centinaia di millisecondi dopo, la
 * scrittura non arriva mai a Redis, e il pannello scrive «bot: non risponde».
 * Cioè «quel container non c'è», mentre c'è, gira la versione giusta, e non
 * riesce solo a collegarsi. Sono due guasti diversi con due rimedi diversi:
 * ricreare il container non serve a niente se il token è sbagliato.
 */
export function announceVersion(
  redis: RedisLike,
  service: ServiceName,
  segnala?: (problema: ProblemaVersione) => void,
): Promise<void> {
  const timer = setInterval(() => {
    void scrivi(redis, service, PRIMA_ATTESA_MS, segnala);
  }, VERSION_HEARTBEAT_SEC * 1000);
  // Non deve tenere vivo il processo da solo.
  timer.unref?.();

  return scrivi(redis, service, PRIMA_ATTESA_MS, segnala).then(async () => {
    /*
     * La rilettura, solo la prima volta.
     *
     * Scrivere senza errori non prova che il valore ci sia: può essere stato
     * accodato e mai partito, o scritto su un Redis diverso da quello che
     * legge il pannello. Fin qui l'unico modo di accorgersene era il pannello
     * che diceva «fermo» per un processo vivo, senza una riga che lo
     * spiegasse. Un GET in più all'avvio lo trasforma in una riga di log.
     */
    if (!segnala) return;
    const letto = await redis.get(RedisKeys.serviceVersion(service)).catch(() => null);
    const atteso = runningVersion();
    if (letto !== atteso) segnala({ tipo: 'rilettura', letto, atteso });
  });
}

export interface ServiceVersions {
  /** Versione per servizio; `null` per chi non risponde. */
  services: Record<ServiceName, string | null>;
  /** Tutti i servizi vivi girano la stessa versione? */
  aligned: boolean;
  /** Chi è rimasto indietro, o non risponde affatto. */
  stale: ServiceName[];
}

/**
 * I servizi che devono esserci sempre.
 *
 * `twitch` non è qui di proposito: si accende solo se le credenziali di
 * Twitch sono state compilate, e chi usa ANGEL per il solo Discord lo lascia
 * spento per sempre. Metterlo fra gli obbligatori significherebbe dire a
 * tutti gli altri che un pezzo del sistema è rimasto indietro, ogni giorno,
 * per una funzione che non hanno chiesto.
 */
const ALL: ServiceName[] = ['bot', 'worker', 'api'];

/** Servizi che possono legittimamente non esserci. Compaiono se rispondono. */
const FACOLTATIVI: ServiceName[] = ['twitch'];

export async function readServiceVersions(
  redis: RedisLike,
  expected = runningVersion(),
): Promise<ServiceVersions> {
  const entries = await Promise.all(
    [...ALL, ...FACOLTATIVI].map(async (service) => {
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
