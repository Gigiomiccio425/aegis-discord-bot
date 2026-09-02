/* ═══════════════════════════════════════════════════════════════════════
   MOTORE DI MODERAZIONE

   Prende un messaggio e dice cosa farne. Nient'altro: nessuna rete, nessun
   database, nessuna chiamata a Twitch. È una funzione pura, e lo è di
   proposito — le regole di moderazione sono la parte che si sbaglia più
   spesso e che si prova peggio, e qui si provano tutte con una stringa e un
   oggetto.

   Come decide, in tre righe: ogni modulo attivo guarda il messaggio e
   restituisce dei punti con il motivo; ogni modulo ha la propria scala che
   traduce i punti in un'azione; vince l'azione più severa fra quelle uscite.

   **La somma non attraversa i moduli**, ed è una scelta che vale la pena
   spiegare. Sommando tutto, un messaggio maiuscolo con dentro un link e una
   parolaccia arriverebbe a punteggio da bando pur essendo tre inezie. Ogni
   modulo giudica il proprio dominio, e l'azione finale è la più severa fra
   quelle che qualcuno ha davvero chiesto — non la conseguenza di un totale
   che nessuno ha voluto.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  DEFAULT_ALLOWLIST,
  DEFAULT_WORDLIST,
  capsRatio,
  nameSimilarity,
  normalize,
  zalgoRatio,
  type AzioneTwitch,
  type LivelloTwitch,
  type ScalaTwitch,
  type TwitchChannelConfig,
  type TwitchEsenzioni,
} from '@angel/shared';
import { extractUrls, detectImpersonation, containsCryptoAddress, isShortener } from '@angel/scanner';
import { normalizeForLanguage, scanLanguage, type LanguageCategory } from '@angel/scanner';
import type { MessaggioChat } from '../eventsub.js';
import { BOT_LEGITTIMI, DOMINI_SOSPETTI, LOGIN_NOTI, MARCHI, SEGNALI } from './segnali.js';

/* ── Tipi ─────────────────────────────────────────────────────────────── */

/** Quello che si sa di chi ha scritto, dentro questo canale e basta. */
export interface StatoSpettatore {
  messaggi: number;
  fiducia: number;
  fidato: boolean;
  /** Messaggi recenti, per riconoscere le ripetizioni. Dal più vecchio al più nuovo. */
  recenti: { testo: string; quando: number }[];
}

export interface ContestoMessaggio {
  messaggio: MessaggioChat;
  config: TwitchChannelConfig;
  spettatore: StatoSpettatore;
  streamerLogin: string;
  moderatoriLogin: string[];
  /** Dice se un host è già noto come malevolo. Viene dalle blocklist condivise. */
  hostMalevolo?: (host: string) => boolean;
  /** Adesso, in millisecondi. Iniettabile per rendere i test deterministici. */
  adesso?: number;
}

export interface Rilevazione {
  modulo: string;
  punteggio: number;
  motivo: string;
  dettagli?: Record<string, unknown>;
}

export interface Verdetto {
  /** Il punteggio più alto fra i moduli. Non la somma: vedi l'intestazione. */
  punteggio: number;
  rilevazioni: Rilevazione[];
  azione: AzioneTwitch;
  durataSec: number;
  motivo: string;
  /** Vero quando il messaggio va tolto anche se l'azione è più leggera. */
  eliminaMessaggio: boolean;
  /** Il canale è in modalità prova: niente è stato applicato davvero. */
  simulato: boolean;
}

/* ── Gerarchia delle azioni ───────────────────────────────────────────── */

const SEVERITA: Record<AzioneTwitch, number> = {
  NIENTE: 0,
  SOLO_REGISTRO: 1,
  AVVISA: 2,
  ELIMINA_MESSAGGIO: 3,
  AVVERTI: 4,
  SILENZIA: 5,
  BANDISCI: 6,
  // Lo scudo non nasce mai da un messaggio: è la risposta a un'ondata, e la
  // decide `valutaRaid`. Sta in fondo per completezza dell'ordinamento.
  SCUDO: 7,
};

