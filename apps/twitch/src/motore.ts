/* ═══════════════════════════════════════════════════════════════════════
   IL MOTORE

   Mette insieme i pezzi: ascolta la chat, valuta, agisce, registra, e fa
   uscire i messaggi a tempo.

   ── Il percorso di un messaggio ────────────────────────────────────────

   Arriva → si annota chi ha scritto → si valuta → se c'è da agire si agisce
   → se era un comando si risponde. In quest'ordine, e l'ordine è la cosa che
   conta: rispondere a un comando prima di aver moderato significherebbe che
   il bot risponde educatamente a un messaggio che sta per cancellare.

   ── Sull'ottimizzazione ────────────────────────────────────────────────

   Il collo di bottiglia non è la valutazione — sono funzioni pure che girano
   in microsecondi — ma tutto quello che ci sta attorno. Le scelte fatte per
   questo:

   • **Niente database sul percorso del messaggio.** Lo stato degli spettatori
     vive in memoria, il registro parte in blocchi ogni due secondi. Una
     lettura e una scrittura per riga di chat farebbero da sole più traffico
     di tutto il resto.

   • **Si esce presto.** Un canale spento, un messaggio del bot stesso, uno
     streamer: si torna indietro prima di normalizzare qualunque cosa.

   • **La normalizzazione Unicode si paga una volta.** È il pezzo caro della
     valutazione, e i moduli la riusano invece di rifarla ciascuno.

   • **Un secchiello per canale sui messaggi in uscita.** Non è velocità: è
     che sforare il limite di Twitch fa sparire i messaggi in silenzio, e
     durante un'ondata è indistinguibile dal bot che ha smesso di funzionare.
   ═══════════════════════════════════════════════════════════════════════ */

import { createHash } from 'node:crypto';
import { getPrisma } from '@angel/db';
import { DEFAULT_WORDLIST, applicaModello } from '@angel/shared';
import {
  Helix,
  PoolEventSub,
  Secchiello,
  improntaMessaggio,
  secchielloChat,
  valuta,
  valutaRaid,
  type ContestoMessaggio,
  type MessaggioChat,
  type EventoRaid,
} from './deps.js';
import { Archivio } from './archivio.js';
import {
  applica,
  attivaScudo,
  manda,
  sincronizzaTermini,
  togliScudo,
  type Esecutore,
} from './azioni.js';
import { eseguiComando } from './comandi.js';
import { encrypt } from './crypto.js';
import { logger } from './logger.js';
import { Registro, type Canale } from './stato.js';

/** Ogni quanto gira il ciclo dei timer e delle scadenze. */
const TIC_MS = 10_000;

/**
 * Ogni quanto si tocca il database per la manutenzione: salvataggio degli
 * spettatori, elenco dei moderatori, sincronizzazione dei termini bloccati.
 *
 * Cinque minuti e non dieci secondi perche' sono tutte cose che possono
 * aspettare: un moderatore nominato adesso conta fra cinque minuti, e nel
 * frattempo l'esenzione funziona lo stesso perche' la legge dai badge del
 * messaggio.
 */
const MANUTENZIONE_MS = 300_000;

/** Ogni quanto si applica la conservazione dei dati. */
const PULIZIA_MS = 3_600_000;

export interface OpzioniMotore {
  clientId: string;
  clientSecret: string;
  /** Account Twitch da cui il bot parla. */
  bot: { id: string; login: string; accessToken: string; refreshToken: string | null };
  /** Domini già noti come malevoli: arriva dalle blocklist condivise con Discord. */
  hostMalevolo?: (host: string) => boolean;
}

export class Motore {
  readonly registro = new Registro();
  readonly archivio = new Archivio();
  readonly helix: Helix;
  private pool: PoolEventSub | null = null;
  private readonly secchielli = new Map<string, Secchiello>();
  private readonly online = new Map<string, number>();
  private tic: NodeJS.Timeout | null = null;
  private manutenzione: NodeJS.Timeout | null = null;
  private pulizia: NodeJS.Timeout | null = null;
  private readonly esecutore: Esecutore;

