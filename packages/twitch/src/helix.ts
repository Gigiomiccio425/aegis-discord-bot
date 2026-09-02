/* ═══════════════════════════════════════════════════════════════════════
   CLIENT HELIX

   Il minimo indispensabile per moderare una chat, e niente di più.

   Due tipi di credenziale, e la differenza non è un dettaglio:

   • Il **token dell'applicazione** (client credentials) serve a leggere dati
     pubblici e a registrare le sottoscrizioni EventSub via WebSocket. Non
     appartiene a nessuno e non può moderare niente.

   • Il **token dello streamer** (authorization code) serve per ogni azione
     su un canale: cancellare, silenziare, bandire, cambiare le impostazioni
     della chat. Scade dopo circa quattro ore e va rinnovato con il refresh
     token, che a sua volta si invalida se lo streamer cambia password o
     revoca l'accesso.

   Quel rinnovo è la parte che rompe i bot fatti in casa: funziona per giorni,
   poi una notte scade mentre nessuno guarda e la mattina dopo il bot è muto
   senza un errore che lo dica. Qui il rinnovo è dentro la richiesta — un 401
   provoca un tentativo di refresh e una sola ripetizione — e il fallimento
   del refresh è un evento esplicito, perché è l'unico caso in cui serve
   davvero riavvisare lo streamer.
   ═══════════════════════════════════════════════════════════════════════ */

import { Secchiello, secchielloHelix } from './bucket.js';

const HELIX = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2';

/** Timeout di ogni chiamata. Twitch risponde in centinaia di millisecondi. */
const TIMEOUT_MS = 10_000;

export interface CredenzialiApp {
  clientId: string;
  clientSecret: string;
}

export interface TokenCanale {
  accessToken: string;
  refreshToken: string | null;
  /** Scadenza nota, se la si è salvata. */
  expiresAt?: Date | null;
}

/** Cosa fare quando un token viene rinnovato o smette di funzionare. */
export interface AscoltatoreToken {
  rinnovato: (utenteId: string, token: TokenCanale) => void | Promise<void>;
  fallito: (utenteId: string, motivo: string) => void | Promise<void>;
}

export class ErroreHelix extends Error {
  constructor(
    readonly stato: number,
    readonly percorso: string,
    readonly corpo: string,
  ) {
    super(`Helix ${stato} su ${percorso}: ${corpo.slice(0, 200)}`);
    this.name = 'ErroreHelix';
  }

  /** L'errore si risolve riprovando fra un po', o è definitivo? */
  get temporaneo(): boolean {
    return this.stato === 429 || this.stato >= 500;
  }
}

/* ── Client ───────────────────────────────────────────────────────────── */

export class Helix {
  private tokenApp: { valore: string; scade: number } | null = null;
  private readonly token = new Map<string, TokenCanale>();
  /** Rinnovi in corso, per canale: due richieste che scadono insieme ne fanno uno solo. */
  private readonly rinnoviInCorso = new Map<string, Promise<string | null>>();
  readonly secchiello: Secchiello;

  constructor(
    private readonly credenziali: CredenzialiApp,
    private readonly ascoltatore?: Partial<AscoltatoreToken>,
    secchiello?: Secchiello,
  ) {
    this.secchiello = secchiello ?? secchielloHelix();
  }

  /* ── Credenziali ────────────────────────────────────────────────── */

  /** Registra il token di un canale, letto dal database. */
  registraToken(utenteId: string, token: TokenCanale): void {
    this.token.set(utenteId, token);
  }

  dimenticaToken(utenteId: string): void {
    this.token.delete(utenteId);
  }

