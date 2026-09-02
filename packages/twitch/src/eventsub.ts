/* ═══════════════════════════════════════════════════════════════════════
   EVENTSUB SU WEBSOCKET

   Come il bot sente la chat. È la scelta che decide se il progetto regge o no,
   quindi vale la pena dire perché non è IRC.

   IRC funziona ancora, ed è più semplice: ci si collega, si fa JOIN sui canali
   e arrivano i PRIVMSG. Il problema è che una connessione IRC entra in cento
   canali al massimo, e ogni JOIN conta su un limite di venti ogni dieci
   secondi. Con trenta streamer va bene; con trecento servono quattro
   connessioni, una tabella che dice quale canale sta su quale, e la gestione
   della riconnessione di una sola delle quattro. Ed è deprecato per le
   funzioni nuove: le sottoscrizioni moderne — moderazione, utenti sospetti,
   modalità scudo — su IRC non arrivano affatto.

   EventSub su WebSocket regge trecento sottoscrizioni per connessione senza
   limiti di ingresso, e porta gli eventi che IRC non ha. Il prezzo è tutto qui
   dentro: la sessione va tenuta viva a mano.

   Tre cose che vanno capite o il bot muore in silenzio:

   1. **Il keepalive è un contratto.** Twitch dichiara ogni quanti secondi
      manderà qualcosa. Se quel qualcosa non arriva, la connessione è morta
      anche se il socket risulta aperto — ed è il modo tipico in cui un bot
      «resta collegato» per ore senza ricevere un messaggio. Qui un messaggio
      qualsiasi riarma il timer, e allo scadere si riconnette senza chiedere.

   2. **La riconnessione arriva con un preavviso.** Twitch manda
      `session_reconnect` con un indirizzo nuovo: ci si collega *prima* di
      chiudere il vecchio, e le sottoscrizioni si trasferiscono da sole. Chi
      chiude prima di aprire perde i messaggi nel mezzo, che sono i secondi in
      cui di solito succede qualcosa.

   3. **La sottoscrizione può essere revocata.** Se lo streamer toglie
      l'autorizzazione, Twitch manda `revocation` e smette. Non è un errore da
      ritentare: è una decisione di una persona, e insistere significa bussare
      per sempre a una porta chiusa.
   ═══════════════════════════════════════════════════════════════════════ */

import type { Helix } from './helix.js';

const URL_EVENTSUB = 'wss://eventsub.wss.twitch.tv/ws';

/**
 * Sottoscrizioni per connessione.
 *
 * Twitch ne consente 300; qui si sta a 280 per lasciare margine ai canali che
 * si aggiungono mentre una connessione si sta riprendendo — arrivare al muro
 * durante una riconnessione significa che l'ultimo canale entrato resta fuori
 * senza che nessuno se ne accorga.
 */
const MAX_SOTTOSCRIZIONI = 280;

export interface MessaggioChat {
  canaleId: string;
  canaleLogin: string;
  messaggioId: string;
  utenteId: string;
  utenteLogin: string;
  utenteNome: string;
  testo: string;
  /** Frammenti: servono a contare le emote senza indovinarle dal testo. */
  emote: number;
  colore: string | null;
  moderatore: boolean;
  abbonato: boolean;
  vip: boolean;
  streamer: boolean;
  /** Vero se Twitch dichiara che è il primo messaggio della persona nel canale. */
  primoMessaggio: boolean;
  rispostaA: string | null;
}

export interface EventoRaid {
  daId: string;
  daLogin: string;
  aId: string;
  spettatori: number;
}

export interface EventoStato {
  canaleId: string;
  online: boolean;
}

export interface EventoNotifica {
  canaleId: string;
  /** sub, resub, raid, announcement, … */
  tipo: string;
  utenteLogin: string | null;
  testo: string | null;
}

