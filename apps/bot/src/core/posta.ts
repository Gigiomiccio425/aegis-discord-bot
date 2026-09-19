import type { Client } from 'discord.js';
import type { Redis } from 'ioredis';
import {
  ESITO_TTL_SEC,
  Posta,
  apriBusta,
  leggiRisposta,
  scaduta,
  type Busta,
  type Esito,
  type EsitoSalvato,
} from '@angel/shared';
import { childLogger } from './logger.js';
import { getRedis } from './redis.js';
import { eseguiComando } from './panelCommands.js';
import { descriviErroreDiscord } from './erroriDiscord.js';

const log = childLogger('posta');

/**
 * Nome stabile del consumatore.
 *
 * Stabile e non legato al processo: al riavvio il bot ritrova sotto lo
 * stesso nome i comandi che stava eseguendo quando è caduto, e li riprende.
 * Con un nome nuovo a ogni avvio resterebbero assegnati a un consumatore che
 * non esiste più, e servirebbe un giro in più per reclamarli.
 */
const CONSUMATORE = 'bot-principale';
/** Comandi eseguiti insieme, al massimo. Quelli dello stesso server vanno in fila. */
const IN_VOLO_MAX = 16;
/** Ogni quanto il bot dice di essere collegato. */
const BATTITO_MS = 15_000;

const pausa = (ms: number): Promise<void> => new Promise((risolvi) => setTimeout(risolvi, ms));

/**
 * Avvia la lettura della posta. Va chiamata **dopo** il collegamento a
 * Discord: prima l'elenco dei server è vuoto, e ogni comando fallirebbe con
 * «il bot non è in questo server».
 *
 * Restituisce la funzione che la ferma.
 */