  constructor(private readonly opzioni: OpzioniMotore) {
    this.helix = new Helix(
      { clientId: opzioni.clientId, clientSecret: opzioni.clientSecret },
      {
        rinnovato: (utenteId, token) => this.salvaToken(utenteId, token),
        fallito: (utenteId, motivo) => this.tokenMorto(utenteId, motivo),
      },
    );

    this.esecutore = {
      helix: this.helix,
      archivio: this.archivio,
      botId: opzioni.bot.id,
      // Lo si chiede a Twitch nel ciclo di manutenzione: e' la differenza fra
      // venti e cento messaggi ogni trenta secondi, e durante un'ondata e'
      // esattamente la differenza fra rispondere e non rispondere.
      botModeratore: (canaleId) => this.registro.get(canaleId)?.botModeratore ?? false,
    };
  }

  /* ── Avvio ──────────────────────────────────────────────────────── */

  async avvia(): Promise<void> {
    this.helix.registraToken(this.opzioni.bot.id, {
      accessToken: this.opzioni.bot.accessToken,
      refreshToken: this.opzioni.bot.refreshToken,
    });

    const esito = await this.registro.carica();
    logger.info(esito, 'canali caricati');

    for (const canale of this.registro.tutti()) {
      if (canale.token) {
        this.helix.registraToken(canale.id, {
          accessToken: canale.token.accessToken,
          refreshToken: canale.token.refreshToken,
        });
      }
    }

    this.pool = new PoolEventSub(this.helix, {
      messaggio: (m) => this.messaggio(m),
      raid: (e) => this.raidInArrivo(e),
      stato: (e) => this.cambioStato(e.canaleId, e.online),
      notifica: (e) => this.notifica(e),
      revocata: (canaleId, tipo) => this.revocata(canaleId, tipo),
      statoConnessione: (nota, dettagli) => logger.info({ ...dettagli }, `EventSub: ${nota}`),
    });

    for (const canale of this.registro.tutti()) {
      await this.pool.aggiungiCanale(canale.id, this.opzioni.bot.id);
      this.secchielli.set(canale.id, secchielloChat(false));
      await this.registro.caricaSpettatori(canale);
    }

    await this.segnaCollegati(true);

    this.tic = setInterval(() => void this.ciclo(), TIC_MS);
    this.tic.unref?.();
    this.manutenzione = setInterval(() => void this.cicloLento(), MANUTENZIONE_MS);
    this.manutenzione.unref?.();
    this.pulizia = setInterval(() => void this.cicloPulizia(), PULIZIA_MS);
    this.pulizia.unref?.();

    // Il primo giro subito: senza, per cinque minuti il bot non sa chi sono i
    // moderatori e nessuno spettatore ha la propria reputazione.
    void this.cicloLento();

    logger.info(
      { canali: this.registro.quanti(), autonomo: this.registro.autonomo },
      this.registro.autonomo
        ? 'motore avviato in MODALITÀ AUTONOMA'
        : 'motore avviato',
    );
  }

  async ferma(): Promise<void> {
    for (const timer of [this.tic, this.manutenzione, this.pulizia]) {
      if (timer) clearInterval(timer);
    }
    this.pool?.chiudi();
    for (const secchiello of this.secchielli.values()) secchiello.ferma();

    // Gli spettatori si salvano prima di uscire: e' l'unico momento in cui il
    // delta accumulato andrebbe perso davvero.
    for (const canale of this.registro.tutti()) {
      await this.registro.salvaSpettatori(canale).catch(() => 0);
      await getPrisma()
        .twitchChannel.update({ where: { id: canale.id }, data: { connected: false } })
        .catch(() => undefined);
    }

    await this.archivio.chiudi();
  }

  /* ── Canali ─────────────────────────────────────────────────────── */

  /** Collega un canale appena autorizzato, senza riavviare niente. */
  async collega(canaleId: string): Promise<void> {
    await this.registro.carica();
    const canale = this.registro.get(canaleId);
    if (!canale) return;

    if (canale.token) {
      this.helix.registraToken(canale.id, {
        accessToken: canale.token.accessToken,
        refreshToken: canale.token.refreshToken,
      });
    }
    this.secchielli.set(canale.id, secchielloChat(false));
    await this.pool?.aggiungiCanale(canale.id, this.opzioni.bot.id);
    await this.registro.caricaSpettatori(canale);
    await this.aggiornaModeratori(canale).catch(() => undefined);
    logger.info({ canale: canale.login }, 'canale collegato');
  }

