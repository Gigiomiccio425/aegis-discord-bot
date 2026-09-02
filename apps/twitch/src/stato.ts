/* ═══════════════════════════════════════════════════════════════════════
   REGISTRO DEI CANALI — E LA MODALITÀ AUTONOMA

   Chi sono i canali serviti, come sono configurati, e — la parte che dà il
   titolo a questo file — come continuare a funzionare quando il database non
   c'è.

   Il requisito è preciso: **il bot deve restare in chat anche senza
   pannello**. Non è una richiesta di comodità. Uno streamer che va in diretta
   non ha modo di sapere che il nostro Postgres è caduto; sa solo che i bot di
   spam sono tornati e che i comandi non rispondono più, e la conclusione che
   trae è che il bot non funziona.

   La soluzione è vecchia quanto il problema: **una copia su disco di tutto
   quello che serve per lavorare**. Ogni volta che una configurazione si
   carica dal database, si scrive anche in `STORAGE_DIR/twitch/canali.json`.
   All'avvio, se il database non risponde, si legge quel file e si parte lo
   stesso.

   Cosa funziona in modalità autonoma:

   • tutta la moderazione — i moduli sono funzioni pure, non hanno mai avuto
     bisogno del database;
   • i comandi personalizzati e quelli integrati;
   • i messaggi a tempo;
   • le azioni su Twitch, che passano dall'API di Twitch e non dalla nostra.

   Cosa non funziona:

   • il pannello, che dei dati vive;
   • la memoria di lungo periodo degli spettatori — chi era «di casa» torna
     sconosciuto, e le regole sul primo messaggio sono più severe del solito.
     Twitch però dichiara lui stesso `is_first_message`, quindi il caso
     peggiore è che qualcuno di affezionato venga trattato da nuovo arrivato
     per una sera.

   Gli eventi prodotti nel frattempo non si perdono: finiscono nel file
   NDJSON del giorno, e `archivio.ts` li riversa nel database quando torna.
   ═══════════════════════════════════════════════════════════════════════ */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getPrisma } from '@angel/db';
import {
  TwitchChannelConfigSchema,
  defaultTwitchConfig,
  type TwitchChannelConfig,
} from '@angel/shared';
import type { StatoSpettatore } from '@angel/twitch';
import { decrypt } from './crypto.js';
import { logger } from './logger.js';

/** Quanti messaggi recenti si tengono per persona, per l'anti-spam. */
const RICORDA_MESSAGGI = 12;

/**
 * Spettatori tenuti in memoria per canale.
 *
 * Una chat da mille spettatori attivi occupa qualche megabyte; una da
 * centomila no. Oltre questa soglia si buttano i più vecchi: perdere lo
 * storico recente di chi non scrive da un'ora costa niente, mentre riempire
 * la memoria costa il processo.
 */
const MAX_SPETTATORI_MEMORIA = 20_000;

/** Quanti spettatori si rileggono dal database quando un canale si collega. */
const PRECARICA_SPETTATORI = 5_000;

/**
 * Uno spettatore in memoria.
 *
 * Estende quello che serve al motore con la contabilita che serve a salvarlo:
 * il login per poterlo scrivere, e quanti messaggi sono passati dall'ultimo
 * salvataggio. Il delta e non il totale, perche due processi che scrivessero
 * il totale si sovrascriverebbero a vicenda.
 */
export interface SpettatoreVivo extends StatoSpettatore {
  login: string;
  /** Messaggi dall'ultimo salvataggio. Zero = niente da scrivere. */
  delta: number;
  timeouts: number;
  bans: number;
  avvisi: number;
}

export interface Canale {
  id: string;
  login: string;
  nome: string;
  guildId: string | null;
  config: TwitchChannelConfig;
  /** Token del broadcaster, decifrato. Assente se il canale va riautorizzato. */
  token: { accessToken: string; refreshToken: string | null } | null;
  /** Login dei moderatori, per le esenzioni e l'anti-impersonazione. */
  moderatori: string[];
  /** Il canale è in diretta adesso. */
  online: boolean;
  /** Righe di chat passate dall'ultimo messaggio a tempo. */
  righeDaTimer: number;
  /** Stato dell'ondata in corso. */
  raid: { nuovi: number[]; impronte: { impronta: string; quando: number }[] };
  /** Restrizioni anti-raid applicate: quando toglierle. */
  scudoFinoA: number | null;
  spettatori: Map<string, SpettatoreVivo>;
  /** Il bot e moderatore qui: cambia il limite dei messaggi da 20 a 100 ogni 30s. */
  botModeratore: boolean;
  /** Ultima volta che si e chiesto a Twitch chi sono i moderatori. */
  moderatoriAggiornatiIl: number;
  /** Parole gia sincronizzate nei termini bloccati di Twitch, per non rifarlo a vuoto. */
  improntaTermini: string;
}

