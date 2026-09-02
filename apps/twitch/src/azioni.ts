/* ═══════════════════════════════════════════════════════════════════════
   ESECUZIONE

   Dove il verdetto diventa una chiamata a Twitch. Sta separato dal motore per
   una ragione pratica: qui dentro c'è tutto quello che può fallire — rete,
   permessi, limiti di frequenza — e tenerlo fuori dalla decisione significa
   che la decisione si prova senza niente di tutto questo.

   Due regole valgono per ogni azione:

   1. **In modalità prova non si tocca niente.** Si registra cosa si sarebbe
      fatto e si va avanti. È il controllo che permette di accendere un
      livello alto su un canale vero senza rischiare di silenziare gli
      spettatori affezionati durante una diretta.

   2. **Un errore su una persona non ferma le altre.** Un timeout che fallisce
      perché il bersaglio è nel frattempo diventato moderatore non deve far
      cadere il messaggio successivo. Si registra e si prosegue.
   ═══════════════════════════════════════════════════════════════════════ */

import { ErroreHelix, type AzioneTwitch, type Helix, type Verdetto } from './deps.js';
import type { Archivio } from './archivio.js';
import { logger } from './logger.js';
import type { Canale } from './stato.js';

export interface Esecutore {
  helix: Helix;
  archivio: Archivio;
  /** Id dell'account Twitch da cui il bot parla. */
  botId: string;
  /** Il bot è moderatore di questo canale: cambia il limite dei messaggi. */
  botModeratore: (canaleId: string) => boolean;
}

/**
 * Chi firma l'azione di moderazione.
 *
 * Twitch vuole l'id di un moderatore *e* il token di quella stessa persona.
 * Il bot ha il token dello streamer, quindi firma come lo streamer — che è
 * moderatore del proprio canale per definizione. Usare il bot richiederebbe
 * che sia stato nominato moderatore, e non lo è finché lo streamer non lo fa.
 */
function firmatario(canale: Canale): string {
  return canale.id;
}

/** Vero se ci sono le credenziali per agire. */
export function puoAgire(canale: Canale): boolean {
  return canale.token !== null && canale.token.accessToken.length > 0;
}

/* ── Applicazione di un verdetto ──────────────────────────────────────── */

export async function applica(
  esecutore: Esecutore,
  canale: Canale,
  verdetto: Verdetto,
  bersaglio: { utenteId: string; utenteLogin: string; messaggioId: string; testo: string },
): Promise<void> {
  if (verdetto.azione === 'NIENTE') return;

  const comune = {
    canale,
    modulo: verdetto.rilevazioni[0]?.modulo,
    gravita: verdetto.punteggio,
    utenteId: bersaglio.utenteId,
    utenteLogin: bersaglio.utenteLogin,
    messaggioId: bersaglio.messaggioId,
    testo: bersaglio.testo,
    motivo: verdetto.motivo,
    azione: verdetto.azione,
    durataSec: verdetto.durataSec,
    simulato: verdetto.simulato,
    payload: { rilevazioni: verdetto.rilevazioni },
  };

  // Prova: si registra e basta. È l'unico ramo che non chiama Twitch, ed è
  // quello che rende sicuro accendere un livello nuovo su un canale vero.
  if (verdetto.simulato) {
    esecutore.archivio.registra({ ...comune, tipo: 'PROVA' });
    return;
  }

  if (!puoAgire(canale)) {
    esecutore.archivio.registra({
      ...comune,
      tipo: 'NON_APPLICATA',
      motivo: `${verdetto.motivo} — nessun token: il canale va riautorizzato`,
    });
    return;
  }

  const moderatore = firmatario(canale);

  try {
    switch (verdetto.azione) {
      case 'SOLO_REGISTRO':
        break;

      case 'AVVISA':
        // L'avviso è già partito verso Discord da `archivio.registra`: qui non
        // c'è altro da fare, e scrivere anche in chat richiamerebbe
        // l'attenzione proprio su ciò che si voleva lasciar passare.
        break;

      case 'ELIMINA_MESSAGGIO':
        await esecutore.helix.elimina(canale.id, moderatore, bersaglio.messaggioId);
        break;

      case 'AVVERTI':
        await esecutore.helix.elimina(canale.id, moderatore, bersaglio.messaggioId);
        await manda(
          esecutore,
          canale,
          `@${bersaglio.utenteLogin} messaggio rimosso: ${verdetto.motivo}`,
        );
        break;

      case 'SILENZIA':
        if (verdetto.eliminaMessaggio) {
          await esecutore.helix
            .elimina(canale.id, moderatore, bersaglio.messaggioId)
            .catch(() => undefined);
        }
        await esecutore.helix.sanziona(
          canale.id,
          moderatore,
          bersaglio.utenteId,
          `ANGEL: ${verdetto.motivo}`,
          verdetto.durataSec > 0 ? verdetto.durataSec : 600,
        );
        break;

      case 'BANDISCI':
        // Il bando cancella da solo tutti i messaggi recenti della persona:
        // non serve eliminare prima, e farlo sprecherebbe una chiamata sul
        // limite di frequenza proprio durante un'ondata.
        await esecutore.helix.sanziona(
          canale.id,
          moderatore,
          bersaglio.utenteId,
          `ANGEL: ${verdetto.motivo}`,
        );
        break;

      case 'SCUDO':
        await attivaScudo(esecutore, canale, verdetto.motivo);
        break;
    }

    esecutore.archivio.registra({ ...comune, tipo: tipoEvento(verdetto.azione) });
  } catch (errore) {
    const dettaglio =
      errore instanceof ErroreHelix ? `${errore.stato}: ${errore.corpo.slice(0, 120)}` : String(errore);

    logger.warn(
      { err: errore, canale: canale.login, azione: verdetto.azione },
      'azione non riuscita',
    );

    esecutore.archivio.registra({
      ...comune,
      tipo: 'NON_APPLICATA',
      motivo: `${verdetto.motivo} — ${dettaglio}`,
    });
  }
}