/** Livelli di chi scrive, dal basso. Serve ai comandi e alle esenzioni. */
const LIVELLI: Record<LivelloTwitch, number> = {
  TUTTI: 0,
  ABBONATI: 1,
  VIP: 2,
  MODERATORI: 3,
  STREAMER: 4,
};

export function livelloDi(messaggio: MessaggioChat): LivelloTwitch {
  if (messaggio.streamer) return 'STREAMER';
  if (messaggio.moderatore) return 'MODERATORI';
  if (messaggio.vip) return 'VIP';
  if (messaggio.abbonato) return 'ABBONATI';
  return 'TUTTI';
}

export function almeno(messaggio: MessaggioChat, richiesto: LivelloTwitch): boolean {
  return LIVELLI[livelloDi(messaggio)] >= LIVELLI[richiesto];
}

/** Traduce un punteggio in azione secondo la scala di un modulo. */
export function scegliAzione(
  scala: ScalaTwitch,
  punteggio: number,
): { azione: AzioneTwitch; durataSec: number } {
  let scelta: { azione: AzioneTwitch; durataSec: number } = { azione: 'NIENTE', durataSec: 0 };
  for (const gradino of scala) {
    if (punteggio >= gradino.dalPunteggio && SEVERITA[gradino.azione] >= SEVERITA[scelta.azione]) {
      scelta = { azione: gradino.azione, durataSec: gradino.durataSec };
    }
  }
  return scelta;
}

function esente(messaggio: MessaggioChat, esenzioni: TwitchEsenzioni): boolean {
  if (messaggio.streamer) return true;
  if (esenzioni.moderatori && messaggio.moderatore) return true;
  if (esenzioni.vip && messaggio.vip) return true;
  if (esenzioni.abbonati && messaggio.abbonato) return true;
  return esenzioni.utenti.includes(messaggio.utenteLogin);
}

/* ── Moduli ───────────────────────────────────────────────────────────── */

const PESO_GRAVITA = { LIEVE: 15, MEDIA: 35, GRAVE: 70 } as const;
const CATEGORIE_TUTTE: Record<LanguageCategory, boolean> = {
  VOLGARITA: true,
  INSULTO: true,
  DISCRIMINAZIONE: true,
  MINACCIA: true,
  AUTOLESIONISMO: true,
  BESTEMMIA: true,
  SESSUALE: true,
};

/**
 * Linguaggio.
 *
 * Riusa lo stesso motore e la stessa lista del bot Discord — è il punto in cui
 * i due si toccano davvero. Una parola aggiunta dal pannello Discord viene
 * bloccata anche qui senza nessuna sincronizzazione da ricordare, perché non
 * ci sono due liste: ce n'è una.
 */
export function valutaLinguaggio(ctx: ContestoMessaggio): Rilevazione[] {
  const modulo = ctx.config.sicurezza.linguaggio;
  if (!modulo.attivo || esente(ctx.messaggio, modulo.esenzioni)) return [];

  const termini = [
    ...(modulo.listaCondivisa ? DEFAULT_WORDLIST : []),
    ...modulo.paroleAggiuntive.map((term) => ({
      term: term.toLowerCase(),
      severity: 'MEDIA' as const,
      category: 'INSULTO' as const,
    })),
  ];

  const esito = scanLanguage(ctx.messaggio.testo, {
    terms: termini,
    categories: CATEGORIE_TUTTE,
    allowlist: [...DEFAULT_ALLOWLIST, ...modulo.paroleAmmesse],
    weights: PESO_GRAVITA,
    // Su Twitch non esistono le menzioni: chi vuole colpire qualcuno scrive il
    // nome e basta, e non c'è modo di distinguerlo da una citazione. Il bonus
    // resta a zero invece di indovinare.
    targetedBonus: 0,
  });

  if (esito.matches.length === 0) return [];

  const ordine = { LIEVE: 0, MEDIA: 1, GRAVE: 2 };
  const minima = ordine[modulo.gravitaMinima];
  const rilevanti = esito.matches.filter((m) => ordine[m.severity] >= minima);
  if (rilevanti.length === 0) return [];

  return [
    {
      modulo: 'linguaggio',
      punteggio: Math.min(100, esito.score),
      motivo: `linguaggio non consentito (${esito.categories.join(', ').toLowerCase()})`,
      dettagli: { termini: rilevanti.map((m) => m.term).slice(0, 5) },
    },
  ];
}

