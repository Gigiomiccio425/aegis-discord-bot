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

import { getPrisma } from '@angel/db';
import { applicaModello } from '@angel/shared';
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
import { applica, attivaScudo, manda, togliScudo, type Esecutore } from './azioni.js';
import { eseguiComando } from './comandi.js';
import { encrypt } from './crypto.js';
import { logger } from './logger.js';
import { Registro, type Canale } from './stato.js';

/** Ogni quanto gira il ciclo dei timer e delle scadenze. */
const TIC_MS = 10_000;

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
      // Per ora il bot non è moderatore finché lo streamer non lo nomina, e
      // non c'è modo di saperlo senza chiederlo: si parte dal limite basso e
      // lo si alza quando una chiamata riesce con i privilegi da moderatore.
      botModeratore: () => false,
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
      revocata: (canaleId, tipo) => this.revocata(canaleId, tipo),
      statoConnessione: (nota, dettagli) => logger.info({ ...dettagli }, `EventSub: ${nota}`),
    });

    for (const canale of this.registro.tutti()) {
      await this.pool.aggiungiCanale(canale.id, this.opzioni.bot.id);
      this.secchielli.set(canale.id, secchielloChat(false));
    }

    this.tic = setInterval(() => void this.ciclo(), TIC_MS);
    this.tic.unref?.();

    logger.info(
      { canali: this.registro.quanti(), autonomo: this.registro.autonomo },
      this.registro.autonomo
        ? 'motore avviato in MODALITÀ AUTONOMA'
        : 'motore avviato',
    );
  }

  async ferma(): Promise<void> {
    if (this.tic) clearInterval(this.tic);
    this.pool?.chiudi();
    for (const secchiello of this.secchielli.values()) secchiello.ferma();
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
