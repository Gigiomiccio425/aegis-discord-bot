/* ═══════════════════════════════════════════════════════════════════════
   REGISTRO DEGLI EVENTI

   Tre destinazioni, e servono a tre cose diverse:

   • **Il file su disco** è quello che sopravvive a tutto. Un NDJSON al giorno
     per canale sotto `STORAGE_DIR/twitch/<login>/`, che si legge con `grep`
     senza il bot, senza il database e senza il pannello. Sta dentro
     `STORAGE_DIR`, quindi finisce già dentro `archivio.tar.gz` della copia
     notturna senza che si debba fare niente.

   • **Il database** serve al pannello: filtri, ricerche, statistiche.

   • **Discord** serve a essere avvisati mentre succede, non dopo.

   Il file si scrive **per primo e sempre**, anche quando il database non
   risponde. È l'ordine che rende vera la modalità autonoma: durante un
   guasto gli eventi continuano a essere registrati, e quando il database
   torna li si riversa dentro.

   ── Sulla scrittura in blocco ──────────────────────────────────────────

   Una `INSERT` per messaggio è la cosa che uccide questo tipo di bot. Una
   chat viva fa qualche centinaio di righe al minuto; dieci canali fanno
   qualche migliaio. Con una scrittura per riga il database passa la giornata
   a fare `COMMIT` e il resto del bot aspetta.

   Qui gli eventi si accumulano in memoria e partono in gruppo ogni due
   secondi, o prima se sono già cento. La perdita massima in caso di crollo è
   due secondi di registro — e quei due secondi sono comunque nel file su
   disco, che si scrive subito.
   ═══════════════════════════════════════════════════════════════════════ */

import { promises as fs, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { getPrisma } from '@angel/db';
import { RedisKeys } from '@angel/shared';
import { logger } from './logger.js';
import { getRedis } from './redis.js';
import type { Canale } from './stato.js';

/** Eventi accumulati prima di scrivere comunque. */
const LOTTO = 100;
/** Ogni quanto si svuota la coda, in millisecondi. */
const INTERVALLO_MS = 2_000;

export interface Evento {
  canale: Canale;
  tipo: string;
  modulo?: string;
  gravita?: number;
  utenteId?: string;
  utenteLogin?: string;
  messaggioId?: string;
  testo?: string;
  azione?: string;
  durataSec?: number;
  motivo?: string;
  simulato?: boolean;
  payload?: Record<string, unknown>;
}

interface InCoda {
  channelId: string;
  createdAt: Date;
  type: string;
  module: string | null;
  severity: number;
  actorId: string | null;
  actorLogin: string | null;
  messageId: string | null;
  text: string | null;
  textExpiresAt: Date | null;
  action: string | null;
  durationSec: number | null;
  reason: string | null;
  simulated: boolean;
  payload: object;
}

export class Archivio {
  private coda: InCoda[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Un flusso aperto per canale e per giorno: riaprire il file a ogni riga costa più della scrittura. */
  private readonly flussi = new Map<string, { giorno: string; flusso: WriteStream }>();
  /** Vero quando il database ha appena rifiutato: si smette di riprovare per un po'. */
  private databaseGiu = false;

  registra(evento: Evento): void {
    const adesso = new Date();
    const conservazione = evento.canale.config.conservazione;
    const registro = evento.canale.config.registro;

    // Il file per primo: è la destinazione che non fallisce.
    if (registro.archivioSuDisco) void this.suDisco(evento, adesso);

    const testo = registro.conservaTesto ? (evento.testo ?? null) : null;

    this.coda.push({
      channelId: evento.canale.id,
      createdAt: adesso,
      type: evento.tipo,
      module: evento.modulo ?? null,
      severity: evento.gravita ?? 0,
      actorId: evento.utenteId ?? null,
      actorLogin: evento.utenteLogin ?? null,
      messageId: evento.messaggioId ?? null,
      text: testo,
      // La scadenza del testo si calcola alla scrittura e non alla lettura:
      // un lavoro periodico che deve dedurre la scadenza dalla configurazione
      // del canale sbaglia ogni volta che la configurazione cambia.
      textExpiresAt: testo
        ? new Date(adesso.getTime() + conservazione.testoGiorni * 86_400_000)
        : null,
      action: evento.azione ?? null,
      durationSec: evento.durataSec ?? null,
      reason: evento.motivo ?? null,
      simulated: evento.simulato ?? false,
      payload: evento.payload ?? {},
    });

    if ((evento.gravita ?? 0) >= registro.gravitaMinimaDiscord && registro.suDiscord) {
      void this.suDiscord(evento);
    }

    if (this.coda.length >= LOTTO) void this.svuota();
    else this.programma();
  }

  /* ── Disco ──────────────────────────────────────────────────────── */

  private async suDisco(evento: Evento, quando: Date): Promise<void> {
    const giorno = quando.toISOString().slice(0, 10);
    const chiave = evento.canale.id;

    try {
      let voce = this.flussi.get(chiave);

      if (!voce || voce.giorno !== giorno) {
        voce?.flusso.end();
        const cartella = path.join(
          process.env.STORAGE_DIR ?? './storage',
          'twitch',
          evento.canale.login,
        );
        await fs.mkdir(cartella, { recursive: true });
        voce = {
          giorno,
          flusso: createWriteStream(path.join(cartella, `${giorno}.ndjson`), { flags: 'a' }),
        };
        this.flussi.set(chiave, voce);
      }

      voce.flusso.write(
        `${JSON.stringify({
          quando: quando.toISOString(),
          tipo: evento.tipo,
          modulo: evento.modulo,
          gravita: evento.gravita ?? 0,
          utente: evento.utenteLogin,
          utenteId: evento.utenteId,
          azione: evento.azione,
          durataSec: evento.durataSec,
          motivo: evento.motivo,
          simulato: evento.simulato ?? false,
          testo: evento.canale.config.registro.conservaTesto ? evento.testo : undefined,
        })}\n`,
      );
    } catch (errore) {
      logger.warn({ err: errore, canale: evento.canale.login }, 'scrittura sul file non riuscita');
    }
  }

  /* ── Database ───────────────────────────────────────────────────── */

  private programma(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.svuota(), INTERVALLO_MS);
    this.timer.unref?.();
  }

  async svuota(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.coda.length === 0) return;

    const lotto = this.coda;
    this.coda = [];

    try {
      await getPrisma().twitchEvent.createMany({ data: lotto });
      if (this.databaseGiu) {
        logger.info('database tornato disponibile: registro di nuovo completo');
        this.databaseGiu = false;
      }
    } catch (errore) {
      // Non si rimette in coda: gli eventi sono già nel file del giorno, e
      // riaccodarli con il database giù farebbe crescere la memoria finché
      // il processo muore — sostituendo un guasto sopportabile con uno che
      // non lo è.
      if (!this.databaseGiu) {
        this.databaseGiu = true;
        logger.error(
          { err: errore, persi: lotto.length },
          'registro non scritto sul database: resta nei file NDJSON del giorno',
        );
      }
    }
  }

  /* ── Discord ────────────────────────────────────────────────────── */

  /**
   * Manda l'avviso a Discord.
   *
   * Non si parla con Discord da qui: si pubblica su Redis e il bot Discord —
   * l'unico processo collegato al gateway — lo esegue. Due processi collegati
   * con lo stesso token riceverebbero gli stessi eventi e agirebbero due
   * volte, ed è lo stesso motivo per cui il nodo di emergenza si spegne da
   * solo quando il principale risponde.
   */
  private async suDiscord(evento: Evento): Promise<void> {
    const registro = evento.canale.config.registro;
    const guildId = registro.guildId || evento.canale.guildId;
    if (!guildId) return;

    const canaleId =
      (evento.gravita ?? 0) >= 50
        ? registro.canaleAvvisiId || registro.canaleRegistroId
        : registro.canaleRegistroId || registro.canaleAvvisiId;
    if (!canaleId) return;

    try {
      await getRedis().publish(
        RedisKeys.commandChannel,
        JSON.stringify({
          action: 'twitch.log',
          guildId,
          channelId: canaleId,
          canale: evento.canale.login,
          tipo: evento.tipo,
          modulo: evento.modulo ?? null,
          gravita: evento.gravita ?? 0,
          utente: evento.utenteLogin ?? null,
          azione: evento.azione ?? null,
          durataSec: evento.durataSec ?? null,
          motivo: evento.motivo ?? null,
          simulato: evento.simulato ?? false,
          testo: registro.conservaTesto ? (evento.testo ?? null) : null,
        }),
      );
    } catch (errore) {
      logger.debug({ err: errore }, 'avviso Discord non pubblicato');
    }
  }

  /* ── Chiusura ───────────────────────────────────────────────────── */

  async chiudi(): Promise<void> {
    await this.svuota();
    for (const { flusso } of this.flussi.values()) {
      await new Promise<void>((risolvi) => flusso.end(risolvi));
    }
    this.flussi.clear();
  }
}