export interface AscoltatoriEventSub {
  messaggio?: (m: MessaggioChat) => void | Promise<void>;
  raid?: (e: EventoRaid) => void | Promise<void>;
  stato?: (e: EventoStato) => void | Promise<void>;
  notifica?: (e: EventoNotifica) => void | Promise<void>;
  /** Una sottoscrizione è stata revocata: il canale va riautorizzato. */
  revocata?: (canaleId: string, tipo: string) => void | Promise<void>;
  /** Diagnostica: connessione aperta, persa, riconnessa. */
  statoConnessione?: (nota: string, dettagli?: Record<string, unknown>) => void;
}

interface Sottoscrizione {
  canaleId: string;
  tipo: string;
  versione: string;
  condizione: Record<string, string>;
  /** Chi autorizza: il bot per la chat, lo streamer per il resto. */
  comeUtente?: string;
  /** Id assegnato da Twitch, per cancellarla. */
  id?: string;
}

/* ── Una connessione ──────────────────────────────────────────────────── */

class Connessione {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private keepaliveMs = 30_000;
  private orologio: NodeJS.Timeout | null = null;
  private chiusa = false;
  /** Sottoscrizioni assegnate a questa connessione. */
  readonly sottoscrizioni: Sottoscrizione[] = [];
  private tentativi = 0;

  constructor(
    private readonly helix: Helix,
    private readonly ascoltatori: AscoltatoriEventSub,
    private readonly url: string = URL_EVENTSUB,
  ) {}

  get piena(): boolean {
    return this.sottoscrizioni.length >= MAX_SOTTOSCRIZIONI;
  }

  get collegata(): boolean {
    return this.sessionId !== null && this.socket?.readyState === WebSocket.OPEN;
  }

  get quante(): number {
    return this.sottoscrizioni.length;
  }

  apri(): void {
    if (this.chiusa) return;

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('message', (evento) => {
      // Ogni messaggio riarma il keepalive, non solo quelli di tipo
      // `session_keepalive`: durante una chat viva i keepalive non arrivano
      // affatto, perché Twitch li manda solo quando non ha altro da dire.
      this.riarma();
      void this.gestisci(String(evento.data)).catch((errore: unknown) =>
        this.ascoltatori.statoConnessione?.('errore nel messaggio', { errore: String(errore) }),
      );
    });

    socket.addEventListener('close', (evento) => {
      this.ascoltatori.statoConnessione?.('connessione chiusa', {
        codice: evento.code,
        motivo: evento.reason,
      });
      this.sessionId = null;
      this.riconnetti();
    });

    socket.addEventListener('error', () => {
      // L'evento `error` di WebSocket non porta informazioni utili e viene
      // sempre seguito da `close`: la riconnessione si fa lì, una volta sola.
      this.ascoltatori.statoConnessione?.('errore di rete sul socket');
    });
  }

  chiudi(): void {
    this.chiusa = true;
    if (this.orologio) clearTimeout(this.orologio);
    this.orologio = null;
    this.socket?.close();
    this.socket = null;
  }

  /** Aggiunge una sottoscrizione e la registra se la sessione è già aperta. */
  async aggiungi(sottoscrizione: Sottoscrizione): Promise<void> {
    this.sottoscrizioni.push(sottoscrizione);
    if (this.sessionId) await this.registra(sottoscrizione);
  }

  /** Toglie tutte le sottoscrizioni di un canale. */
  async togliCanale(canaleId: string): Promise<void> {
    const mie = this.sottoscrizioni.filter((s) => s.canaleId === canaleId);
    for (const sottoscrizione of mie) {
      if (sottoscrizione.id) {
        await this.helix.cancellaSottoscrizione(sottoscrizione.id).catch(() => undefined);
      }
      const indice = this.sottoscrizioni.indexOf(sottoscrizione);
      if (indice >= 0) this.sottoscrizioni.splice(indice, 1);
    }
  }