function tipoEvento(azione: AzioneTwitch): string {
  switch (azione) {
    case 'ELIMINA_MESSAGGIO':
    case 'AVVERTI':
      return 'MESSAGGIO_ELIMINATO';
    case 'SILENZIA':
      return 'SILENZIATO';
    case 'BANDISCI':
      return 'BANDITO';
    case 'SCUDO':
      return 'SCUDO_ATTIVO';
    case 'AVVISA':
      return 'AVVISO';
    default:
      return 'REGISTRATO';
  }
}

/* ── Parlare in chat ──────────────────────────────────────────────────── */

/**
 * Manda un messaggio, rispettando il limite di frequenza.
 *
 * Il limite lo conosce `Helix` attraverso il proprio secchiello, ma quello è
 * per le chiamate all'API: i messaggi hanno un limite proprio, per canale, e
 * dipende dal fatto che il bot sia moderatore. Il secchiello per canale sta
 * nel motore, che è l'unico posto in cui si sa a quale canale appartiene.
 */
export async function manda(
  esecutore: Esecutore,
  canale: Canale,
  testo: string,
): Promise<boolean> {
  if (!puoAgire(canale)) return false;

  try {
    await esecutore.helix.manda(canale.id, esecutore.botId, testo);
    return true;
  } catch (errore) {
    logger.warn({ err: errore, canale: canale.login }, 'messaggio non inviato');
    return false;
  }
}

/* ── Risposta a un'ondata ─────────────────────────────────────────────── */

/**
 * Chiude la chat quanto serve, e per il tempo che serve.
 *
 * L'ordine delle leve non è casuale: prima la modalità scudo, che applica le
 * impostazioni che lo streamer ha già scelto per sé e quindi è quella che
 * rispetta di più la sua volontà; poi solo-seguaci, che ferma gli account
 * creati cinque minuti prima; per ultimo il rallentamento, che dà fastidio a
 * tutti e serve solo se le prime due non bastano.
 *
 * Ogni restrizione ha una scadenza. Una chat rimasta chiusa perché nessuno si
 * è ricordato di riaprirla fa più danno dell'ondata: l'ondata dura minuti, la
 * chat chiusa dura finché qualcuno se ne accorge.
 */