/** Forma della copia su disco. Volutamente minima: solo ciò che serve a lavorare. */
interface CanaleSalvato {
  id: string;
  login: string;
  nome: string;
  guildId: string | null;
  config: unknown;
  moderatori: string[];
}

export class Registro {
  private readonly canali = new Map<string, Canale>();
  private readonly perLogin = new Map<string, string>();
  /** Vero quando si sta girando sulla copia su disco. */
  autonomo = false;

  /* ── Lettura ────────────────────────────────────────────────────── */

  tutti(): Canale[] {
    return [...this.canali.values()];
  }

  get(id: string): Canale | undefined {
    return this.canali.get(id);
  }

  perNome(login: string): Canale | undefined {
    const id = this.perLogin.get(login.toLowerCase());
    return id ? this.canali.get(id) : undefined;
  }

  quanti(): number {
    return this.canali.size;
  }

  /* ── Caricamento ────────────────────────────────────────────────── */

  /**
   * Carica dal database, e se non risponde dalla copia su disco.
   *
   * L'ordine conta: si prova il database *sempre*, anche dopo essere partiti
   * in autonomia, perché il ritorno del database deve essere un evento
   * automatico e non una cosa da riavviare a mano.
   */
  async carica(): Promise<{ fonte: 'database' | 'disco'; canali: number }> {
    try {
      const righe = await getPrisma().twitchChannel.findMany({ where: { enabled: true } });

      this.canali.clear();
      this.perLogin.clear();

      for (const riga of righe) {
        this.aggiungi({
          id: riga.id,
          login: riga.login,
          nome: riga.displayName ?? riga.login,
          guildId: riga.guildId,
          config: leggiConfig(riga.config),
          token: riga.tokenEnc
            ? {
                accessToken: decrypt(riga.tokenEnc) ?? '',
                refreshToken: riga.refreshEnc ? decrypt(riga.refreshEnc) : null,
              }
            : null,
          moderatori: [],
        });
      }

      this.autonomo = false;
      await this.salvaSuDisco();
      return { fonte: 'database', canali: this.canali.size };
    } catch (errore) {
      logger.error(
        { err: errore },
        'database non raggiungibile: provo la copia su disco dei canali',
      );

      const dal = await this.caricaDaDisco();
      this.autonomo = true;
      return { fonte: 'disco', canali: dal };
    }
  }

  private aggiungi(dati: {
    id: string;
    login: string;
    nome: string;
    guildId: string | null;
    config: TwitchChannelConfig;
    token: Canale['token'];
    moderatori: string[];
  }): void {
    this.canali.set(dati.id, {
      ...dati,
      online: false,
      botModeratore: false,
      moderatoriAggiornatiIl: 0,
      improntaTermini: '',
      righeDaTimer: 0,
      raid: { nuovi: [], impronte: [] },
      scudoFinoA: null,
      spettatori: new Map(),
    });
    this.perLogin.set(dati.login.toLowerCase(), dati.id);
  }

  /**
   * Aggiorna la configurazione di un canale senza perderne lo stato.
   *
   * Ricreare la voce azzererebbe gli spettatori in memoria e i contatori
   * dell'anti-raid: salvare dal pannello durante un'ondata regalerebbe
   * all'attacco una finestra pulita, che è il momento peggiore per farlo.
   */
  aggiorna(id: string, config: TwitchChannelConfig): void {
    const canale = this.canali.get(id);
    if (!canale) return;
    canale.config = config;
    void this.salvaSuDisco();
  }

  rimuovi(id: string): void {
    const canale = this.canali.get(id);
    if (!canale) return;
    this.perLogin.delete(canale.login.toLowerCase());
    this.canali.delete(id);
    void this.salvaSuDisco();
  }

  /* ── Copia su disco ─────────────────────────────────────────────── */

  private percorso(): string {
    return path.join(process.env.STORAGE_DIR ?? './storage', 'twitch', 'canali.json');
  }