  async scollega(canaleId: string): Promise<void> {
    await this.pool?.rimuoviCanale(canaleId);
    this.secchielli.get(canaleId)?.ferma();
    this.secchielli.delete(canaleId);
    this.helix.dimenticaToken(canaleId);
    this.registro.rimuovi(canaleId);
  }

  stato(): Record<string, unknown> {
    return {
      canali: this.registro.quanti(),
      autonomo: this.registro.autonomo,
      eventsub: this.pool?.stato() ?? null,
      online: [...this.online.keys()].length,
    };
  }

  /* ── Percorso del messaggio ─────────────────────────────────────── */

  private async messaggio(messaggio: MessaggioChat): Promise<void> {
    const canale = this.registro.get(messaggio.canaleId);
    if (!canale || !canale.config.attivo) return;

    // Il bot non si ascolta: senza questo, il suo avviso «messaggio rimosso»
    // verrebbe valutato, e siccome contiene il motivo — che a volte contiene
    // la parola vietata — si sanzionerebbe da solo.
    if (messaggio.utenteId === this.opzioni.bot.id) return;

    canale.righeDaTimer += 1;

    const spettatore = this.registro.annota(
      canale,
      messaggio.utenteId,
      messaggio.utenteLogin,
      messaggio.testo,
    );

    // L'ondata si misura sui nuovi arrivati, non su tutti: è il segnale che
    // distingue un raid da una chat semplicemente vivace.
    if (messaggio.primoMessaggio) {
      const adesso = Date.now();
      canale.raid.nuovi.push(adesso);
      canale.raid.impronte.push({ impronta: improntaMessaggio(messaggio.testo), quando: adesso });

      // Si tiene solo la finestra utile: senza potatura questi due elenchi
      // crescono per tutta la diretta.
      const limite = adesso - canale.config.sicurezza.antiRaid.finestraSec * 2000;
      canale.raid.nuovi = canale.raid.nuovi.filter((q) => q >= limite);
      canale.raid.impronte = canale.raid.impronte.filter((i) => i.quando >= limite);

      await this.controllaRaid(canale);
    }

    const contesto: ContestoMessaggio = {
      messaggio,
      config: canale.config,
      spettatore,
      streamerLogin: canale.login,
      moderatoriLogin: canale.moderatori,
      ...(this.opzioni.hostMalevolo ? { hostMalevolo: this.opzioni.hostMalevolo } : {}),
    };

    const verdetto = valuta(contesto);

    if (verdetto.azione !== 'NIENTE') {
      await applica(this.esecutore, canale, verdetto, {
        utenteId: messaggio.utenteId,
        utenteLogin: messaggio.utenteLogin,
        messaggioId: messaggio.messaggioId,
        testo: messaggio.testo,
      });

      /*
       * La sanzione entra nella reputazione di chi l'ha presa.
       *
       * Non in prova: contare quello che non e' successo significherebbe che
       * una settimana di collaudo lascia la meta' della chat con la fedina
       * sporca senza che nessuno sia stato toccato.
       */
      if (!verdetto.simulato) {
        if (verdetto.azione === 'SILENZIA') spettatore.timeouts += 1;
        else if (verdetto.azione === 'BANDISCI') spettatore.bans += 1;
        else if (verdetto.azione === 'AVVERTI') spettatore.avvisi += 1;

        // La fiducia scende in fretta e risale piano: e' il verso giusto per
        // una misura che serve a decidere di chi fidarsi.
        spettatore.fiducia = Math.max(0, spettatore.fiducia - (verdetto.punteggio >= 60 ? 25 : 10));
        spettatore.delta += 1;
      }

      // Un messaggio cancellato non deve produrre anche una risposta a un
      // comando: sarebbe il bot che risponde a qualcosa che non c'è più.
      if (verdetto.eliminaMessaggio && !verdetto.simulato) return;
    }

    if (messaggio.primoMessaggio && canale.config.sicurezza.primoMessaggio.saluto) {
      await this.parla(
        canale,
        applicaModello(canale.config.sicurezza.primoMessaggio.saluto, {
          utente: messaggio.utenteNome,
          canale: canale.nome,
        }),
      );
    }

    await eseguiComando({
      esecutore: this.esecutore,
      canale,
      messaggio,
      argomento: '',
      salva: (c) => this.salvaConfig(c),
      daQuandoOnline: this.online.get(canale.id)
        ? Date.now() - (this.online.get(canale.id) ?? 0)
        : null,
      dimentica: (c, utenteId) => this.dimentica(c, utenteId),
    }).catch((errore: unknown) =>
      logger.warn({ err: errore, canale: canale.login }, 'comando fallito'),
    );
  }