/**
 * Link.
 *
 * L'ordine dei controlli è dal più certo al più incerto, e si ferma al primo
 * che decide: un dominio nella blocklist non ha bisogno di essere anche
 * valutato per somiglianza. Costa meno e produce un motivo comprensibile
 * invece di un elenco di sospetti.
 */
export function valutaLink(ctx: ContestoMessaggio): Rilevazione[] {
  const modulo = ctx.config.sicurezza.link;
  if (!modulo.attivo || esente(ctx.messaggio, modulo.esenzioni)) return [];

  const url = extractUrls(ctx.messaggio.testo);
  if (url.length === 0) return [];

  const rilevazioni: Rilevazione[] = [];
  const ammessi = modulo.dominiAmmessi.map((d) => d.replace(/^www\./, ''));

  for (const voce of url) {
    const host = voce.host.replace(/^www\./, '');

    // L'allowlist vince su tutto: è la voce dello streamer, e uno streamer che
    // non riesce a far passare il proprio Discord spegne il modulo intero.
    if (ammessi.some((d) => host === d || host.endsWith(`.${d}`))) continue;

    if (modulo.dominiVietati.some((d) => host === d || host.endsWith(`.${d}`))) {
      rilevazioni.push({
        modulo: 'link',
        punteggio: 80,
        motivo: `dominio vietato su questo canale (${host})`,
      });
      continue;
    }

    const noto = DOMINI_SOSPETTI.find((d) => host === d.dominio || host.endsWith(`.${d.dominio}`));
    if (noto) {
      rilevazioni.push({
        modulo: 'link',
        punteggio: noto.peso,
        motivo: `servizio di visualizzatori finti (${host})`,
      });
      continue;
    }

    if (modulo.usaBlocklistCondivise && ctx.hostMalevolo?.(host)) {
      rilevazioni.push({
        modulo: 'link',
        punteggio: 90,
        motivo: `dominio segnalato come malevolo (${host})`,
      });
      continue;
    }

    if (modulo.rilevaImitazioni) {
      const imitazione = detectImpersonation(
        host,
        MARCHI.flatMap((m) => m.veri),
      );
      if (imitazione) {
        rilevazioni.push({
          modulo: 'link',
          punteggio: 85,
          motivo: `dominio che imita ${imitazione.impersonates} (${imitazione.kind.toLowerCase()})`,
        });
        continue;
      }
    }

    // Gli accorciatori nascondono la destinazione. Non sono malevoli di per
    // sé — mezza Internet li usa — ma in un primo messaggio sono un segnale.
    if (isShortener(host) && ctx.messaggio.primoMessaggio) {
      rilevazioni.push({
        modulo: 'link',
        punteggio: 40,
        motivo: `accorciatore nel primo messaggio (${host})`,
      });
      continue;
    }

    // Da qui in giù il link non è sospetto di suo: resta la politica del
    // canale su chi può mandarne.
    if (modulo.soloPermessi && !ctx.messaggio.abbonato && !ctx.messaggio.vip) {
      rilevazioni.push({
        modulo: 'link',
        punteggio: 30,
        motivo: 'link riservati ad abbonati e VIP su questo canale',
      });
      continue;
    }

    if (modulo.bloccaPrimoMessaggio && ctx.messaggio.primoMessaggio) {
      rilevazioni.push({
        modulo: 'link',
        punteggio: 35,
        motivo: 'link nel primo messaggio di chi non ha mai scritto qui',
      });
    }
  }

  if (containsCryptoAddress(ctx.messaggio.testo)) {
    rilevazioni.push({
      modulo: 'link',
      punteggio: 60,
      motivo: 'indirizzo di portafoglio cripto in chat',
    });
  }

  return rilevazioni;
}