export function avviaPosta(client: Client): () => Promise<void> {
  const redis = getRedis();
  // Una connessione solo per la lettura bloccante: XREADGROUP con BLOCK
  // occupa la connessione finché non arriva qualcosa, e sulla principale
  // fermerebbe ogni altra richiesta del bot per cinque secondi alla volta.
  const lettore: Redis = redis.duplicate();
  lettore.on('error', (errore: Error) => log.warn({ err: errore }, 'connessione della posta'));

  let fermata = false;
  let inVolo = 0;
  const code = new Map<string, Promise<void>>();

  const battito = async (): Promise<void> => {
    if (!client.isReady()) return;
    await redis.set(Posta.pronto, String(Date.now()), 'EX', 45).catch(() => undefined);
  };
  void battito();
  const timerBattito = setInterval(() => void battito(), BATTITO_MS);
  timerBattito.unref?.();

  const preparaGruppo = async (): Promise<void> => {
    await lettore
      .call('XGROUP', 'CREATE', Posta.stream, Posta.gruppo, '0', 'MKSTREAM')
      .catch((errore: Error) => {
        // Il gruppo esiste già: è il caso normale a ogni avvio dopo il primo.
        if (!String(errore.message).includes('BUSYGROUP')) throw errore;
      });
  };

  const consegna = async (busta: Busta): Promise<void> => {
    let esito: Esito;
    if (!busta.comando) {
      esito = { stato: 'fallito', messaggio: 'comando illeggibile, scartato' };
    } else if (scaduta(busta)) {
      const secondi = Math.round((Date.now() - busta.creatoIl) / 1000);
      esito = {
        stato: 'scaduto',
        messaggio:
          `Non eseguito: il bot l'ha ricevuto dopo ${secondi} secondi, oltre il limite ` +
          `di ${Math.round(busta.scadenzaMs / 1000)} per questa azione. Se serve ancora, ripetilo.`,
      };
      log.info({ action: busta.comando.action, secondi }, 'comando scaduto, non eseguito');
    } else {
      try {
        esito = await eseguiComando(client, busta.comando);
      } catch (errore) {
        log.error({ err: errore, action: busta.comando.action }, 'comando fallito');
        esito = { stato: 'fallito', messaggio: descriviErroreDiscord(errore) };
      }
    }

    const salvato: EsitoSalvato = {
      ...esito,
      guildId: busta.comando?.guildId ?? '',
      action: busta.comando?.action ?? 'sconosciuta',
      finitoIl: Date.now(),
    };
    await redis
      .set(Posta.esito(busta.id), JSON.stringify(salvato), 'EX', ESITO_TTL_SEC)
      .catch(() => undefined);

    // La chiave anti-doppione si toglie solo se è ancora la sua: un comando
    // uguale arrivato dopo ne ha scritta una sua, e toglierla la lascerebbe
    // senza protezione.
    if (busta.chiave) {
      const attesa = Posta.attesa(busta.chiave);
      if ((await redis.get(attesa).catch(() => null)) === busta.id) {
        await redis.del(attesa).catch(() => undefined);
      }
    }

    // Conferma e cancellazione dopo l'esito, mai prima: un bot che muore fra
    // le due ritrova il comando al riavvio invece di perderlo.
    await redis.call('XACK', Posta.stream, Posta.gruppo, busta.voce).catch(() => undefined);
    await redis.call('XDEL', Posta.stream, busta.voce).catch(() => undefined);
  };

  /**
   * In fila per server, in parallelo fra server diversi.
   *
   * La fila conta: un «blocca» e un «sblocca» dello stesso server eseguiti
   * insieme lascerebbero il server in uno stato che dipende da chi finisce
   * per ultimo. Fra server diversi invece non c'è niente da ordinare, e un
   * lockdown lungo su uno non deve far aspettare gli altri.
   */
  const accoda = (busta: Busta): void => {
    const server = busta.comando?.guildId ?? '-';
    inVolo += 1;
    const prima = code.get(server) ?? Promise.resolve();
    const dopo = prima
      .then(() => consegna(busta))
      .catch((errore: unknown) => log.error({ err: errore }, 'consegna non riuscita'))
      .finally(() => {
        inVolo -= 1;
        if (code.get(server) === dopo) code.delete(server);
      });
    code.set(server, dopo);
  };

  const ciclo = async (): Promise<void> => {
    while (!fermata) {
      try {
        await preparaGruppo();
        break;
      } catch (errore) {
        log.warn({ err: errore }, 'gruppo della posta non creato, riprovo');
        await pausa(3_000);
      }
    }

    // Prima quello che questo consumatore aveva già ricevuto e non confermato
    // — i comandi in corso quando il bot è caduto — poi quello nuovo.
    let cursore = '0';

    while (!fermata) {
      while (inVolo >= IN_VOLO_MAX && !fermata) await pausa(50);

      let risposta: unknown;
      try {
        risposta = await lettore.call(
          'XREADGROUP',
          'GROUP',
          Posta.gruppo,
          CONSUMATORE,
          'COUNT',
          '20',
          'BLOCK',
          '5000',
          'STREAMS',
          Posta.stream,
          cursore,
        );
      } catch (errore) {
        if (fermata) break;
        const testo = String((errore as Error).message ?? errore);
        if (testo.includes('NOGROUP')) {
          // Lo stream è sparito — un Redis svuotato: si ricrea e si riparte.
          await preparaGruppo().catch(() => undefined);
          cursore = '0';
          continue;
        }
        log.warn({ err: errore }, 'lettura della posta non riuscita, riprovo');
        await pausa(2_000);
        continue;
      }

      const voci = leggiRisposta(risposta);
      if (cursore === '0' && voci.length === 0) {
        cursore = '>';
        continue;
      }
      for (const voce of voci) accoda(apriBusta(voce.voce, voce.campi));

      // Con il cursore a '0' si rileggono le proprie in sospeso: prima di
      // rileggere bisogna che quelle appena accodate siano confermate, o
      // tornerebbero indietro una seconda volta.
      if (cursore === '0') await Promise.allSettled([...code.values()]);
    }
  };

  void ciclo();
  log.info('posta del bot in ascolto');

  return async () => {
    fermata = true;
    clearInterval(timerBattito);
    await redis.del(Posta.pronto).catch(() => undefined);
    lettore.disconnect();
    await Promise.allSettled([...code.values()]);
  };
}