  /** Manda un messaggio rispettando il limite del canale. */
  private async parla(canale: Canale, testo: string): Promise<void> {
    const secchiello = this.secchielli.get(canale.id);
    if (secchiello && !secchiello.provaSubito()) {
      // Non si mette in coda: un messaggio di chat che esce venti secondi
      // dopo è fuori contesto, e in una chat che scorre è peggio del silenzio.
      logger.debug({ canale: canale.login }, 'messaggio saltato: limite di frequenza');
      return;
    }
    await manda(this.esecutore, canale, testo);
  }

  /* ── Ondate ─────────────────────────────────────────────────────── */

  private async controllaRaid(canale: Canale): Promise<void> {
    if (canale.scudoFinoA) return;

    const verdetto = valutaRaid(canale.config, canale.raid);
    if (!verdetto.attacco) return;

    if (canale.config.modalitaProva) {
      this.archivio.registra({
        canale,
        tipo: 'PROVA',
        modulo: 'antiRaid',
        gravita: 70,
        motivo: verdetto.motivo,
        azione: 'SCUDO',
        simulato: true,
      });
      return;
    }

    await attivaScudo(this.esecutore, canale, verdetto.motivo);
  }

  /** Scudo acceso o spento a mano, dal pannello o da un comando in chat. */
  async scudoDaPannello(canale: Canale, attivo: boolean): Promise<void> {
    if (attivo) await attivaScudo(this.esecutore, canale, 'attivato a mano');
    else await togliScudo(this.esecutore, canale);
  }

  private async raidInArrivo(evento: EventoRaid): Promise<void> {
    const canale = this.registro.get(evento.aId);
    if (!canale) return;

    this.archivio.registra({
      canale,
      tipo: 'RAID_RICEVUTO',
      gravita: 10,
      utenteLogin: evento.daLogin,
      motivo: `${evento.spettatori} spettatori da ${evento.daLogin}`,
    });

    const saluto = canale.config.chat.salutoRaid;
    if (saluto) {
      await this.parla(
        canale,
        applicaModello(saluto, {
          utente: evento.daLogin,
          canale: canale.nome,
          spettatori: String(evento.spettatori),
        }),
      );
    }
  }

  /**
   * Le notifiche di sistema della chat: abbonamenti, rinnovi, regali.
   *
   * Solo il ringraziamento agli abbonati, e solo se lo streamer lo ha scritto.
   * Twitch manda una ventina di tipi di notizia diversi da qui, e rispondere a
   * tutti trasformerebbe il bot in quello che non deve essere: la cosa che
   * parla piu' di tutti in chat.
   */
  private async notifica(evento: {
    canaleId: string;
    tipo: string;
    utenteLogin: string | null;
  }): Promise<void> {
    const canale = this.registro.get(evento.canaleId);
    if (!canale) return;

    const abbonamento =
      evento.tipo === 'sub' || evento.tipo === 'resub' || evento.tipo === 'sub_gift';
    if (!abbonamento) return;

    const saluto = canale.config.chat.salutoAbbonato;
    if (!saluto || !evento.utenteLogin) return;

    await this.parla(
      canale,
      applicaModello(saluto, { utente: evento.utenteLogin, canale: canale.nome }),
    );
  }

  private cambioStato(canaleId: string, online: boolean): void {
    const canale = this.registro.get(canaleId);
    if (!canale) return;

    canale.online = online;
    if (online) this.online.set(canaleId, Date.now());
    else this.online.delete(canaleId);

    this.archivio.registra({
      canale,
      tipo: online ? 'DIRETTA_INIZIATA' : 'DIRETTA_FINITA',
      gravita: 0,
    });
  }

  /* ── Ciclo periodico ────────────────────────────────────────────── */

  private async ciclo(): Promise<void> {
    const adesso = Date.now();

    for (const canale of this.registro.tutti()) {
      if (canale.scudoFinoA && canale.scudoFinoA <= adesso) {
        await togliScudo(this.esecutore, canale).catch(() => undefined);
      }
      await this.timer(canale, adesso).catch((errore: unknown) =>
        logger.warn({ err: errore, canale: canale.login }, 'timer fallito'),
      );
    }
  }