  /**
   * Token dell'applicazione, con rinnovo automatico.
   *
   * Rinnovato con un minuto di margine: un token che scade fra dieci secondi
   * è già scaduto per una richiesta che deve ancora partire, viaggiare e
   * tornare.
   */
  async tokenApplicazione(): Promise<string> {
    if (this.tokenApp && this.tokenApp.scade > Date.now() + 60_000) return this.tokenApp.valore;

    const risposta = await fetch(`${OAUTH}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credenziali.clientId,
        client_secret: this.credenziali.clientSecret,
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!risposta.ok) {
      throw new ErroreHelix(risposta.status, '/oauth2/token', await risposta.text());
    }

    const corpo = (await risposta.json()) as { access_token: string; expires_in: number };
    this.tokenApp = { valore: corpo.access_token, scade: Date.now() + corpo.expires_in * 1000 };
    return corpo.access_token;
  }

  /**
   * Rinnova il token di un canale.
   *
   * Restituisce `null` quando il refresh non è più valido: è la condizione da
   * cui non si esce da soli, e il chiamante deve smettere di riprovare invece
   * di consumare il limite di frequenza contro un muro.
   */
  private async rinnova(utenteId: string): Promise<string | null> {
    const inCorso = this.rinnoviInCorso.get(utenteId);
    if (inCorso) return inCorso;

    const promessa = this.eseguiRinnovo(utenteId).finally(() =>
      this.rinnoviInCorso.delete(utenteId),
    );
    this.rinnoviInCorso.set(utenteId, promessa);
    return promessa;
  }

  private async eseguiRinnovo(utenteId: string): Promise<string | null> {
    const corrente = this.token.get(utenteId);
    if (!corrente?.refreshToken) {
      await this.ascoltatore?.fallito?.(utenteId, 'nessun refresh token salvato');
      return null;
    }

    const risposta = await fetch(`${OAUTH}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credenziali.clientId,
        client_secret: this.credenziali.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: corrente.refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);

    if (!risposta) {
      // Rete assente: non è il refresh a essere scaduto. Non si avvisa
      // nessuno e non si cancella niente, perché fra un minuto potrebbe
      // funzionare — dire «riautorizza il canale» per una rete caduta
      // manderebbe lo streamer a rifare un lavoro che non serviva.
      return null;
    }

    if (!risposta.ok) {
      const testo = await risposta.text();
      this.token.delete(utenteId);
      await this.ascoltatore?.fallito?.(utenteId, `rinnovo rifiutato: ${testo.slice(0, 200)}`);
      return null;
    }

    const corpo = (await risposta.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const nuovo: TokenCanale = {
      accessToken: corpo.access_token,
      // Twitch può restituire un refresh token nuovo: ignorarlo significa
      // continuare a usare quello vecchio finché non smette di funzionare.
      refreshToken: corpo.refresh_token ?? corrente.refreshToken,
      expiresAt: new Date(Date.now() + corpo.expires_in * 1000),
    };

    this.token.set(utenteId, nuovo);
    await this.ascoltatore?.rinnovato?.(utenteId, nuovo);
    return nuovo.accessToken;
  }

  /* ── Richiesta ──────────────────────────────────────────────────── */

  /**
   * Una chiamata Helix.
   *
   * `comeUtente` sceglie la credenziale: con un id di canale si usa il token
   * dello streamer, senza si usa quello dell'applicazione.
   */
  async chiama<T>(
    metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    percorso: string,
    opzioni: {
      comeUtente?: string;
      query?: Record<string, string | string[] | number | boolean | undefined>;
      corpo?: unknown;
      costo?: number;
      /** Uso interno: evita il ciclo infinito quando il rinnovo non basta. */
      giaRinnovato?: boolean;
    } = {},
  ): Promise<T> {
    await this.secchiello.prendi(opzioni.costo ?? 1);

    const token = opzioni.comeUtente
      ? this.token.get(opzioni.comeUtente)?.accessToken
      : await this.tokenApplicazione();

    if (!token) {
      throw new ErroreHelix(401, percorso, 'nessun token per questo canale: va riautorizzato');
    }

    const url = new URL(HELIX + percorso);
    for (const [chiave, valore] of Object.entries(opzioni.query ?? {})) {
      if (valore === undefined) continue;
      // Twitch vuole i parametri ripetuti, non separati da virgola:
      // `?id=1&id=2`. Con la virgola risponde 400 senza spiegare quale
      // parametro non gli piace.
      if (Array.isArray(valore)) for (const v of valore) url.searchParams.append(chiave, v);
      else url.searchParams.set(chiave, String(valore));
    }

    const risposta = await fetch(url, {
      method: metodo,
      headers: {
        authorization: `Bearer ${token}`,
        'client-id': this.credenziali.clientId,
        ...(opzioni.corpo ? { 'content-type': 'application/json' } : {}),
      },
      ...(opzioni.corpo ? { body: JSON.stringify(opzioni.corpo) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // 401 con token di canale: si prova a rinnovare, una volta sola.
    if (risposta.status === 401 && opzioni.comeUtente && !opzioni.giaRinnovato) {
      const nuovo = await this.rinnova(opzioni.comeUtente);
      if (nuovo) return this.chiama<T>(metodo, percorso, { ...opzioni, giaRinnovato: true });
    }

    // 401 con token dell'applicazione: si butta e si riprova una volta. Capita
    // quando Twitch lo invalida prima della scadenza dichiarata.
    if (risposta.status === 401 && !opzioni.comeUtente && !opzioni.giaRinnovato) {
      this.tokenApp = null;
      return this.chiama<T>(metodo, percorso, { ...opzioni, giaRinnovato: true });
    }

    if (risposta.status === 204) return undefined as T;

    if (!risposta.ok) throw new ErroreHelix(risposta.status, percorso, await risposta.text());

    const testo = await risposta.text();
    return (testo ? JSON.parse(testo) : undefined) as T;
  }

  /* ── Utenti e canali ────────────────────────────────────────────── */

  async utenti(login: string[]): Promise<UtenteTwitch[]> {
    if (login.length === 0) return [];
    const risposta = await this.chiama<{ data: UtenteTwitch[] }>('GET', '/users', {
      query: { login },
    });
    return risposta.data;
  }

  async utentiPerId(id: string[]): Promise<UtenteTwitch[]> {
    if (id.length === 0) return [];
    const risposta = await this.chiama<{ data: UtenteTwitch[] }>('GET', '/users', { query: { id } });
    return risposta.data;
  }

  /** Chi ha autorizzato: si legge dal token, senza sapere in anticipo chi sia. */
  async ioSono(accessToken: string): Promise<UtenteTwitch | null> {
    const risposta = await fetch(`${HELIX}/users`, {
      headers: { authorization: `Bearer ${accessToken}`, 'client-id': this.credenziali.clientId },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!risposta.ok) return null;
    const corpo = (await risposta.json()) as { data: UtenteTwitch[] };
    return corpo.data[0] ?? null;
  }

  async diretta(broadcasterId: string): Promise<DirettaTwitch | null> {
    const risposta = await this.chiama<{ data: DirettaTwitch[] }>('GET', '/streams', {
      query: { user_id: broadcasterId },
    });
    return risposta.data[0] ?? null;
  }

  async infoCanale(broadcasterId: string): Promise<InfoCanale | null> {
    const risposta = await this.chiama<{ data: InfoCanale[] }>('GET', '/channels', {
      query: { broadcaster_id: broadcasterId },
    });
    return risposta.data[0] ?? null;
  }

  /** Da quanto una persona segue il canale. `null` se non lo segue. */
  async seguace(broadcasterId: string, utenteId: string, moderatoreId: string): Promise<Date | null> {
    const risposta = await this.chiama<{ data: { followed_at: string }[] }>(
      'GET',
      '/channels/followers',
      { comeUtente: moderatoreId, query: { broadcaster_id: broadcasterId, user_id: utenteId } },
    );
    const voce = risposta.data[0];
    return voce ? new Date(voce.followed_at) : null;
  }

  async moderatori(broadcasterId: string, moderatoreId: string): Promise<{ user_id: string; user_login: string }[]> {
    const risposta = await this.chiama<{ data: { user_id: string; user_login: string }[] }>(
      'GET',
      '/moderation/moderators',
      { comeUtente: moderatoreId, query: { broadcaster_id: broadcasterId, first: 100 } },
    );
    return risposta.data;
  }

  /* ── Chat ───────────────────────────────────────────────────────── */

  /**
   * Manda un messaggio.
   *
   * `reply_parent_message_id` esiste ed è tentante per rispondere a chi ha
   * scritto: non lo si usa per gli avvisi di moderazione, perché una risposta
   * evidenzia il messaggio originale a chi non l'aveva visto — che è
   * esattamente il contrario di quello che serve quando lo si sta
   * cancellando.
   */
  async manda(
    broadcasterId: string,
    mittenteId: string,
    messaggio: string,
    rispostaA?: string,
  ): Promise<void> {
    await this.chiama('POST', '/chat/messages', {
      comeUtente: mittenteId,
      corpo: {
        broadcaster_id: broadcasterId,
        sender_id: mittenteId,
        // Twitch taglia a 500 caratteri e restituisce un errore: si taglia
        // qui, dove si può mettere un segno che il testo continua.
        message: messaggio.length > 500 ? `${messaggio.slice(0, 497)}...` : messaggio,
        ...(rispostaA ? { reply_parent_message_id: rispostaA } : {}),
      },
    });
  }

  /** Annuncio: il messaggio evidenziato. Per le cose che devono essere viste. */
  async annuncia(
    broadcasterId: string,
    moderatoreId: string,
    messaggio: string,
    colore: 'blue' | 'green' | 'orange' | 'purple' | 'primary' = 'orange',
  ): Promise<void> {
    await this.chiama('POST', '/chat/announcements', {
      comeUtente: moderatoreId,
      query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId },
      corpo: { message: messaggio.slice(0, 500), color: colore },
    });
  }

  /* ── Moderazione ────────────────────────────────────────────────── */

  /** Elimina un messaggio. Senza `messaggioId` svuota tutta la chat. */
  async elimina(broadcasterId: string, moderatoreId: string, messaggioId?: string): Promise<void> {
    await this.chiama('DELETE', '/moderation/chat', {
      comeUtente: moderatoreId,
      query: {
        broadcaster_id: broadcasterId,
        moderator_id: moderatoreId,
        message_id: messaggioId,
      },
    });
  }

  /**
   * Silenzia o bandisce.
   *
   * Sono lo stesso endpoint: con `durataSec` è un timeout, senza è un ban
   * permanente. Vale la pena saperlo perché è il punto in cui un `undefined`
   * di troppo trasforma un silenzio di dieci minuti in un bando definitivo.
   */
  async sanziona(
    broadcasterId: string,
    moderatoreId: string,
    utenteId: string,
    motivo: string,
    durataSec?: number,
  ): Promise<void> {
    await this.chiama('POST', '/moderation/bans', {
      comeUtente: moderatoreId,
      query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId },
      corpo: {
        data: {
          user_id: utenteId,
          reason: motivo.slice(0, 500),
          ...(durataSec && durataSec > 0 ? { duration: Math.min(durataSec, 1_209_600) } : {}),
        },
      },
    });
  }

  async revocaSanzione(
    broadcasterId: string,
    moderatoreId: string,
    utenteId: string,
  ): Promise<void> {
    await this.chiama('DELETE', '/moderation/bans', {
      comeUtente: moderatoreId,
      query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId, user_id: utenteId },
    });
  }

  /**
   * Impostazioni della chat: rallentamento, solo seguaci, solo abbonati.
   *
   * Sono le leve dell'anti-raid, e agiscono su tutti insieme invece che su
   * una persona alla volta. Contro un'ondata di duecento account creati
   * apposta è l'unica cosa che funziona: bandirli uno per uno finisce il
   * limite di frequenza molto prima che finiscano loro.
   */
  async impostazioniChat(
    broadcasterId: string,
    moderatoreId: string,
    impostazioni: {
      slow_mode?: boolean;
      slow_mode_wait_time?: number;
      follower_mode?: boolean;
      follower_mode_duration?: number;
      subscriber_mode?: boolean;
      emote_mode?: boolean;
      unique_chat_mode?: boolean;
      non_moderator_chat_delay?: boolean;
      non_moderator_chat_delay_duration?: number;
    },
  ): Promise<void> {
    await this.chiama('PATCH', '/chat/settings', {
      comeUtente: moderatoreId,
      query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId },
      corpo: impostazioni,
    });
  }

  async leggiImpostazioniChat(
    broadcasterId: string,
    moderatoreId: string,
  ): Promise<Record<string, unknown> | null> {
    const risposta = await this.chiama<{ data: Record<string, unknown>[] }>(
      'GET',
      '/chat/settings',
      {
        comeUtente: moderatoreId,
        query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId },
      },
    );
    return risposta.data[0] ?? null;
  }

  /** Modalità scudo: applica le impostazioni d'emergenza scelte dallo streamer. */
  async scudo(broadcasterId: string, moderatoreId: string, attivo: boolean): Promise<void> {
    await this.chiama('PUT', '/moderation/shield_mode', {
      comeUtente: moderatoreId,
      query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId },
      corpo: { is_active: attivo },
    });
  }

