import type { Client } from 'discord.js';
import type { Redis } from 'ioredis';
import {
  ESITO_TTL_SEC,
  Posta,
  apriBusta,
  leggiRisposta,
  scaduta,
  type Busta,
  type ComandoBot,
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
/**
 * Quanto si aspetta una singola consegna prima di rinunciare ad attenderla.
 *
 * Generoso apposta: un lockdown su un server grande tocca centinaia di canali
 * e i limiti di frequenza di Discord lo rallentano. Il tetto non serve a
 * interrompere il lavoro lungo, serve a impedire che quello *infinito* fermi
 * tutta la coda.
 */
const TETTO_CONSEGNA_MS = 120_000;

const pausa = (ms: number): Promise<void> => new Promise((risolvi) => setTimeout(risolvi, ms));

/**
 * Quello che serve al ciclo, e nient'altro.
 *
 * Separato da `avviaPosta` perché il ciclo è la parte che si può sbagliare —
 * un cursore che non avanza riesegue comandi veri — e senza dipendenze
 * iniettabili si verifica solo in produzione, che è dove si è visto.
 */
export interface DipendenzePosta {
  /** Scritture e conferme: la connessione normale. */
  redis: {
    call(comando: string, ...args: (string | number)[]): Promise<unknown>;
    set(chiave: string, valore: string, modo: 'EX', secondi: number): Promise<unknown>;
    get(chiave: string): Promise<string | null>;
    del(chiave: string): Promise<unknown>;
  };
  /** Solo la lettura bloccante. */
  lettore: { call(comando: string, ...args: (string | number)[]): Promise<unknown> };
  esegui: (comando: ComandoBot) => Promise<Esito>;
  /** Il bot è collegato a Discord? Il battito si scrive solo allora. */
  pronto: () => boolean;
}

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

  return consumaPosta({
    redis,
    lettore,
    esegui: (comando) => eseguiComando(client, comando),
    pronto: () => client.isReady(),
    chiudi: () => lettore.disconnect(),
  });
}