  haCanale(canaleId: string): boolean {
    return this.sottoscrizioni.some((s) => s.canaleId === canaleId);
  }

  private async gestisci(dati: string): Promise<void> {
    const messaggio = JSON.parse(dati) as {
      metadata: { message_type: string; subscription_type?: string };
      payload: Record<string, unknown>;
    };

    switch (messaggio.metadata.message_type) {
      case 'session_welcome': {
        const sessione = messaggio.payload.session as {
          id: string;
          keepalive_timeout_seconds: number | null;
        };
        this.sessionId = sessione.id;
        this.keepaliveMs = (sessione.keepalive_timeout_seconds ?? 30) * 1000;
        this.tentativi = 0;
        this.riarma();
        this.ascoltatori.statoConnessione?.('sessione aperta', {
          sottoscrizioni: this.sottoscrizioni.length,
        });
        await this.registraTutte();
        break;
      }

      case 'session_reconnect': {
        const sessione = messaggio.payload.session as { reconnect_url: string };
        this.trasloca(sessione.reconnect_url);
        break;
      }

      case 'notification':
        await this.notifica(messaggio.metadata.subscription_type ?? '', messaggio.payload);
        break;

      case 'revocation': {
        const sottoscrizione = messaggio.payload.subscription as {
          type: string;
          condition: Record<string, string>;
        };
        const canaleId =
          sottoscrizione.condition.broadcaster_user_id ??
          sottoscrizione.condition.to_broadcaster_user_id ??
          '';
        await this.ascoltatori.revocata?.(canaleId, sottoscrizione.type);
        break;
      }

      case 'session_keepalive':
        break;

      default:
        break;
    }
  }