  async scudoAttivo(broadcasterId: string, moderatoreId: string): Promise<boolean> {
    const risposta = await this.chiama<{ data: { is_active: boolean }[] }>(
      'GET',
      '/moderation/shield_mode',
      {
        comeUtente: moderatoreId,
        query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId },
      },
    );
    return risposta.data[0]?.is_active ?? false;
  }

  /* ── Termini bloccati di AutoMod ────────────────────────────────── */

  async terminiBloccati(
    broadcasterId: string,
    moderatoreId: string,
  ): Promise<{ id: string; text: string }[]> {
    const risposta = await this.chiama<{ data: { id: string; text: string }[] }>(
      'GET',
      '/moderation/blocked_terms',
      {
        comeUtente: moderatoreId,
        query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId, first: 100 },
      },
    );
    return risposta.data;
  }

  async aggiungiTermine(
    broadcasterId: string,
    moderatoreId: string,
    testo: string,
  ): Promise<{ id: string; text: string } | null> {
    const risposta = await this.chiama<{ data: { id: string; text: string }[] }>(
      'POST',
      '/moderation/blocked_terms',
      {
        comeUtente: moderatoreId,
        query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId },
        // Twitch rifiuta oltre 500 caratteri e i termini sotto i due.
        corpo: { text: testo.slice(0, 500) },
      },
    );
    return risposta.data[0] ?? null;
  }

  async rimuoviTermine(broadcasterId: string, moderatoreId: string, id: string): Promise<void> {
    await this.chiama('DELETE', '/moderation/blocked_terms', {
      comeUtente: moderatoreId,
      query: { broadcaster_id: broadcasterId, moderator_id: moderatoreId, id },
    });
  }

  /* ── EventSub ───────────────────────────────────────────────────── */

  /**
   * Registra una sottoscrizione su una sessione WebSocket.
   *
   * Le sottoscrizioni della chat vogliono il token **utente**, non quello
   * dell'applicazione — è una delle poche eccezioni, e Twitch risponde 401
   * senza dire quale delle due credenziali si aspettava.
   */
  async sottoscrivi(
    tipo: string,
    versione: string,
    condizione: Record<string, string>,
    sessionId: string,
    comeUtente?: string,
  ): Promise<{ id: string }> {
    const risposta = await this.chiama<{ data: { id: string }[] }>(
      'POST',
      '/eventsub/subscriptions',
      {
        ...(comeUtente ? { comeUtente } : {}),
        corpo: {
          type: tipo,
          version: versione,
          condition: condizione,
          transport: { method: 'websocket', session_id: sessionId },
        },
      },
    );
    const creata = risposta.data[0];
    if (!creata) throw new ErroreHelix(500, '/eventsub/subscriptions', 'nessuna sottoscrizione');
    return creata;
  }

  async cancellaSottoscrizione(id: string): Promise<void> {
    await this.chiama('DELETE', '/eventsub/subscriptions', { query: { id } });
  }

  async sottoscrizioni(): Promise<{ id: string; type: string; status: string }[]> {
    const risposta = await this.chiama<{
      data: { id: string; type: string; status: string }[];
    }>('GET', '/eventsub/subscriptions');
    return risposta.data;
  }
}

