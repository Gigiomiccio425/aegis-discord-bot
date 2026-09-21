import type { Client } from 'discord.js';
import type { Redis } from 'ioredis';
import { RedisKeys } from '@angel/shared';
import { childLogger } from './logger.js';
import { handlePanelCommand } from './panelCommands.js';
import { getSubscriber } from './redis.js';

const log = childLogger('ascoltoPannello');

/* ═══════════════════════════════════════════════════════════════════════
   L'ASCOLTO DEI COMANDI NON DEVE POTER TRATTENERE IL BOT

   Questo pezzo stava dentro l'avvio, con un `await` davanti, prima del
   collegamento a Discord. Sembra l'ordine prudente — si è pronti a ricevere
   comandi prima ancora di esistere su Discord — e invece è quello che
   fermava tutto.

   La connessione a Redis ha `maxRetriesPerRequest: null`, che BullMQ
   richiede. Con quell'impostazione ioredis **non rifiuta** i comandi quando
   Redis non risponde: li mette in coda e li tiene lì. Un `await subscribe`
   in quel caso non si risolve e non fallisce. Non esiste un errore da
   registrare, non scade niente: l'avvio resta appeso a quella riga, il bot
   non compare su Discord, e nei log l'ultima riga è quella di prima.

   Il sintomo che si vedeva era un altro: «il bot è fermo», detto da un
   pannello che di fermo non sapeva niente — leggeva solo che la versione su
   Redis non era stata aggiornata.

   Da qui due regole, ed entrambe stanno nel codice qui sotto:

   • l'ascolto parte **dopo** il collegamento a Discord, e senza `await`;
   • ogni tentativo ha un tetto di tempo, perché un'attesa infinita non si
     vede in nessun log finché qualcuno non la mette in un tetto.
   ═══════════════════════════════════════════════════════════════════════ */

export interface OpzioniAscolto {
  /** La connessione da usare. Un test ne passa una finta. */
  subscriber?: Redis;
  /** Cosa fare di un comando arrivato. */
  esegui?: (client: Client, messaggio: string) => Promise<void>;
  /** Quanto si aspetta una sottoscrizione prima di chiamarla persa. */
  tettoMs?: number;
  /** Quanto si aspetta fra due tentativi. */
  attesaMs?: number;
  /** Quanti tentativi al massimo. Senza, si insiste per sempre. */
  tentativiMax?: number;
}

const attendi = (ms: number): Promise<void> =>
  new Promise((risolvi) => {
    setTimeout(risolvi, ms);
  });

/**
 * Si mette in ascolto dei comandi del pannello, e insiste finché non ci riesce.
 *
 * Insiste perché arrendersi lascerebbe un bot vivo su Discord con i pulsanti
 * del pannello morti fino al riavvio successivo — e su umbrelOS i container
 * partono insieme, quindi Redis che non risponde al primo tentativo è la
 * normalità, non un guasto.
 *
 * Restituisce `true` quando l'ascolto è attivo, `false` solo se chi chiama ha
 * messo un numero massimo di tentativi e sono finiti.
 */
export async function ascoltaComandiDalPannello(
  client: Client,
  opzioni: OpzioniAscolto = {},
): Promise<boolean> {
  const subscriber = opzioni.subscriber ?? getSubscriber();
  const esegui = opzioni.esegui ?? handlePanelCommand;
  const tettoMs = opzioni.tettoMs ?? 10_000;
  const attesaMs = opzioni.attesaMs ?? 5_000;
  const tentativiMax = opzioni.tentativiMax ?? Number.POSITIVE_INFINITY;

  // Il gestore si registra subito, una volta sola: se si registrasse dopo la
  // sottoscrizione, un comando arrivato nel mezzo non troverebbe nessuno.
  subscriber.on('message', (canale: string, messaggio: string) => {
    if (canale !== RedisKeys.commandChannel) return;
    void esegui(client, messaggio).catch((errore) =>
      log.error({ err: errore }, 'comando dal pannello fallito'),
    );
  });

  for (let tentativo = 1; tentativo <= tentativiMax; tentativo++) {
    try {
      await conTetto(subscriber.subscribe(RedisKeys.commandChannel), tettoMs);
      log.info(
        { canale: RedisKeys.commandChannel, tentativo },
        'in ascolto dei comandi dal pannello',
      );
      return true;
    } catch (errore) {
      /*
       * Il primo fallimento si racconta per intero, i successivi no: è
       * l'unico posto in cui si capisce perché i pulsanti del pannello non
       * fanno niente, ma ripeterlo ogni cinque secondi renderebbe i log
       * illeggibili proprio mentre si cerca dell'altro.
       */
      const livello = tentativo === 1 ? 'warn' : 'debug';
      log[livello](
        { err: errore, tentativo },
        'non riesco ad ascoltare i comandi dal pannello: Redis non risponde. ' +
          'Il bot funziona, ma lockdown, backup e test dal pannello non arrivano.',
      );
      if (tentativo >= tentativiMax) return false;
      await attendi(attesaMs);
    }
  }

  return false;
}

/**
 * Mette un tetto di tempo a un'attesa che potrebbe non finire mai.
 *
 * Serve proprio perché la promessa sottostante può non risolversi **e** non
 * fallire: senza tetto non c'è niente da intercettare, e il blocco resta
 * invisibile. Il tetto non annulla il comando — ioredis lo tiene in coda — ma
 * restituisce il controllo, che è quello che conta.
 */
async function conTetto<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let orologio: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promessa,
      new Promise<never>((_, rifiuta) => {
        orologio = setTimeout(() => rifiuta(new Error(`nessuna risposta in ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (orologio) clearTimeout(orologio);
  }
}