  /** Ultima uscita di ogni timer, per canale e nome. */
  private readonly ultimoTimer = new Map<string, number>();

  /**
   * Messaggi a tempo.
   *
   * `minRighe` è la differenza fra un bot utile e uno fastidioso: senza,
   * il messaggio esce anche in una chat ferma, e su un canale piccolo il bot
   * finisce per parlare da solo tutta la sera. Il contatore delle righe si
   * azzera a ogni uscita, non a ogni tentativo — altrimenti basterebbe una
   * chat lenta perché non uscisse mai più.
   */
  private async timer(canale: Canale, adesso: number): Promise<void> {
    for (const timer of canale.config.chat.timer) {
      if (!timer.attivo) continue;
      if (!timer.ancheOffline && !canale.online) continue;

      const chiave = `${canale.id}:${timer.nome}`;
      const ultimo = this.ultimoTimer.get(chiave) ?? 0;
      if (adesso - ultimo < timer.intervalloSec * 1000) continue;
      if (canale.righeDaTimer < timer.minRighe) continue;

      const indice = Math.floor(Math.random() * timer.messaggi.length);
      const testo = timer.messaggi[indice];
      if (!testo) continue;

      await this.parla(canale, applicaModello(testo, { canale: canale.nome }));
      this.ultimoTimer.set(chiave, adesso);
      canale.righeDaTimer = 0;
    }
  }

  /* ── Manutenzione ───────────────────────────────────────────────── */

  /**
   * Il giro lento: quello che tocca il database e l'API di Twitch.
   *
   * Separato dal ciclo dei timer perché ha un costo diverso di due ordini di
   * grandezza. Il ciclo veloce guarda dei numeri in memoria; questo fa una
   * chiamata a Twitch e una scrittura per canale, e farlo ogni dieci secondi
   * significherebbe consumare il limite di frequenza per sapere una cosa che
   * cambia una volta al mese.
   */
  private async cicloLento(): Promise<void> {
    for (const canale of this.registro.tutti()) {
      await this.registro.salvaSpettatori(canale).catch((errore: unknown) =>
        logger.debug({ err: errore, canale: canale.login }, 'spettatori non salvati'),
      );

      await this.aggiornaModeratori(canale).catch((errore: unknown) =>
        logger.debug({ err: errore, canale: canale.login }, 'moderatori non aggiornati'),
      );

      await this.allineaTermini(canale).catch((errore: unknown) =>
        logger.debug({ err: errore, canale: canale.login }, 'termini bloccati non allineati'),
      );
    }

    await this.segnaCollegati(true);
  }

  /**
   * Chiede a Twitch chi modera il canale.
   *
   * Serve a due cose diverse. La prima è l'anti-impersonazione: senza questo
   * elenco, il modulo confronta i nomi solo con quello dello streamer, e chi
   * si finge un moderatore passa. La seconda è sapere se il bot stesso è
   * moderatore, che vale il quintuplo dei messaggi al secondo.
   */
  private async aggiornaModeratori(canale: Canale): Promise<void> {
    if (!canale.token) return;

    const moderatori = await this.helix.moderatori(canale.id, canale.id);
    canale.moderatori = moderatori.map((m) => m.user_login);
    canale.moderatoriAggiornatiIl = Date.now();

    const eraModeratore = canale.botModeratore;
    canale.botModeratore = moderatori.some((m) => m.user_id === this.opzioni.bot.id);

    if (canale.botModeratore !== eraModeratore) {
      // Si ridimensiona invece di ricreare: ricreando, chi ha appena speso
      // venti gettoni se ne ritroverebbe cento immediati.
      this.secchielli.get(canale.id)?.ridimensiona(canale.botModeratore ? 100 : 20);
      logger.info(
        { canale: canale.login, moderatore: canale.botModeratore },
        canale.botModeratore
          ? 'il bot è stato nominato moderatore: limite dei messaggi alzato a 100/30s'
          : 'il bot non è più moderatore: limite dei messaggi sceso a 20/30s',
      );
    }
  }