/* ── Tipi ─────────────────────────────────────────────────────────────── */

export interface UtenteTwitch {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  created_at: string;
  broadcaster_type: string;
}

export interface DirettaTwitch {
  id: string;
  user_id: string;
  user_login: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
}

export interface InfoCanale {
  broadcaster_id: string;
  broadcaster_login: string;
  game_name: string;
  title: string;
}

/* ── OAuth per lo streamer ────────────────────────────────────────────── */

/**
 * Permessi richiesti allo streamer.
 *
 * Il principio è: solo quelli che servono a un'azione che il bot compie
 * davvero. Ogni permesso in più è una riga in più nella schermata di
 * autorizzazione, e una schermata di autorizzazione lunga è una schermata che
 * si chiude senza autorizzare.
 *
 * `channel:moderate` non c'è di proposito: è il permesso vecchio, ampio, e
 * quelli sotto lo sostituiscono in modo più stretto.
 */
export const AMBITI_CANALE = [
  // Leggere la chat via EventSub.
  'user:read:chat',
  // Scrivere in chat come il bot.
  'user:write:chat',
  'channel:bot',
  // Cancellare messaggi.
  'moderator:manage:chat_messages',
  // Silenziare e bandire.
  'moderator:manage:banned_users',
  // Rallentare la chat, solo seguaci, solo abbonati: le leve anti-raid.
  'moderator:manage:chat_settings',
  // Modalità scudo.
  'moderator:manage:shield_mode',
  // Sincronizzare le parole vietate nei termini bloccati di Twitch.
  'moderator:manage:blocked_terms',
  // Sapere chi sono i moderatori, per esentarli.
  'moderation:read',
  // Da quanto una persona segue: serve a `!seguito` e alle regole sui nuovi.
  'moderator:read:followers',
  // Annunci evidenziati.
  'moderator:manage:announcements',
] as const;