/** Il ciclo vero e proprio. `avviaPosta` lo collega a Discord e a Redis. */
export function consumaPosta({
  redis,
  lettore,
  esegui,
  pronto,
  chiudi,
}: DipendenzePosta & { chiudi?: () => void }): () => Promise<void> {
  let fermata = false;
  let inVolo = 0;
  /** Si segnala una volta sola: a ogni giro sarebbe rumore. */
  let formaSegnalata = false;
  /** La prima lettura riuscita: solo allora la posta è davvero in ascolto. */
  let inAscolto = false;
  const code = new Map<string, Promise<void>>();

  /*
   * Il battito, e perché i suoi errori non si ingoiano.
   *
   * Questa chiave è l'unica cosa che dice al pannello «il bot è collegato a
   * Discord adesso». Se la scrittura fallisce, il pannello scrive «il bot non
   * è collegato» di un bot collegato e funzionante, e i comandi sembrano non
   * partire quando invece partono. Con `.catch(() => undefined)` non restava
   * una riga da nessuna parte: si poteva solo indovinare.
   *
   * Si segnala una volta sola per ogni cambio di stato, non a ogni battito:
   * ogni quindici secondi la stessa riga sarebbe rumore, e il rumore nasconde
   * proprio la riga che serve.
   */
  let battitoRotto = false;
  let saltato = false;
  const battito = async (): Promise<void> => {
    /*
     * Saltare in silenzio era l'ultimo buco.
     *
     * Se discord.js dice che il bot non è collegato, il battito non si scrive
     * — ed è giusto: quella chiave significa «collegato adesso». Ma senza una
     * riga, dal di fuori questo caso è indistinguibile da un ciclo di eventi
     * bloccato, che non fa partire il battito affatto. Due guasti diversi,
     * stesso sintomo: il pannello che scrive «il bot non è collegato».
     *
     * Con questa riga si distinguono: se compare, è la prima; se la chiave
     * scade e questa riga non c'è, è la seconda.
     */
    if (!pronto()) {
      if (!saltato) {
        saltato = true;
        log.warn(
          'battito saltato: discord.js dice che il bot non è collegato. ' +
            'Finché dura, il pannello lo dà per scollegato — ed è vero',
        );
      }
      return;
    }
    if (saltato) {
      saltato = false;
      log.info('collegamento tornato: il battito riprende');
    }
    try {
      await redis.set(Posta.pronto, String(Date.now()), 'EX', 45);
      if (battitoRotto) {
        battitoRotto = false;
        log.info('battito ripreso: il pannello torna a vedere il bot collegato');
      }
    } catch (errore) {
      if (battitoRotto) return;
      battitoRotto = true;
      log.error(
        { err: errore },
        'battito non scritto: il pannello dirà che il bot non è collegato, e gli esiti ' +
          'dei comandi non gli torneranno indietro',
      );
    }
  };
  void battito();
  const timerBattito = setInterval(() => void battito(), BATTITO_MS);
  timerBattito.unref?.();

  /*
   * Creare il gruppo, con un tetto di tempo.
   *
   * Il tetto non è prudenza: con `maxRetriesPerRequest: null` — che BullMQ
   * pretende e che questa connessione eredita — ioredis **non fallisce mai**
   * quando Redis non risponde. Accoda il comando e lo tiene lì. Un `await` su
   * quella promessa non finisce più.
   *
   * Il risultato era il peggiore possibile: il ciclo non partiva, nessun
   * errore da nessuna parte, e il bot scriveva lo stesso «posta in ascolto».
   * Da fuori si vedeva solo un pannello che diceva «ci sto lavorando» per
   * sempre.
   */
  const preparaGruppo = async (): Promise<boolean> => {
    let risposto = false;

    const lavoro = lettore
      .call('XGROUP', 'CREATE', Posta.stream, Posta.gruppo, '0', 'MKSTREAM')
      .then(
        () => {
          risposto = true;
        },
        (errore: Error) => {
          risposto = true;
          // Il gruppo esiste già: è il caso normale a ogni avvio dopo il primo.
          if (!String(errore.message).includes('BUSYGROUP')) throw errore;
        },
      );

    await Promise.race([
      lavoro,
      new Promise<void>((risolvi) => {
        const t = setTimeout(risolvi, 10_000);
        t.unref?.();
      }),
    ]);

    if (!risposto) {
      log.error(
        'Redis non risponde alla creazione del gruppo: la posta non parte, e i comandi ' +
          'dal pannello resteranno in coda senza che nessuno li legga. Riprovo.',
      );
    }
    return risposto;
  };

  /**
   * Conferma e cancella, qualunque cosa sia successa prima.
   *
   * Dopo l'esito, mai prima: un bot che muore fra le due ritrova il comando al
   * riavvio invece di perderlo. Ma **sempre**, anche quando l'esecuzione è
   * finita con un'eccezione — una voce che resta in sospeso viene riletta a
   * ogni giro, e con lei tutte le altre in sospeso, che vengono rieseguite.
   *
   * Un errore qui si scrive nei log. Silenziato, il sintomo sarebbe uno
   * snapshot creato ogni due secondi e nessuna riga che dica perché.
   */
  const conferma = async (voce: string): Promise<void> => {
    try {
      await redis.call('XACK', Posta.stream, Posta.gruppo, voce);
      await redis.call('XDEL', Posta.stream, voce);
    } catch (errore) {
      log.error({ err: errore, voce }, 'comando non confermato: verrà riletto');
    }
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
        esito = await esegui(busta.comando);
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
    /*
     * L'esito è la risposta al pannello. Se non si scrive, chi ha premuto il
     * pulsante vede «non eseguito» per un comando che **è stato eseguito** —
     * e lo ripete, che su un lockdown significa rifarlo due volte.
     *
     * Non si rilancia: il comando è già stato fatto, e fallire qui lo
     * rimetterebbe in coda. Si dice, e si va avanti.
     */
    try {
      await redis.set(Posta.esito(busta.id), JSON.stringify(salvato), 'EX', ESITO_TTL_SEC);
    } catch (errore) {
      log.error(
        { err: errore, action: salvato.action, stato: salvato.stato },
        'esito non salvato: il comando è stato eseguito ma il pannello non lo saprà',
      );
    }

    // La chiave anti-doppione si toglie solo se è ancora la sua: un comando
    // uguale arrivato dopo ne ha scritta una sua, e toglierla la lascerebbe
    // senza protezione.
    if (busta.chiave) {
      const attesa = Posta.attesa(busta.chiave);
      if ((await redis.get(attesa).catch(() => null)) === busta.id) {
        await redis.del(attesa).catch(() => undefined);
      }
    }
  };

  /**
   * In fila per server, in parallelo fra server diversi.
   *
   * La fila conta: un «blocca» e un «sblocca» dello stesso server eseguiti
   * insieme lascerebbero il server in uno stato che dipende da chi finisce
   * per ultimo. Fra server diversi invece non c'è niente da ordinare, e un
   * lockdown lungo su uno non deve far aspettare gli altri.
   */
  /**
   * Un comando che non finisce non deve fermare tutti gli altri.
   *
   * Il guasto, visto in produzione: `inVolo` conta le consegne in corso e il
   * lettore si ferma a `IN_VOLO_MAX`. Se **una** consegna non finisce mai —
   * una chiamata a Discord che non torna, una scrittura su una connessione
   * bloccata — quel contatore non scende più, e il lettore smette di leggere.
   * Per sempre, senza un errore. Da fuori si vede solo un lockdown che resta
   * in coda finché non scade, e il pannello che non sa dire perché.
   *
   * Oltre il tetto si rinuncia ad aspettare e si va avanti. Il comando può
   * ancora finire per conto suo — una chiamata già partita non si annulla —
   * ma non tiene più in ostaggio la coda.
   */
  const conTetto = async (cosa: string, lavoro: Promise<void>): Promise<void> => {
    let finito = false;
    const fine = lavoro.then(
      () => {
        finito = true;
      },
      (errore: unknown) => {
        finito = true;
        throw errore;
      },
    );

    await Promise.race([
      fine,
      new Promise<void>((risolvi) => {
        const t = setTimeout(risolvi, TETTO_CONSEGNA_MS);
        t.unref?.();
      }),
    ]);

    if (!finito) {
      log.error(
        { cosa, tettoMs: TETTO_CONSEGNA_MS },
        'consegna abbandonata: non è finita entro il tetto. Il comando può ancora ' +
          'concludersi, ma la coda riparte invece di restare ferma per sempre',
      );
    }
  };

  const accoda = (busta: Busta): void => {
    const server = busta.comando?.guildId ?? '-';
    inVolo += 1;
    const prima = code.get(server) ?? Promise.resolve();
    const azione = busta.comando?.action ?? 'sconosciuta';
    const dopo = prima
      .then(() => conTetto(`esecuzione ${azione}`, consegna(busta)))
      .catch((errore: unknown) => log.error({ err: errore, azione }, 'consegna non riuscita'))
      // Sempre, anche dopo un errore: vedi `conferma`. Una voce lasciata in
      // sospeso non si perde — si ripete, che è peggio. Sotto tetto anche
      // questa: se la conferma non torna, il contatore non scende e il
      // lettore si ferma esattamente come prima.
      .then(() => conTetto(`conferma ${azione}`, conferma(busta.voce)))
      .catch((errore: unknown) => log.error({ err: errore, azione }, 'conferma non riuscita'))
      .finally(() => {
        inVolo -= 1;
        if (code.get(server) === dopo) code.delete(server);
      });
    code.set(server, dopo);
  };

  const ciclo = async (): Promise<void> => {
    while (!fermata) {
      try {
        // Non basta che non lanci: deve aver **risposto**. Con Redis muto la
        // promessa resta appesa, e prima si usciva lo stesso da questo ciclo
        // lasciando un lettore che non leggeva.
        if (await preparaGruppo()) break;
      } catch (errore) {
        log.warn({ err: errore }, 'gruppo della posta non creato, riprovo');
      }
      await pausa(3_000);
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

      /*
       * Il recupero avanza, non ricomincia.
       *
       * Con un identificativo esplicito XREADGROUP rilegge le voci di questo
       * consumatore già ricevute e non confermate. Rileggere sempre da `'0'`
       * sembra equivalente e non lo è: basta **una** voce che non si riesce a
       * confermare perché la pagina non sia mai vuota, il cursore non passi
       * mai a `'>'`, e ogni altra voce in sospeso venga riletta — e rieseguita
       * — a ogni giro. È il guasto che produceva uno snapshot ogni due
       * secondi: non un lavoro periodico impazzito, lo stesso comando
       * consegnato all'infinito.
       *
       * Avanzando, una voce che non si conferma costa un giro in più e basta.
       */
      /*
       * Una risposta che c'è ma da cui non si ricava niente.
       *
       * `leggiRisposta` si aspetta la forma di RESP2:
       * `[[stream, [[id, [campo, valore, …]], …]]]`. Qualunque altra cosa
       * produce un elenco vuoto **senza dire niente** — e succede per davvero:
       * con RESP3 la stessa risposta arriva come mappa invece che come array.
       *
       * Il sintomo è il peggiore che ci sia: letture che riescono, comandi che
       * spariscono, zero righe nei log, e il pannello che dice «ci sto
       * lavorando» per sempre.
       */
      if (!formaSegnalata && voci.length === 0 && Array.isArray(risposta) && risposta.length > 0) {
        formaSegnalata = true;
        log.error(
          { forma: `array di ${risposta.length}` },
          'Redis ha risposto qualcosa che non so leggere: i comandi dal pannello ' +
            'verrebbero scartati in silenzio. Attesa la forma RESP2 ' +
            '[[stream, [[id, [campo, valore]]]]]',
        );
      }

      if (!inAscolto) {
        inAscolto = true;
        log.info('posta del bot in ascolto');
      }

      if (cursore !== '>') {
        if (voci.length === 0) {
          cursore = '>';
          continue;
        }
        cursore = voci[voci.length - 1]!.voce;
      }

      for (const voce of voci) accoda(apriBusta(voce.voce, voce.campi));

      // Durante il recupero si aspetta che la pagina sia finita prima di
      // chiedere la successiva: serve a non tenere in volo l'intero arretrato
      // tutto insieme.
      if (cursore !== '>') await Promise.allSettled([...code.values()]);
    }
  };

  /*
   * Niente «in ascolto» qui.
   *
   * Prima si stampava subito dopo `void ciclo()`, cioè prima che il ciclo
   * avesse letto alcunché. Con Redis muto il ciclo non partiva e il log
   * diceva lo stesso che era in ascolto: la riga che doveva rassicurare era
   * quella che nascondeva il guasto. Adesso la scrive la prima lettura
   * riuscita.
   */
  void ciclo();

  return async () => {
    fermata = true;
    clearInterval(timerBattito);
    await redis.del(Posta.pronto).catch(() => undefined);
    chiudi?.();
    await Promise.allSettled([...code.values()]);
  };
}