  /**
   * Copia le parole più gravi nei termini bloccati nativi di Twitch.
   *
   * Il guadagno è di tempo, ed è tutto: AutoMod di Twitch ferma il messaggio
   * *prima* che compaia, mentre il bot può solo cancellarlo dopo averlo letto.
   * In una chat veloce quella differenza sono decine di persone che lo hanno
   * già visto.
   *
   * Si rifà solo quando l'elenco cambia davvero. L'impronta esiste per quello:
   * senza, ogni cinque minuti si spenderebbero cento chiamate per riscrivere
   * le stesse novanta parole.
   */
  private async allineaTermini(canale: Canale): Promise<void> {
    const modulo = canale.config.sicurezza.linguaggio;

    if (!modulo.attivo || !modulo.sincronizzaTerminiTwitch) {
      canale.improntaTermini = '';
      return;
    }

    const parole = [
      ...(modulo.listaCondivisa
        ? DEFAULT_WORDLIST.filter((voce) => voce.severity === 'GRAVE').map((voce) => voce.term)
        : []),
      ...modulo.paroleAggiuntive,
    ]
      .filter((parola) => parola.length >= 2 && parola.length <= 100)
      .sort();

    const impronta = createHash('sha256').update(parole.join('|')).digest('hex').slice(0, 16);
    if (impronta === canale.improntaTermini) return;

    const esito = await sincronizzaTermini(this.esecutore, canale, parole);
    canale.improntaTermini = impronta;

    if (esito.aggiunti > 0 || esito.rimossi > 0) {
      logger.info({ canale: canale.login, ...esito }, 'termini bloccati di Twitch allineati');
    }
  }

  /** Segna nel database quali canali il motore sta servendo adesso. */
  private async segnaCollegati(collegati: boolean): Promise<void> {
    const ids = this.registro.tutti().map((canale) => canale.id);
    if (ids.length === 0) return;

    await getPrisma()
      .twitchChannel.updateMany({
        where: { id: { in: ids } },
        data: { connected: collegati, lastSeenAt: new Date() },
      })
      .catch(() => undefined);
  }

  /* ── Conservazione dei dati ─────────────────────────────────────── */

  /**
   * Applica quello che i termini di Twitch impongono.
   *
   * Non è pulizia di manutenzione: è un obbligo contrattuale. Il Developer
   * Services Agreement dice che i log di chat si conservano solo per il tempo
   * necessario al servizio, e senza qualcosa che li cancelli quella frase
   * resta una dichiarazione d'intenti dentro un file di configurazione.
   *
   * Tre passaggi, dal più urgente al meno:
   *
   * 1. il **testo** dei messaggi, scritto da terzi e con la scadenza più
   *    corta — si azzera senza toccare la riga, così il provvedimento resta
   *    verificabile e il contenuto sparisce;
   * 2. gli **eventi** interi, oltre la loro scadenza;
   * 3. gli **spettatori** che non si vedono da troppo.
   */
  private async cicloPulizia(): Promise<void> {
    const prisma = getPrisma();
    let testi = 0;
    let eventi = 0;
    let spettatori = 0;

    try {
      // Il testo non ha bisogno del canale: la scadenza è scritta sulla riga,
      // calcolata quando è stata creata. Una query sola per tutti.
      const scaduti = await prisma.twitchEvent.updateMany({
        where: { textExpiresAt: { lt: new Date() }, text: { not: null } },
        data: { text: null, textExpiresAt: null },
      });
      testi = scaduti.count;

      for (const canale of this.registro.tutti()) {
        const conservazione = canale.config.conservazione;

        const primaDegliEventi = new Date(Date.now() - conservazione.eventiGiorni * 86_400_000);
        const vecchi = await prisma.twitchEvent.deleteMany({
          where: { channelId: canale.id, createdAt: { lt: primaDegliEventi } },
        });
        eventi += vecchi.count;

        const primaDegliSpettatori = new Date(
          Date.now() - conservazione.spettatoriGiorni * 86_400_000,
        );
        const dimenticati = await prisma.twitchViewer.deleteMany({
          where: {
            channelId: canale.id,
            lastSeenAt: { lt: primaDegliSpettatori },
            // Chi è stato esentato a mano resta: è una decisione dello
            // streamer, non un dato raccolto passivamente.
            trusted: false,
          },
        });
        spettatori += dimenticati.count;
      }

      // Le sessioni scadute del pannello non hanno un canale: si tolgono qui
      // perché è l'unico lavoro periodico che questo processo esegue.
      await prisma.twitchSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });

      if (testi + eventi + spettatori > 0) {
        logger.info({ testi, eventi, spettatori }, 'conservazione applicata');
      }
    } catch (errore) {
      logger.warn({ err: errore }, 'pulizia per scadenza non riuscita');
    }
  }

  /* ── Persistenza ────────────────────────────────────────────────── */

  /**
   * Salva la configurazione, e dice se ci è riuscito.
   *
   * Il valore di ritorno non è cortesia: i comandi in chat lo usano per dire
   * «attivo adesso, ma non salvato». Senza, uno streamer che cambia livello
   * durante un guasto crederebbe di averlo cambiato per sempre, e lo
   * ritroverebbe com'era al riavvio successivo senza capire perché.
   */
  private async salvaConfig(canale: Canale): Promise<boolean> {
    this.registro.aggiorna(canale.id, canale.config);
    try {
      await getPrisma().twitchChannel.update({
        where: { id: canale.id },
        data: { config: canale.config },
      });
      return true;
    } catch (errore) {
      logger.warn({ err: errore, canale: canale.login }, 'configurazione non salvata');
      return false;
    }
  }

  private async salvaToken(
    utenteId: string,
    token: { accessToken: string; refreshToken: string | null },
  ): Promise<void> {
    const canale = this.registro.get(utenteId);
    if (canale) canale.token = token;

    if (utenteId === this.opzioni.bot.id) return;

    await getPrisma()
      .twitchChannel.update({
        where: { id: utenteId },
        data: {
          tokenEnc: encrypt(token.accessToken),
          refreshEnc: token.refreshToken ? encrypt(token.refreshToken) : null,
          tokenFailedAt: null,
        },
      })
      .catch((errore: unknown) =>
        logger.warn({ err: errore, utenteId }, 'token rinnovato ma non salvato'),
      );
  }

  /**
   * Il refresh non funziona più: il canale va riautorizzato.
   *
   * Si segna e si avvisa una volta sola. Continuare a riprovare consumerebbe
   * il limite di frequenza contro un muro, e riavvisare a ogni tentativo
   * riempirebbe il registro di una notizia che non cambia.
   */
  private async tokenMorto(utenteId: string, motivo: string): Promise<void> {
    const canale = this.registro.get(utenteId);
    if (!canale) return;

    canale.token = null;
    logger.error({ canale: canale.login, motivo }, 'canale da riautorizzare');

    this.archivio.registra({
      canale,
      tipo: 'AUTORIZZAZIONE_SCADUTA',
      gravita: 60,
      motivo: `il collegamento con Twitch non è più valido: ${motivo}`,
    });

    await getPrisma()
      .twitchChannel.update({ where: { id: utenteId }, data: { tokenFailedAt: new Date() } })
      .catch(() => undefined);
  }

  private async revocata(canaleId: string, tipo: string): Promise<void> {
    const canale = this.registro.get(canaleId);
    if (!canale) return;
    logger.warn({ canale: canale.login, tipo }, 'sottoscrizione revocata da Twitch');
    this.archivio.registra({
      canale,
      tipo: 'SOTTOSCRIZIONE_REVOCATA',
      gravita: 50,
      motivo: `Twitch ha revocato ${tipo}: il canale va riautorizzato`,
    });
  }

  /**
   * Cancella tutto quello che si sa di una persona su un canale.
   *
   * È l'attuazione di `!angel dimenticami`, e delle richieste di
   * cancellazione dal pannello. Tocca il database e la memoria: lasciare la
   * copia in memoria significherebbe che la cancellazione dura fino al primo
   * messaggio successivo.
   */
  async dimentica(canale: Canale, utenteId: string): Promise<number> {
    canale.spettatori.delete(utenteId);

    try {
      const [eventi, spettatore] = await Promise.all([
        getPrisma().twitchEvent.deleteMany({ where: { channelId: canale.id, actorId: utenteId } }),
        getPrisma().twitchViewer.deleteMany({
          where: { channelId: canale.id, twitchUserId: utenteId },
        }),
      ]);
      return eventi.count + spettatore.count;
    } catch (errore) {
      logger.warn({ err: errore }, 'cancellazione dei dati non riuscita');
      return 0;
    }
  }
}