/** L'indirizzo a cui mandare lo streamer per autorizzare. */
export function urlAutorizzazione(opzioni: {
  clientId: string;
  redirectUri: string;
  stato: string;
  ambiti?: readonly string[];
  /** Costringe la schermata di conferma anche a chi ha già autorizzato. */
  forzaConferma?: boolean;
}): string {
  const url = new URL(`${OAUTH}/authorize`);
  url.searchParams.set('client_id', opzioni.clientId);
  url.searchParams.set('redirect_uri', opzioni.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (opzioni.ambiti ?? AMBITI_CANALE).join(' '));
  url.searchParams.set('state', opzioni.stato);
  if (opzioni.forzaConferma) url.searchParams.set('force_verify', 'true');
  return url.toString();
}

/** Scambia il codice ricevuto dal redirect con i token. */
export async function scambiaCodice(opzioni: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codice: string;
}): Promise<{ accessToken: string; refreshToken: string; scopes: string[]; expiresIn: number }> {
  const risposta = await fetch(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opzioni.clientId,
      client_secret: opzioni.clientSecret,
      code: opzioni.codice,
      grant_type: 'authorization_code',
      redirect_uri: opzioni.redirectUri,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!risposta.ok) {
    throw new ErroreHelix(risposta.status, '/oauth2/token', await risposta.text());
  }

  const corpo = (await risposta.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string[];
    expires_in: number;
  };

  return {
    accessToken: corpo.access_token,
    refreshToken: corpo.refresh_token,
    scopes: corpo.scope ?? [],
    expiresIn: corpo.expires_in,
  };
}

/** Revoca un token: si chiama quando uno streamer stacca il bot. */
export async function revoca(clientId: string, token: string): Promise<void> {
  await fetch(`${OAUTH}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
}