/** Bot commerciali: frasi e login noti. */
export function valutaBotSpam(ctx: ContestoMessaggio): Rilevazione[] {
  const modulo = ctx.config.sicurezza.botSpam;
  if (!modulo.attivo) return [];
  if (ctx.messaggio.streamer || ctx.messaggio.moderatore) return [];

  // I bot legittimi non si toccano mai, a nessun livello: silenziare Nightbot
  // rompe il canale di qualcun altro e il sospettato è il nostro bot.
  if (BOT_LEGITTIMI.includes(ctx.messaggio.utenteLogin)) return [];

  if (
    LOGIN_NOTI.includes(ctx.messaggio.utenteLogin) ||
    modulo.loginVietati.includes(ctx.messaggio.utenteLogin)
  ) {
    return [
      {
        modulo: 'botSpam',
        punteggio: 100,
        motivo: `account noto per lo spam commerciale (${ctx.messaggio.utenteLogin})`,
      },
    ];
  }

  // La normalizzazione è tutto: «Ch̍eap Vi̇ewers» esiste apposta per passare
  // un confronto letterale, e senza questo passaggio l'elenco non serve.
  const testo = modulo.normalizzaUnicode
    ? normalizeForLanguage(ctx.messaggio.testo)
    : ctx.messaggio.testo.toLowerCase();

  const trovati: { frase: string; peso: number; categoria: string }[] = [];

  for (const segnale of SEGNALI) {
    if (testo.includes(segnale.frase)) {
      trovati.push({ frase: segnale.frase, peso: segnale.peso, categoria: segnale.categoria });
    }
  }
  for (const frase of modulo.frasiVietate) {
    const cercata = normalizeForLanguage(frase);
    if (cercata && testo.includes(cercata)) {
      trovati.push({ frase, peso: 60, categoria: 'PERSONALIZZATA' });
    }
  }

  if (trovati.length === 0) return [];

  /*
   * Il peso più alto, più un contributo ridotto dagli altri.
   *
   * Sommare per intero significherebbe che tre frasi da venti punti valgono
   * quanto una da sessanta, e non è vero: tre frasi deboli restano deboli.
   * Ma due segnali deboli insieme sono più di uno solo, ed è il caso del
   * «grafico» che chiede anche di scriverti in privato — nessuno dei due
   * basta, la coppia sì.
   */
  const ordinati = trovati.sort((a, b) => b.peso - a.peso);
  const punteggio = Math.min(
    100,
    (ordinati[0]?.peso ?? 0) + ordinati.slice(1).reduce((somma, t) => somma + t.peso * 0.35, 0),
  );

  return [
    {
      modulo: 'botSpam',
      punteggio,
      motivo: `messaggio commerciale automatico (${ordinati[0]?.categoria.toLowerCase()})`,
      dettagli: { frasi: ordinati.slice(0, 3).map((t) => t.frase) },
    },
  ];
}