  /**
   * Passa a una connessione nuova senza buchi.
   *
   * Si apre la seconda, si aspetta che dica benvenuto, e solo allora si chiude
   * la prima. Twitch trasferisce da sé le sottoscrizioni sulla sessione nuova:
   * riregistrarle produrrebbe dei duplicati, e ogni messaggio arriverebbe due
   * volte — che con un anti-spam attivo significa sanzionare due volte.
   */
  private trasloca(nuovoUrl: string): void {
    const vecchio = this.socket;
    const socket = new WebSocket(nuovoUrl);

    socket.addEventListener('message', (evento) => {
      this.riarma();
      void this.gestisci(String(evento.data)).catch(() => undefined);
    });

    socket.addEventListener('open', () => {
      this.socket = socket;
      // Chiusura ritardata: il vecchio socket può avere ancora messaggi in
      // volo, e Twitch lo chiude da solo dopo il trasloco.
      setTimeout(() => vecchio?.close(), 5_000).unref?.();
      this.ascoltatori.statoConnessione?.('trasloco su una sessione nuova');
    });

    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.sessionId = null;
        this.riconnetti();
      }
    });
  }

  /**
   * Riconnessione con attesa crescente.
   *
   * Twitch ha avuto disservizi da decine di minuti: riprovare ogni secondo
   * significa migliaia di tentativi inutili e un rischio concreto di finire
   * limitati proprio mentre si torna su.
   */
  private riconnetti(): void {
    if (this.chiusa) return;

    this.tentativi += 1;
    const attesa = Math.min(1000 * 2 ** Math.min(this.tentativi, 6), 60_000);
    const conRumore = attesa * (0.75 + Math.random() * 0.5);

    setTimeout(() => {
      // Le sottoscrizioni restano nell'elenco: alla sessione nuova si
      // riregistrano tutte, e i loro id vecchi sono ormai carta straccia.
      for (const sottoscrizione of this.sottoscrizioni) delete sottoscrizione.id;
      this.apri();
    }, conRumore).unref?.();
  }

  /** Il cane da guardia: se Twitch tace oltre il patto, la connessione è morta. */
  private riarma(): void {
    if (this.orologio) clearTimeout(this.orologio);
    this.orologio = setTimeout(() => {
      this.ascoltatori.statoConnessione?.('nessun segnale entro il keepalive: riapro');
      this.socket?.close();
    }, this.keepaliveMs + 5_000);
    this.orologio.unref?.();
  }

  private async registraTutte(): Promise<void> {
    for (const sottoscrizione of this.sottoscrizioni) {
      if (sottoscrizione.id) continue;
      await this.registra(sottoscrizione);
    }
  }

  private async registra(sottoscrizione: Sottoscrizione): Promise<void> {
    if (!this.sessionId) return;
    try {
      const creata = await this.helix.sottoscrivi(
        sottoscrizione.tipo,
        sottoscrizione.versione,
        sottoscrizione.condizione,
        this.sessionId,
        sottoscrizione.comeUtente,
      );
      sottoscrizione.id = creata.id;
    } catch (errore) {
      // Una sottoscrizione rifiutata non deve impedire le altre: succede per
      // un permesso mancante su un canale solo, e far cadere tutto
      // significherebbe che uno streamer che non ha autorizzato bene spegne
      // il bot per tutti gli altri.
      this.ascoltatori.statoConnessione?.('sottoscrizione rifiutata', {
        canale: sottoscrizione.canaleId,
        tipo: sottoscrizione.tipo,
        errore: String(errore),
      });
    }
  }

  private async notifica(tipo: string, payload: Record<string, unknown>): Promise<void> {
    const evento = payload.event as Record<string, unknown> | undefined;
    if (!evento) return;

    switch (tipo) {
      case 'channel.chat.message': {
        await this.ascoltatori.messaggio?.(leggiMessaggio(evento));
        break;
      }

      case 'channel.raid': {
        await this.ascoltatori.raid?.({
          daId: String(evento.from_broadcaster_user_id ?? ''),
          daLogin: String(evento.from_broadcaster_user_login ?? ''),
          aId: String(evento.to_broadcaster_user_id ?? ''),
          spettatori: Number(evento.viewers ?? 0),
        });
        break;
      }

      case 'stream.online':
      case 'stream.offline': {
        await this.ascoltatori.stato?.({
          canaleId: String(evento.broadcaster_user_id ?? ''),
          online: tipo === 'stream.online',
        });
        break;
      }

      case 'channel.chat.notification': {
        await this.ascoltatori.notifica?.({
          canaleId: String(evento.broadcaster_user_id ?? ''),
          tipo: String(evento.notice_type ?? ''),
          utenteLogin: evento.chatter_user_login ? String(evento.chatter_user_login) : null,
          testo: (evento.message as { text?: string } | undefined)?.text ?? null,
        });
        break;
      }

      default:
        break;
    }
  }
}

/** Traduce l'evento di Twitch nella forma che usa il resto del bot. */
function leggiMessaggio(evento: Record<string, unknown>): MessaggioChat {
  const messaggio = evento.message as
    | { text?: string; fragments?: { type: string }[] }
    | undefined;
  const badge = (evento.badges as { set_id: string }[] | undefined) ?? [];
  const insiemi = new Set(badge.map((b) => b.set_id));

  return {
    canaleId: String(evento.broadcaster_user_id ?? ''),
    canaleLogin: String(evento.broadcaster_user_login ?? ''),
    messaggioId: String(evento.message_id ?? ''),
    utenteId: String(evento.chatter_user_id ?? ''),
    utenteLogin: String(evento.chatter_user_login ?? ''),
    utenteNome: String(evento.chatter_user_name ?? evento.chatter_user_login ?? ''),
    testo: messaggio?.text ?? '',
    emote: (messaggio?.fragments ?? []).filter((f) => f.type === 'emote').length,
    colore: evento.color ? String(evento.color) : null,
    // I badge sono la sola fonte affidabile: il campo `moderator` non esiste
    // in questo evento, e dedurlo dal nome sarebbe indovinare.
    moderatore: insiemi.has('moderator') || insiemi.has('broadcaster'),
    abbonato: insiemi.has('subscriber') || insiemi.has('founder'),
    vip: insiemi.has('vip'),
    streamer: insiemi.has('broadcaster'),
    // Lo dichiara Twitch, e il suo conto è quello vero: vale anche per chi
    // aveva scritto una volta sola tre anni fa, che è precisamente il caso in
    // cui un conteggio tenuto dal bot direbbe di no.
    primoMessaggio: Boolean(evento.is_first_message),
    rispostaA: (evento.reply as { parent_message_id?: string } | undefined)?.parent_message_id ?? null,
  };
}