  /**
   * Scrive la copia.
   *
   * **Senza i token.** È la decisione più importante di questo file: la copia
   * serve a moderare, e per moderare servono le credenziali — quindi in
   * autonomia il bot legge la chat ma non può sanzionare. Sembra una perdita,
   * ed è invece il compromesso giusto: un file in chiaro con dentro i token
   * di moderazione di tutti i canali serviti è un bersaglio che vale molto
   * più di una serata di moderazione.
   *
   * In pratica funziona così: senza database, il bot risponde ai comandi, fa
   * uscire i messaggi a tempo, registra tutto sul file del giorno, e per
   * sanzionare usa i token che ha ancora in memoria da prima — che ci sono,
   * perché il database cade mentre il processo è già acceso. È solo un
   * riavvio *durante* il guasto a lasciarlo senza credenziali, e in quel caso
   * lo dice.
   */
  private async salvaSuDisco(): Promise<void> {
    if (this.autonomo) return;

    const salvati: CanaleSalvato[] = this.tutti().map((canale) => ({
      id: canale.id,
      login: canale.login,
      nome: canale.nome,
      guildId: canale.guildId,
      config: canale.config,
      moderatori: canale.moderatori,
    }));

    const file = this.percorso();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Scrittura atomica: un file mezzo scritto è peggio di nessun file,
      // perché all'avvio successivo sembra valido finché non si prova a
      // leggerlo — cioè nel momento in cui serve.
      const temporaneo = `${file}.nuovo`;
      await fs.writeFile(temporaneo, JSON.stringify(salvati, null, 2), 'utf8');
      await fs.rename(temporaneo, file);
    } catch (errore) {
      logger.warn({ err: errore }, 'copia dei canali su disco non riuscita');
    }
  }

  private async caricaDaDisco(): Promise<number> {
    const file = this.percorso();
    const testo = await fs.readFile(file, 'utf8').catch(() => null);

    if (!testo) {
      logger.error(
        { file },
        'nessuna copia su disco: il bot non sa quali canali servire. ' +
          'Succede solo se il database non ha mai risposto da quando esiste questa installazione.',
      );
      return 0;
    }

    try {
      const salvati = JSON.parse(testo) as CanaleSalvato[];
      this.canali.clear();
      this.perLogin.clear();

      for (const salvato of salvati) {
        this.aggiungi({
          id: salvato.id,
          login: salvato.login,
          nome: salvato.nome,
          guildId: salvato.guildId,
          config: leggiConfig(salvato.config),
          token: null,
          moderatori: salvato.moderatori ?? [],
        });
      }

      logger.warn(
        { canali: this.canali.size },
        'MODALITÀ AUTONOMA: canali letti dalla copia su disco. Comandi, messaggi a tempo e ' +
          'registro funzionano; le sanzioni solo se i token erano già in memoria.',
      );
      return this.canali.size;
    } catch (errore) {
      logger.error({ err: errore, file }, 'copia su disco illeggibile');
      return 0;
    }
  }

  /* ── Spettatori ─────────────────────────────────────────────────── */

  /**
   * Lo stato di chi scrive, creandolo se è la prima volta.
   *
   * Vive in memoria e non nel database perché lo si tocca a ogni messaggio:
   * una lettura e una scrittura per riga di chat farebbero da sole più
   * traffico di tutto il resto del bot messo insieme. Il database riceve i
   * conteggi in blocco, ogni tanto, da `archivio.ts`.
   */
  spettatore(canale: Canale, utenteId: string, login = ''): SpettatoreVivo {
    let stato = canale.spettatori.get(utenteId);
    if (!stato) {
      stato = {
        login,
        messaggi: 0,
        fiducia: 50,
        fidato: false,
        recenti: [],
        delta: 0,
        timeouts: 0,
        bans: 0,
        avvisi: 0,
      };
      canale.spettatori.set(utenteId, stato);
      if (canale.spettatori.size > MAX_SPETTATORI_MEMORIA) sfoltisci(canale);
    }
    if (login && !stato.login) stato.login = login;
    return stato;
  }

  /** Registra un messaggio nello stato di chi lo ha scritto. */
  annota(
    canale: Canale,
    utenteId: string,
    login: string,
    testo: string,
    quando = Date.now(),
  ): SpettatoreVivo {
    const stato = this.spettatore(canale, utenteId, login);
    stato.messaggi += 1;
    stato.delta += 1;
    stato.recenti.push({ testo, quando });
    if (stato.recenti.length > RICORDA_MESSAGGI) stato.recenti.shift();
    return stato;
  }

  /**
   * Carica dal database chi frequenta il canale.
   *
   * Non tutti: i piu recenti, fino a un tetto. Serve a far ritrovare la
   * propria reputazione a chi il canale lo frequenta davvero — l'esenzione
   * manuale, la fiducia accumulata — senza caricare in memoria anni di
   * passanti.
   *
   * Chi resta fuori non e scoperto: Twitch dichiara lui stesso
   * `is_first_message`, quindi le regole sul primo messaggio continuano a
   * distinguere chi non ha mai scritto da chi scriveva un anno fa.
   */
  async caricaSpettatori(canale: Canale): Promise<number> {
    try {
      const righe = await getPrisma().twitchViewer.findMany({
        where: { channelId: canale.id },
        orderBy: { lastSeenAt: 'desc' },
        take: PRECARICA_SPETTATORI,
      });

      for (const riga of righe) {
        canale.spettatori.set(riga.twitchUserId, {
          login: riga.login,
          messaggi: riga.messageCount,
          fiducia: riga.trust,
          fidato: riga.trusted,
          recenti: [],
          delta: 0,
          timeouts: riga.timeouts,
          bans: riga.bans,
          avvisi: riga.warnings,
        });
      }

      return righe.length;
    } catch (errore) {
      // Senza, il canale parte con la memoria vuota e tratta tutti da nuovi.
      // Scomodo, non rotto: e esattamente lo stato in cui gira la modalita
      // autonoma, che funziona.
      logger.warn({ err: errore, canale: canale.login }, 'spettatori non precaricati');
      return 0;
    }
  }

  /**
   * Scrive nel database gli spettatori che si sono mossi.
   *
   * In blocco e solo i cambiati: una scrittura per messaggio farebbe da sola
   * piu traffico di tutto il resto del bot. Il delta si azzera solo quando la
   * scrittura e andata a buon fine, cosi un guasto rimanda il conteggio
   * invece di perderlo.
   */
  async salvaSpettatori(canale: Canale): Promise<number> {
    const sporchi = [...canale.spettatori.entries()].filter(([, stato]) => stato.delta > 0);
    if (sporchi.length === 0) return 0;

    const prisma = getPrisma();
    let scritti = 0;

    for (const [utenteId, stato] of sporchi) {
      const delta = stato.delta;
      try {
        await prisma.twitchViewer.upsert({
          where: { channelId_twitchUserId: { channelId: canale.id, twitchUserId: utenteId } },
          create: {
            channelId: canale.id,
            twitchUserId: utenteId,
            login: stato.login || utenteId,
            messageCount: delta,
            trust: stato.fiducia,
            trusted: stato.fidato,
            timeouts: stato.timeouts,
            bans: stato.bans,
            warnings: stato.avvisi,
          },
          update: {
            login: stato.login || undefined,
            // `increment` e non un valore assoluto: e l'unica forma che regge
            // due processi che scrivono lo stesso spettatore, e il nodo di
            // emergenza esiste apposta per essere quel secondo processo.
            messageCount: { increment: delta },
            timeouts: stato.timeouts,
            bans: stato.bans,
            warnings: stato.avvisi,
            trust: stato.fiducia,
            trusted: stato.fidato,
            lastSeenAt: new Date(),
          },
        });
        stato.delta -= delta;
        scritti += 1;
      } catch (errore) {
        logger.debug({ err: errore, canale: canale.login }, 'spettatore non salvato');
      }
    }

    return scritti;
  }
}

