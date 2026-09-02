/**
 * Client HTTP del pannello Twitch.
 *
 * Il cookie di sessione è httpOnly e same-origin: non c'è nessun token da
 * gestire in JavaScript, il che elimina di netto la categoria di problemi
 * legata ai token conservati in `localStorage` — che su un pannello esposto a
 * Internet, a differenza di quello dietro Tailscale, non è un'ipotesi teorica.
 */

import type { TwitchChannelConfig, LivelloSicurezza } from '@angel/shared';

export class ErroreApi extends Error {
  constructor(
    message: string,
    readonly stato: number,
    readonly dettagli?: { campo: string; problema: string }[],
  ) {
    super(message);
  }
}

async function richiesta<T>(percorso: string, init?: RequestInit): Promise<T> {
  const risposta = await fetch(percorso, {
    ...init,
    credentials: 'same-origin',
    // Il `content-type: application/json` non è solo cortesia: un modulo
    // costruito su un altro sito non può mandarlo senza preflight, quindi
    // richiederlo su ogni scrittura chiude il CSRF senza un token in più da
    // gestire.
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  const testo = await risposta.text();
  const dati = testo ? (JSON.parse(testo) as unknown) : null;

  if (!risposta.ok) {
    const corpo = dati as { error?: string; dettagli?: { campo: string; problema: string }[] } | null;
    throw new ErroreApi(
      corpo?.error ?? `Errore ${risposta.status}`,
      risposta.status,
      corpo?.dettagli,
    );
  }

  return dati as T;
}

export const api = {
  get: <T>(percorso: string) => richiesta<T>(percorso),
  post: <T>(percorso: string, corpo?: unknown) =>
    richiesta<T>(percorso, {
      method: 'POST',
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    }),
  put: <T>(percorso: string, corpo: unknown) =>
    richiesta<T>(percorso, { method: 'PUT', body: JSON.stringify(corpo) }),
  delete: <T>(percorso: string) => richiesta<T>(percorso, { method: 'DELETE' }),
};

/* ── Forme delle risposte ─────────────────────────────────────────────── */

export interface CanaleElenco {
  id: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  enabled: boolean;
  connected: boolean;
  guildId: string | null;
  ruolo: 'PROPRIETARIO' | 'MODERATORE' | 'LETTURA';
  daRiautorizzare: boolean;
}

export interface Io {
  autenticato: boolean;
  utente?: { id: string; login: string; nome: string; avatar: string | null };
  canali: CanaleElenco[];
  livelli?: Record<LivelloSicurezza, string>;
}

export interface Canale {
  id: string;
  login: string;
  nome: string;
  avatar: string | null;
  guildId: string | null;
  ruolo: 'PROPRIETARIO' | 'MODERATORE' | 'LETTURA';
  daRiautorizzare: boolean;
  online: boolean;
  scudoFinoA: number | null;
  config: TwitchChannelConfig;
}

export interface Evento {
  id: string;
  createdAt: string;
  type: string;
  module: string | null;
  severity: number;
  actorLogin: string | null;
  text: string | null;
  action: string | null;
  durationSec: number | null;
  reason: string | null;
  simulated: boolean;
}

export interface Riassunto {
  da: string;
  moduli: { modulo: string | null; quanti: number }[];
  tipi: { tipo: string; quanti: number }[];
}