/** Anti-spam: velocità, ripetizione, maiuscole, emote, simboli. */
export function valutaAntiSpam(ctx: ContestoMessaggio): Rilevazione[] {
  const modulo = ctx.config.sicurezza.antiSpam;
  if (!modulo.attivo || esente(ctx.messaggio, modulo.esenzioni)) return [];

  const adesso = ctx.adesso ?? Date.now();
  const rilevazioni: Rilevazione[] = [];
  const testo = ctx.messaggio.testo;

  const finestra = ctx.spettatore.recenti.filter(
    (r) => adesso - r.quando <= modulo.finestraSec * 1000,
  );

  if (finestra.length + 1 > modulo.messaggiMax) {
    rilevazioni.push({
      modulo: 'antiSpam',
      punteggio: Math.min(100, 30 + (finestra.length - modulo.messaggiMax) * 10),
      motivo: `${finestra.length + 1} messaggi in ${modulo.finestraSec}s`,
    });
  }

  const normalizzato = normalize(testo);
  const uguali = finestra.filter((r) => normalize(r.testo) === normalizzato).length;
  if (normalizzato.length > 0 && uguali + 1 >= modulo.ripetizioniMax) {
    rilevazioni.push({
      modulo: 'antiSpam',
      punteggio: Math.min(100, 35 + uguali * 10),
      motivo: `stesso messaggio ripetuto ${uguali + 1} volte`,
    });
  }

  if (testo.length >= modulo.maiuscoleMinLunghezza) {
    const rapporto = capsRatio(testo) * 100;
    if (rapporto >= modulo.maiuscolePercento) {
      rilevazioni.push({
        modulo: 'antiSpam',
        punteggio: 25,
        motivo: `${Math.round(rapporto)}% di maiuscole`,
      });
    }
  }

  if (ctx.messaggio.emote > modulo.emoteMax) {
    rilevazioni.push({
      modulo: 'antiSpam',
      punteggio: Math.min(60, 20 + (ctx.messaggio.emote - modulo.emoteMax) * 3),
      motivo: `${ctx.messaggio.emote} emote in un messaggio`,
    });
  }

  if (modulo.bloccaSimboli && zalgoRatio(testo) > 0.25) {
    rilevazioni.push({
      modulo: 'antiSpam',
      punteggio: 45,
      motivo: 'caratteri combinanti che rompono la lettura della chat',
    });
  }

  if (modulo.bloccaAsciiArt && sembraAsciiArt(testo)) {
    rilevazioni.push({ modulo: 'antiSpam', punteggio: 40, motivo: 'ASCII art' });
  }

  return rilevazioni;
}

/**
 * ASCII art.
 *
 * Riconosciuta dalla densità di caratteri non alfabetici su un testo lungo:
 * i disegni sono fatti di riempimenti ripetuti, e nessuna frase normale ha
 * settanta simboli di fila. La soglia sulla lunghezza evita di segnalare le
 * faccine, che di simboli sono fatte per definizione.
 */
export function sembraAsciiArt(testo: string): boolean {
  if (testo.length < 40) return false;
  const simboli = testo.replace(/[\p{L}\p{N}\s]/gu, '').length;
  return simboli / testo.length > 0.55;
}

/** Il primo messaggio di chi non ha mai scritto: la fascia dove sta lo spam. */
export function valutaPrimoMessaggio(ctx: ContestoMessaggio): Rilevazione[] {
  const modulo = ctx.config.sicurezza.primoMessaggio;
  if (!modulo.attivo || !ctx.messaggio.primoMessaggio) return [];
  if (ctx.messaggio.moderatore || ctx.messaggio.streamer || ctx.spettatore.fidato) return [];

  const rilevazioni: Rilevazione[] = [];
  const testo = ctx.messaggio.testo;

  // Il link nel primo messaggio lo giudica già `valutaLink`: qui si aggiunge
  // solo quando quel modulo è spento, per non contare due volte la stessa cosa.
  if (modulo.vietaLink && !ctx.config.sicurezza.link.attivo && extractUrls(testo).length > 0) {
    rilevazioni.push({
      modulo: 'primoMessaggio',
      punteggio: 40,
      motivo: 'link nel primo messaggio',
    });
  }

  if (modulo.vietaMaiuscole && testo.length >= 12 && capsRatio(testo) > 0.7) {
    rilevazioni.push({
      modulo: 'primoMessaggio',
      punteggio: 30,
      motivo: 'primo messaggio tutto in maiuscolo',
    });
  }

  if (modulo.lunghezzaMax > 0 && testo.length > modulo.lunghezzaMax) {
    rilevazioni.push({
      modulo: 'primoMessaggio',
      punteggio: 35,
      motivo: `primo messaggio di ${testo.length} caratteri`,
    });
  }

  return rilevazioni;
}