/* ── Il gruppo di connessioni ─────────────────────────────────────────── */

/**
 * Tiene tante connessioni quante servono e ci distribuisce sopra i canali.
 *
 * Con meno di settanta canali ce n'è una sola e questa classe non fa niente
 * di visibile. Esiste perché il giorno in cui i canali diventano cento non ci
 * sia da riscrivere il motore: si aggiunge un socket e i canali nuovi ci
 * finiscono sopra da soli.
 */
export class PoolEventSub {
  private readonly connessioni: Connessione[] = [];

  constructor(
    private readonly helix: Helix,
    private readonly ascoltatori: AscoltatoriEventSub,
  ) {}

  /**
   * Collega un canale.
   *
   * `utenteBotId` è l'account da cui il bot parla: la sottoscrizione della
   * chat vuole il suo token, non quello dello streamer. È l'errore che si fa
   * la prima volta, e Twitch risponde 401 senza dire quale dei due si
   * aspettava.
   */
  async aggiungiCanale(canaleId: string, utenteBotId: string): Promise<void> {
    const sottoscrizioni: Sottoscrizione[] = [
      {
        canaleId,
        tipo: 'channel.chat.message',
        versione: '1',
        condizione: { broadcaster_user_id: canaleId, user_id: utenteBotId },
        comeUtente: utenteBotId,
      },
      {
        canaleId,
        tipo: 'channel.chat.notification',
        versione: '1',
        condizione: { broadcaster_user_id: canaleId, user_id: utenteBotId },
        comeUtente: utenteBotId,
      },
      {
        canaleId,
        tipo: 'channel.raid',
        versione: '1',
        condizione: { to_broadcaster_user_id: canaleId },
      },
      {
        canaleId,
        tipo: 'stream.online',
        versione: '1',
        condizione: { broadcaster_user_id: canaleId },
      },
      {
        canaleId,
        tipo: 'stream.offline',
        versione: '1',
        condizione: { broadcaster_user_id: canaleId },
      },
    ];

    const connessione = this.perNuoveSottoscrizioni(sottoscrizioni.length);
    for (const sottoscrizione of sottoscrizioni) await connessione.aggiungi(sottoscrizione);
  }

  async rimuoviCanale(canaleId: string): Promise<void> {
    for (const connessione of this.connessioni) {
      if (connessione.haCanale(canaleId)) await connessione.togliCanale(canaleId);
    }
  }

  /** Stato per la diagnostica e per `!angel stato`. */
  stato(): { connessioni: number; sottoscrizioni: number; collegate: number } {
    return {
      connessioni: this.connessioni.length,
      sottoscrizioni: this.connessioni.reduce((somma, c) => somma + c.quante, 0),
      collegate: this.connessioni.filter((c) => c.collegata).length,
    };
  }

  chiudi(): void {
    for (const connessione of this.connessioni) connessione.chiudi();
    this.connessioni.length = 0;
  }

  private perNuoveSottoscrizioni(quante: number): Connessione {
    const libera = this.connessioni.find((c) => c.quante + quante <= MAX_SOTTOSCRIZIONI);
    if (libera) return libera;

    const nuova = new Connessione(this.helix, this.ascoltatori);
    this.connessioni.push(nuova);
    nuova.apri();
    return nuova;
  }
}