/* ── Riversamento dei file nel database ───────────────────────────────── */

/**
 * Rimette nel database gli eventi rimasti solo su disco.
 *
 * Serve dopo un guasto: il registro del pannello avrebbe un buco esattamente
 * nelle ore in cui è successo qualcosa, che sono le sole in cui a qualcuno
 * verrà in mente di guardarlo.
 *
 * Non è automatico. È volutamente un comando: rileggere file di giorni
 * significa scrivere decine di migliaia di righe, e farlo da solo all'avvio
 * dopo un guasto vorrebbe dire caricare il database nel momento in cui si sta
 * appena riprendendo.
 */
export async function riversaFile(
  canaleId: string,
  login: string,
  giorno: string,
): Promise<{ lette: number; inserite: number }> {
  const file = path.join(
    process.env.STORAGE_DIR ?? './storage',
    'twitch',
    login,
    `${giorno}.ndjson`,
  );

  const testo = await fs.readFile(file, 'utf8').catch(() => null);
  if (!testo) return { lette: 0, inserite: 0 };

  const righe = testo.split('\n').filter((riga) => riga.trim());
  const dati: InCoda[] = [];

  for (const riga of righe) {
    try {
      const voce = JSON.parse(riga) as Record<string, unknown>;
      dati.push({
        channelId: canaleId,
        createdAt: new Date(String(voce.quando)),
        type: String(voce.tipo ?? 'SCONOSCIUTO'),
        module: voce.modulo ? String(voce.modulo) : null,
        severity: Number(voce.gravita ?? 0),
        actorId: voce.utenteId ? String(voce.utenteId) : null,
        actorLogin: voce.utente ? String(voce.utente) : null,
        messageId: null,
        text: voce.testo ? String(voce.testo) : null,
        textExpiresAt: null,
        action: voce.azione ? String(voce.azione) : null,
        durationSec: voce.durataSec ? Number(voce.durataSec) : null,
        reason: voce.motivo ? String(voce.motivo) : null,
        simulated: Boolean(voce.simulato),
        payload: {},
      });
    } catch {
      /* riga illeggibile: si salta, il resto del file vale comunque */
    }
  }

  if (dati.length === 0) return { lette: righe.length, inserite: 0 };

  const esito = await getPrisma().twitchEvent.createMany({ data: dati });
  return { lette: righe.length, inserite: esito.count };
}