/**
 * Toglie dalla memoria chi non scrive da più tempo.
 *
 * Metà alla volta e non uno per volta: sfoltire a ogni nuovo arrivato
 * significherebbe ordinare ventimila voci per ogni messaggio di uno
 * sconosciuto, che durante un raid è precisamente il momento in cui non si
 * può.
 */
function sfoltisci(canale: Canale): void {
  const voci = [...canale.spettatori.entries()].sort((a, b) => {
    const ultimoA = a[1].recenti.at(-1)?.quando ?? 0;
    const ultimoB = b[1].recenti.at(-1)?.quando ?? 0;
    return ultimoA - ultimoB;
  });

  for (const [id] of voci.slice(0, Math.floor(voci.length / 2))) canale.spettatori.delete(id);
}

/**
 * Legge una configurazione salvata, tornando ai valori predefiniti se non è
 * valida.
 *
 * Una configurazione rotta non deve spegnere un canale: significherebbe che
 * un errore di scrittura nel pannello lascia uno streamer senza moderazione
 * proprio mentre pensa di averla appena rafforzata.
 */
export function leggiConfig(valore: unknown): TwitchChannelConfig {
  const esito = TwitchChannelConfigSchema.safeParse(valore ?? {});
  if (esito.success) return esito.data;

  logger.warn({ problemi: esito.error.issues.slice(0, 3) }, 'configurazione canale non valida');
  return defaultTwitchConfig();
}