export async function attivaScudo(
  esecutore: Esecutore,
  canale: Canale,
  motivo: string,
): Promise<void> {
  const modulo = canale.config.sicurezza.antiRaid;
  if (!puoAgire(canale)) return;

  const moderatore = firmatario(canale);
  const applicate: string[] = [];

  if (modulo.attivaScudo) {
    await esecutore.helix
      .scudo(canale.id, moderatore, true)
      .then(() => applicate.push('modalità scudo'))
      .catch((errore: unknown) =>
        logger.warn({ err: errore, canale: canale.login }, 'scudo non attivato'),
      );
  }

  const impostazioni: Record<string, unknown> = {};
  if (modulo.soloSeguaciDaMinuti > 0) {
    impostazioni.follower_mode = true;
    impostazioni.follower_mode_duration = modulo.soloSeguaciDaMinuti;
    applicate.push(`solo chi segue da ${modulo.soloSeguaciDaMinuti} minuti`);
  }
  if (modulo.rallentaSec > 0) {
    impostazioni.slow_mode = true;
    impostazioni.slow_mode_wait_time = modulo.rallentaSec;
    applicate.push(`un messaggio ogni ${modulo.rallentaSec}s`);
  }

  if (Object.keys(impostazioni).length > 0) {
    await esecutore.helix
      .impostazioniChat(canale.id, moderatore, impostazioni)
      .catch((errore: unknown) =>
        logger.warn({ err: errore, canale: canale.login }, 'impostazioni chat non applicate'),
      );
  }

  canale.scudoFinoA = Date.now() + modulo.durataSec * 1000;

  esecutore.archivio.registra({
    canale,
    tipo: 'SCUDO_ATTIVO',
    modulo: 'antiRaid',
    gravita: 80,
    motivo,
    azione: 'SCUDO',
    durataSec: modulo.durataSec,
    payload: { applicate },
  });

  logger.warn(
    { canale: canale.login, motivo, applicate },
    'ondata rilevata: restrizioni attivate',
  );
}

/** Toglie le restrizioni. Chiamato dal ciclo del motore alla scadenza. */
export async function togliScudo(esecutore: Esecutore, canale: Canale): Promise<void> {
  canale.scudoFinoA = null;
  if (!puoAgire(canale)) return;

  const moderatore = firmatario(canale);

  await esecutore.helix.scudo(canale.id, moderatore, false).catch(() => undefined);
  await esecutore.helix
    .impostazioniChat(canale.id, moderatore, { follower_mode: false, slow_mode: false })
    .catch(() => undefined);

  esecutore.archivio.registra({
    canale,
    tipo: 'SCUDO_TOLTO',
    modulo: 'antiRaid',
    gravita: 10,
    motivo: 'scadenza delle restrizioni',
  });

  logger.info({ canale: canale.login }, 'restrizioni tolte');
}

/* ── Sincronizzazione dei termini bloccati ────────────────────────────── */

/**
 * Copia le parole più gravi nei «termini bloccati» nativi di Twitch.
 *
 * Il guadagno è di tempo, ed è tutto: AutoMod di Twitch blocca il messaggio
 * *prima* che compaia, mentre il bot può solo cancellarlo dopo averlo letto.
 * In una chat veloce quella differenza sono decine di persone che lo hanno
 * già visto.
 *
 * Twitch accetta cento termini per canale. Ce ne stanno solo i più gravi, e
 * si toccano solo quelli aggiunti da qui: i termini messi a mano dallo
 * streamer restano dove sono, perché cancellare il lavoro di qualcun altro
 * per fare spazio al proprio è il modo di far togliere il bot.
 */
const MARCATORE = ' ';

export async function sincronizzaTermini(
  esecutore: Esecutore,
  canale: Canale,
  parole: string[],
): Promise<{ aggiunti: number; rimossi: number }> {
  if (!puoAgire(canale)) return { aggiunti: 0, rimossi: 0 };

  const moderatore = firmatario(canale);
  const esistenti = await esecutore.helix.terminiBloccati(canale.id, moderatore);

  // I nostri si riconoscono dal suffisso invisibile: uno spazio a larghezza
  // zero. Twitch conserva il testo come lo si manda, e un marcatore che non
  // si vede non sporca l'elenco che lo streamer legge nel proprio pannello.
  const nostri = esistenti.filter((t) => t.text.endsWith(MARCATORE));
  const vogliamo = new Set(parole.slice(0, 90).map((p) => p + MARCATORE));

  let rimossi = 0;
  for (const termine of nostri) {
    if (vogliamo.has(termine.text)) {
      vogliamo.delete(termine.text);
      continue;
    }
    await esecutore.helix
      .rimuoviTermine(canale.id, moderatore, termine.id)
      .then(() => (rimossi += 1))
      .catch(() => undefined);
  }

  let aggiunti = 0;
  for (const testo of vogliamo) {
    await esecutore.helix
      .aggiungiTermine(canale.id, moderatore, testo)
      .then(() => (aggiunti += 1))
      .catch(() => undefined);
  }

  return { aggiunti, rimossi };
}