/**
 * Impersonazione dello streamer o di un moderatore.
 *
 * Il confronto è fra nomi normalizzati: `yayad0ppia` e `уауadoppia` (con la
 * cirillica) diventano la stessa stringa, che è il punto — sono state scelte
 * apposta per essere indistinguibili a occhio in una chat che scorre.
 */
export function valutaImpersonazione(ctx: ContestoMessaggio): Rilevazione[] {
  const modulo = ctx.config.sicurezza.impersonazione;
  if (!modulo.attivo) return [];
  if (ctx.messaggio.streamer || ctx.messaggio.moderatore) return [];

  const mio = normalize(ctx.messaggio.utenteLogin);
  const bersagli = [
    ctx.streamerLogin,
    ...(modulo.includiModeratori ? ctx.moderatoriLogin : []),
  ].map((l) => normalize(l));

  for (const bersaglio of bersagli) {
    if (!bersaglio || mio === bersaglio) continue;
    const somiglianza = nameSimilarity(mio, bersaglio) * 100;
    if (somiglianza >= modulo.sogliaSomiglianza) {
      return [
        {
          modulo: 'impersonazione',
          punteggio: Math.min(100, Math.round(somiglianza)),
          motivo: `nome quasi identico a ${bersaglio} (${Math.round(somiglianza)}%)`,
        },
      ];
    }
  }

  return [];
}

/* ── Verdetto ─────────────────────────────────────────────────────────── */

/** I moduli con una scala propria, e quale scala usare per ciascuno. */
function scalaDi(config: TwitchChannelConfig, modulo: string): ScalaTwitch {
  switch (modulo) {
    case 'linguaggio':
      return config.sicurezza.linguaggio.scala;
    case 'link':
      return config.sicurezza.link.scala;
    case 'antiSpam':
    case 'primoMessaggio':
      return config.sicurezza.antiSpam.scala;
    default:
      return [];
  }
}

/**
 * Valuta un messaggio.
 *
 * L'ordine dei moduli non è casuale: i due che riconoscono una minaccia certa
 * — bot commerciali e link — vengono prima, così un messaggio già condannato
 * non paga il costo dell'analisi del linguaggio. Su una chat da mille
 * messaggi al minuto la differenza si vede.
 */
export function valuta(ctx: ContestoMessaggio): Verdetto {
  const rilevazioni: Rilevazione[] = [
    ...valutaBotSpam(ctx),
    ...valutaLink(ctx),
    ...valutaLinguaggio(ctx),
    ...valutaAntiSpam(ctx),
    ...valutaPrimoMessaggio(ctx),
    ...valutaImpersonazione(ctx),
  ];

  if (rilevazioni.length === 0) {
    return {
      punteggio: 0,
      rilevazioni,
      azione: 'NIENTE',
      durataSec: 0,
      motivo: '',
      eliminaMessaggio: false,
      simulato: ctx.config.modalitaProva,
    };
  }

  // Punteggio per modulo: la somma dentro un modulo ha senso — tre segnali di
  // spam sono più spam — mentre fra moduli no.
  const perModulo = new Map<string, number>();
  for (const rilevazione of rilevazioni) {
    perModulo.set(
      rilevazione.modulo,
      Math.min(100, (perModulo.get(rilevazione.modulo) ?? 0) + rilevazione.punteggio),
    );
  }

  let azione: AzioneTwitch = 'NIENTE';
  let durataSec = 0;

  for (const [modulo, punteggio] of perModulo) {
    const scelta =
      modulo === 'botSpam'
        ? { azione: ctx.config.sicurezza.botSpam.azione, durataSec: 0 }
        : modulo === 'impersonazione'
          ? { azione: ctx.config.sicurezza.impersonazione.azione, durataSec: 600 }
          : scegliAzione(scalaDi(ctx.config, modulo), punteggio);

    if (SEVERITA[scelta.azione] > SEVERITA[azione]) {
      azione = scelta.azione;
      durataSec = scelta.durataSec;
    }
  }

  const piuGrave = [...rilevazioni].sort((a, b) => b.punteggio - a.punteggio)[0];

  return {
    punteggio: Math.max(...perModulo.values()),
    rilevazioni,
    azione,
    durataSec,
    motivo: piuGrave?.motivo ?? '',
    // Se si silenzia o si bandisce, il messaggio va tolto comunque: lasciarlo
    // lì significa che il link truffa resta leggibile mentre chi lo ha scritto
    // è già stato zittito.
    eliminaMessaggio: SEVERITA[azione] >= SEVERITA.ELIMINA_MESSAGGIO,
    simulato: ctx.config.modalitaProva,
  };
}

/* ── Raid ─────────────────────────────────────────────────────────────── */

export interface StatoRaid {
  /** Quando ha scritto per la prima volta ciascun nuovo arrivato, in ms. */
  nuovi: number[];
  /** Impronte dei messaggi recenti, per riconoscere il coordinamento. */
  impronte: { impronta: string; quando: number }[];
}

export interface VerdettoRaid {
  attacco: boolean;
  nuoviNellaFinestra: number;
  similiNellaFinestra: number;
  motivo: string;
}

/**
 * Ondata coordinata.
 *
 * Due segnali indipendenti: quanti sconosciuti hanno scritto per la prima
 * volta nella finestra, e quanti messaggi diversi si somigliano. Il primo da
 * solo scatta quando un canale viene raidato da un amico — che è una bella
 * cosa e non va trattata come un attacco. Il secondo da solo scatta su una
 * copypasta divertente. Insieme, no.
 */
export function valutaRaid(
  config: TwitchChannelConfig,
  stato: StatoRaid,
  adesso = Date.now(),
): VerdettoRaid {
  const modulo = config.sicurezza.antiRaid;
  const limite = adesso - modulo.finestraSec * 1000;

  const nuovi = stato.nuovi.filter((quando) => quando >= limite).length;

  const recenti = stato.impronte.filter((i) => i.quando >= limite);
  const conteggio = new Map<string, number>();
  for (const voce of recenti) conteggio.set(voce.impronta, (conteggio.get(voce.impronta) ?? 0) + 1);
  const simili = Math.max(0, ...conteggio.values());

  if (!modulo.attivo) {
    return { attacco: false, nuoviNellaFinestra: nuovi, similiNellaFinestra: simili, motivo: '' };
  }

  const troppiNuovi = nuovi >= modulo.nuoviMax;
  const troppoSimili = simili >= modulo.similiMax;

  // Molti sconosciuti *e* messaggi che si somigliano: è coordinato. Oppure
  // moltissimi sconosciuti da soli — al doppio della soglia non è più un
  // raid amichevole nemmeno con messaggi tutti diversi.
  const attacco = (troppiNuovi && troppoSimili) || nuovi >= modulo.nuoviMax * 2;

  return {
    attacco,
    nuoviNellaFinestra: nuovi,
    similiNellaFinestra: simili,
    motivo: attacco
      ? `${nuovi} sconosciuti in ${modulo.finestraSec}s` +
        (troppoSimili ? `, ${simili} messaggi quasi identici` : '')
      : '',
  };
}

/** Impronta di un messaggio, per confrontarne la forma e non le parole. */
export function improntaMessaggio(testo: string): string {
  return normalize(testo).replace(/\d+/g, '#').slice(0, 60);
}
