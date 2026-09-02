/* ═══════════════════════════════════════════════════════════════════════
   CONFIGURAZIONE DEL BOT TWITCH

   Un canale Twitch non è un server Discord, e la configurazione non poteva
   essere la stessa. Le differenze che contano:

   • **Non c'è nessun ruolo.** Su Twitch esistono quattro livelli e basta:
     spettatore, abbonato/VIP, moderatore, streamer. Tutta la parte di
     esenzioni per ruolo di Discord qui non ha significato, e riproporla
     avrebbe prodotto quaranta caselle che non fanno niente.

   • **Non si può nascondere un canale.** Su Discord la difesa più forte è
     togliere il permesso di vedere; su Twitch la chat è una sola e si può
     solo rallentare, filtrare o chiudere. Le difese sono quindi tutte
     reattive, e la velocità conta più della precisione.

   • **Il proprietario non è chi installa.** Il pannello Discord lo apre chi
     possiede il bot; questo lo apre lo streamer, per il proprio canale. La
     configurazione è per canale e non per «server», e ogni canale è isolato
     dagli altri: nessuno vede i dati di nessun altro.

   • **Ci sono i Termini di Servizio di Twitch.** Il Developer Services
     Agreement pone limiti veri su cosa si può conservare e per quanto —
     vedi `conservazione` più sotto. Non sono buone intenzioni: sono la
     differenza fra un'applicazione che resta viva e una a cui revocano le
     chiavi.
   ═══════════════════════════════════════════════════════════════════════ */

import { z } from 'zod';
import { Seconds } from './common.js';

/* ── Blocchi comuni ───────────────────────────────────────────────────── */

/** Login Twitch: minuscolo, 4-25 caratteri, lettere numeri e underscore. */
export const TwitchLogin = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,25}$/, 'login Twitch non valido');

/**
 * Chi è immune a un modulo.
 *
 * Quattro caselle e un elenco, perché su Twitch i livelli sono quattro e non
 * esiste altro. `moderatori` è acceso ovunque di partenza: un moderatore
 * silenziato dal bot che dovrebbe aiutarlo è il modo più rapido per farlo
 * spegnere del tutto.
 */
export const TwitchEsenzioni = z
  .object({
    moderatori: z.boolean().default(true),
    vip: z.boolean().default(false),
    abbonati: z.boolean().default(false),
    /** Login esentati a mano: altri bot legittimi, un amico, un secondo account. */
    utenti: z.array(TwitchLogin).default([]),
  })
  .default({});
export type TwitchEsenzioni = z.infer<typeof TwitchEsenzioni>;

/**
 * Cosa può fare il bot in chat.
 *
 * Deliberatamente più corta della scala di Discord: su Twitch le azioni
 * disponibili sono queste e non altre, ed elencarne di più significherebbe
 * offrire pulsanti che non premono niente.
 */
export const AzioneTwitch = z.enum([
  'NIENTE',
  /** Registra e basta: è il modo di provare una regola senza sanzionare nessuno. */
  'SOLO_REGISTRO',
  /** Avvisa i moderatori su Discord, senza toccare la chat. */
  'AVVISA',
  'ELIMINA_MESSAGGIO',
  /** Elimina e scrive un avvertimento pubblico in chat. */
  'AVVERTI',
  /** Timeout: la durata la decide la scala. */
  'SILENZIA',
  'BANDISCI',
  /** Attiva la modalità scudo del canale: è la risposta a un raid, non a una persona. */
  'SCUDO',
]);
export type AzioneTwitch = z.infer<typeof AzioneTwitch>;

/**
 * Scala di risposta: a ogni soglia di punteggio corrisponde un'azione.
 *
 * Stessa forma di Discord di proposito. Chi ha già configurato il bot da una
 * parte non deve reimparare niente dall'altra, e il pannello riusa lo stesso
 * componente.
 */
export const ScalaTwitch = z
  .array(
    z.object({
      dalPunteggio: z.number().int().min(0).max(100),
      azione: AzioneTwitch,
      /** Secondi di timeout. 0 = permanente per BANDISCI, 600 per SILENZIA. */
      durataSec: z.number().int().min(0).max(1209600).default(0),
    }),
  )
  .default([]);
export type ScalaTwitch = z.infer<typeof ScalaTwitch>;

const ModuloTwitch = z.object({ attivo: z.boolean().default(true) });

/* ── Moduli di sicurezza ──────────────────────────────────────────────── */

/**
 * Linguaggio: la stessa lista di parole del bot Discord.
 *
 * È il punto in cui i due bot si toccano davvero. La lista vive in
 * `@angel/shared/config/wordlist` e la leggono tutti e due: aggiungere una
 * parola dal pannello Discord la blocca anche in chat Twitch, senza
 * sincronizzazioni da ricordare e senza due liste che divergono.
 *
 * `terminiTwitch` sono le aggiunte valide solo qui: nomi di servizi di
 * viewbot, frasi dei bot di spam, roba che su Discord non si vede mai.
 */
export const TwitchLinguaggio = ModuloTwitch.extend({
  /** Usa la lista condivisa con il bot Discord. */
  listaCondivisa: z.boolean().default(true),
  /** Gravità minima da sanzionare: sotto, si registra e basta. */
  gravitaMinima: z.enum(['LIEVE', 'MEDIA', 'GRAVE']).default('MEDIA'),
  /** Parole aggiuntive solo per questo canale. */
  paroleAggiuntive: z.array(z.string().trim().min(2).max(64)).default([]),
  /** Parole tolte solo per questo canale: il gergo di una community non è un insulto. */
  paroleAmmesse: z.array(z.string().trim().min(2).max(64)).default([]),
  /**
   * Sincronizza le parole nei «termini bloccati» nativi di Twitch.
   *
   * Twitch ne accetta al massimo cento per canale: ci vanno le più gravi, e
   * il bot sceglie quelle. Il vantaggio è che AutoMod di Twitch le blocca
   * *prima* che il messaggio compaia, mentre il bot può solo cancellarlo dopo
   * — e in una chat veloce quella differenza sono decine di persone che lo
   * hanno già letto.
   */
  sincronizzaTerminiTwitch: z.boolean().default(false),
  scala: ScalaTwitch.default([
    { dalPunteggio: 20, azione: 'ELIMINA_MESSAGGIO', durataSec: 0 },
    { dalPunteggio: 40, azione: 'SILENZIA', durataSec: 600 },
    { dalPunteggio: 70, azione: 'SILENZIA', durataSec: 86400 },
  ]),
  esenzioni: TwitchEsenzioni,
});

/**
 * Link.
 *
 * Su Twitch il link è il vettore quasi unico: non si possono caricare file,
 * non ci sono allegati, e ogni truffa passa da un dominio. Le campagne del
 * 2026 sono tre e si riconoscono bene — venditori di follower e visualizzatori
 * finti, finte carte regalo Steam, e i «grafici» che offrono loghi per
 * raccogliere anticipi.
 */
export const TwitchLink = ModuloTwitch.extend({
  /** Chi non ha mai scritto qui non può mandare link. È la regola che ferma di più. */
  bloccaPrimoMessaggio: z.boolean().default(true),
  /** Blocca ogni link a chi non è abbonato/VIP/moderatore. */
  soloPermessi: z.boolean().default(false),
  /** Domini sempre ammessi. Ci finiscono da soli i propri social alla prima configurazione. */
  dominiAmmessi: z.array(z.string().trim().toLowerCase()).default([]),
  /** Domini sempre bloccati, in aggiunta alle blocklist condivise. */
  dominiVietati: z.array(z.string().trim().toLowerCase()).default([]),
  /**
   * Usa le blocklist del bot Discord: URLhaus, Phishing.Database, Safe
   * Browsing, e le firme raccolte dallo scanner.
   *
   * Sono già scaricate e aggiornate ogni sei ore per Discord: non usarle qui
   * significherebbe tenere due archivi delle stesse minacce.
   */
  usaBlocklistCondivise: z.boolean().default(true),
  /** Riconosce i domini che imitano Twitch, Steam, Discord (omoglifi, punycode). */
  rilevaImitazioni: z.boolean().default(true),
  scala: ScalaTwitch.default([
    { dalPunteggio: 25, azione: 'ELIMINA_MESSAGGIO', durataSec: 0 },
    { dalPunteggio: 50, azione: 'SILENZIA', durataSec: 600 },
    { dalPunteggio: 80, azione: 'BANDISCI', durataSec: 0 },
  ]),
  esenzioni: TwitchEsenzioni,
});

/** Anti-spam: ripetizione, velocità, maiuscole, emote, simboli. */
export const TwitchAntiSpam = ModuloTwitch.extend({
  /** Messaggi per finestra prima di considerarlo troppo veloce. */
  messaggiMax: z.number().int().min(2).max(50).default(6),
  finestraSec: Seconds(2, 120, 15),
  /** Quante volte lo stesso messaggio prima di intervenire. */
  ripetizioniMax: z.number().int().min(2).max(20).default(3),
  /** Percentuale di maiuscole oltre la quale il messaggio è un urlo. */
  maiuscolePercento: z.number().int().min(30).max(100).default(70),
  /** Sotto questa lunghezza le maiuscole non contano: «OK» non è un urlo. */
  maiuscoleMinLunghezza: z.number().int().min(4).max(100).default(12),
  emoteMax: z.number().int().min(1).max(100).default(12),
  /** Blocca i muri di simboli e lo zalgo, che rompono la lettura della chat. */
  bloccaSimboli: z.boolean().default(true),
  /** Blocca l'ASCII art: righe lunghe di caratteri di riempimento. */
  bloccaAsciiArt: z.boolean().default(true),
  scala: ScalaTwitch.default([
    { dalPunteggio: 20, azione: 'ELIMINA_MESSAGGIO', durataSec: 0 },
    { dalPunteggio: 45, azione: 'SILENZIA', durataSec: 60 },
    { dalPunteggio: 70, azione: 'SILENZIA', durataSec: 3600 },
  ]),
  esenzioni: TwitchEsenzioni,
});

/**
 * Raid ostile.
 *
 * Non il raid di Twitch, che è una cosa buona: l'ondata di account creati
 * apposta che arrivano insieme e riempiono la chat. Colpisce in modo
 * sproporzionato chi già subisce molestie, e i primi trenta secondi decidono
 * tutto — per questo la risposta è automatica e non un avviso da leggere.
 */
export const TwitchAntiRaid = ModuloTwitch.extend({
  /** Utenti mai visti che scrivono per la prima volta, nella finestra. */
  nuoviMax: z.number().int().min(3).max(200).default(15),
  finestraSec: Seconds(5, 300, 30),
  /** Quanti messaggi simili fra loro fanno scattare il sospetto di coordinamento. */
  similiMax: z.number().int().min(2).max(50).default(5),
  /** Attiva la modalità scudo di Twitch, che applica le impostazioni scelte dallo streamer. */
  attivaScudo: z.boolean().default(true),
  /** Mette la chat in modalità «solo chi segue da N minuti». 0 = non toccarla. */
  soloSeguaciDaMinuti: z.number().int().min(0).max(129600).default(10),
  /** Rallenta la chat a un messaggio ogni N secondi. 0 = non toccarla. */
  rallentaSec: z.number().int().min(0).max(120).default(10),
  /** Per quanto restano le restrizioni prima di togliersi da sole. */
  durataSec: Seconds(60, 86400, 900),
  /** Bandisce chi ha scritto durante l'ondata, non solo il messaggio. */
  bandisciPartecipanti: z.boolean().default(false),
});

/**
 * Bot di spam noti.
 *
 * Non sono raid: sono servizi commerciali che girano fra i canali offrendo
 * follower finti, visualizzatori finti e «crescita». Si riconoscono dalle
 * frasi più che dai nomi, perché i nomi cambiano ogni settimana mentre le
 * frasi restano — e sono scritte con caratteri Unicode strani apposta per
 * passare i filtri letterali.
 */
export const TwitchBotSpam = ModuloTwitch.extend({
  /** Normalizza gli omoglifi prima del confronto: «Ch̍eap Vi̇ewers» diventa «cheap viewers». */
  normalizzaUnicode: z.boolean().default(true),
  /** Login aggiuntivi da bandire a vista. */
  loginVietati: z.array(TwitchLogin).default([]),
  /** Frasi aggiuntive oltre a quelle di serie. */
  frasiVietate: z.array(z.string().trim().min(3).max(120)).default([]),
  azione: AzioneTwitch.default('BANDISCI'),
});

/**
 * Impersonazione dello streamer o dei moderatori.
 *
 * Un nome quasi uguale a quello dello streamer, e un messaggio che dice
 * «hai vinto, scrivimi in privato». Funziona perché in una chat veloce
 * nessuno confronta lettera per lettera.
 */
export const TwitchImpersonazione = ModuloTwitch.extend({
  /** Somiglianza oltre la quale scatta, da 0 a 100. */
  sogliaSomiglianza: z.number().int().min(60).max(100).default(85),
  /** Controlla anche i moderatori, non solo lo streamer. */
  includiModeratori: z.boolean().default(true),
  azione: AzioneTwitch.default('AVVISA'),
});

/**
 * Primo messaggio.
 *
 * Chi scrive per la prima volta in un canale è la categoria in cui sta quasi
 * tutto lo spam, e quasi nessuno degli spettatori affezionati. Restringere
 * solo quel primo messaggio costa pochissimo a chi arriva in buona fede.
 */
export const TwitchPrimoMessaggio = ModuloTwitch.extend({
  /** Niente link nel primo messaggio. */
  vietaLink: z.boolean().default(true),
  /** Niente maiuscole urlate nel primo messaggio. */
  vietaMaiuscole: z.boolean().default(true),
  /** Lunghezza massima del primo messaggio. 0 = nessun limite. */
  lunghezzaMax: z.number().int().min(0).max(500).default(0),
  /** Saluta chi scrive per la prima volta. Vuoto = nessun saluto. */
  saluto: z.string().max(400).default(''),
});

/* ── Funzioni da bot di chat ──────────────────────────────────────────── */

/**
 * Messaggi a tempo.
 *
 * `minRighe` è la differenza fra un bot utile e un bot fastidioso: senza,
 * il messaggio esce anche in una chat ferma, e su un canale piccolo il bot
 * finisce per parlare da solo tutta la sera.
 */
export const TwitchTimerConfig = z.object({
  nome: z.string().trim().min(1).max(40),
  /** Più messaggi: escono a rotazione, così non è sempre lo stesso testo. */
  messaggi: z.array(z.string().trim().min(1).max(450)).min(1),
  intervalloSec: Seconds(60, 86400, 900),
  /** Righe di chat che devono passare fra un'uscita e l'altra. */
  minRighe: z.number().int().min(0).max(500).default(5),
  /** Esce anche a canale offline. Di solito no: non lo legge nessuno. */
  ancheOffline: z.boolean().default(false),
  attivo: z.boolean().default(true),
});
export type TwitchTimerConfig = z.infer<typeof TwitchTimerConfig>;

/** Chi può usare un comando. */
export const LivelloTwitch = z.enum(['TUTTI', 'ABBONATI', 'VIP', 'MODERATORI', 'STREAMER']);
export type LivelloTwitch = z.infer<typeof LivelloTwitch>;

export const TwitchComandoConfig = z.object({
  nome: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,24}$/, 'nome comando non valido'),
  alias: z.array(z.string().trim().toLowerCase()).default([]),
  /**
   * La risposta, con i segnaposto di `applicaModello`: {utente}, {canale},
   * {uptime}, {gioco}, {titolo}, {contatore}, {argomento}, {random:a|b|c}.
   */
  risposta: z.string().trim().min(1).max(450),
  livello: LivelloTwitch.default('TUTTI'),
  /** Attesa per chi lo ha usato. */
  cooldownSec: Seconds(0, 3600, 10),
  /** Attesa per tutto il canale: evita che tre persone lo ripetano di fila. */
  cooldownCanaleSec: Seconds(0, 3600, 3),
  attivo: z.boolean().default(true),
});
export type TwitchComandoConfig = z.infer<typeof TwitchComandoConfig>;

/* ── Registro, avvisi, conservazione ──────────────────────────────────── */

/**
 * Dove finisce quello che succede.
 *
 * Tre destinazioni, e servono tutte e tre a cose diverse: Discord per essere
 * avvisati mentre accade, il file sul server per poter cercare fra sei mesi,
 * il database per il pannello. Il file è quello che sopravvive a tutto il
 * resto — resta leggibile con `grep` anche senza il bot, senza il database e
 * senza il pannello.
 */
export const TwitchRegistro = z.object({
  /** Manda avvisi e registro su Discord. */
  suDiscord: z.boolean().default(true),
  /** Server Discord dove pubblicare. Vuoto = quello collegato al canale. */
  guildId: z.string().regex(/^\d{17,20}$/).or(z.literal('')).default(''),
  canaleRegistroId: z.string().regex(/^\d{17,20}$/).or(z.literal('')).default(''),
  canaleAvvisiId: z.string().regex(/^\d{17,20}$/).or(z.literal('')).default(''),
  /** Gravità minima per finire su Discord: sotto, resta solo nell'archivio. */
  gravitaMinimaDiscord: z.number().int().min(0).max(100).default(20),
  /** Scrive un file NDJSON al giorno sotto STORAGE_DIR/twitch/<canale>/. */
  archivioSuDisco: z.boolean().default(true),
  /**
   * Conserva il testo dei messaggi sanzionati.
   *
   * Senza, resta l'azione e il motivo ma non cosa è stato scritto: si sa che
   * qualcuno è stato silenziato e non si può più verificare se fosse giusto.
   * Con, si conserva del testo scritto da terzi — ed è la ragione per cui la
   * conservazione ha una scadenza corta e obbligatoria.
   */
  conservaTesto: z.boolean().default(true),
});

/**
 * Per quanto si tiene quello che si è raccolto.
 *
 * Il Developer Services Agreement di Twitch è esplicito: i log di chat si
 * conservano solo per il tempo necessario al funzionamento del servizio, mai
 * per costruire archivi pubblici o profilare gli spettatori. Questi numeri
 * sono quindi un vincolo contrattuale, non una preferenza — ed è il motivo
 * per cui il massimo è novanta giorni e non «per sempre».
 */
export const TwitchConservazione = z.object({
  /** Giorni di conservazione del testo dei messaggi sanzionati. */
  testoGiorni: z.number().int().min(1).max(90).default(30),
  /** Giorni di conservazione degli eventi senza testo (chi, quando, quale azione). */
  eventiGiorni: z.number().int().min(7).max(365).default(180),
  /** Giorni dopo i quali uno spettatore mai più visto viene dimenticato. */
  spettatoriGiorni: z.number().int().min(30).max(730).default(365),
  /**
   * Consente a chi scrive in chat di farsi cancellare con `!angel dimenticami`.
   *
   * Acceso e non disattivabile dal pannello per scelta: l'accordo con Twitch
   * obbliga a dare modo di opporsi, e un interruttore per toglierlo sarebbe
   * un interruttore per violarlo.
   */
  cancellazioneSuRichiesta: z.literal(true).default(true),
});

/* ── Livello di sicurezza ─────────────────────────────────────────────── */

/**
 * Livelli.
 *
 * Chi apre il pannello per la prima volta non vuole decidere trenta soglie:
 * vuole dire «tieni pulito» e andarsene a trasmettere. I livelli sono
 * quell'unica scelta, e restano modificabili — toccare qualunque campo
 * sposta il livello su PERSONALIZZATO, così il pannello non mente dicendo
 * «Normale» su una configurazione che normale non è più.
 */
export const LivelloSicurezza = z.enum([
  /** Solo registro: nessuna sanzione. Il modo di guardare cosa farebbe prima di lasciarglielo fare. */
  'OSSERVA',
  /** Blocca link malevoli e bot di spam noti. Nient'altro. */
  'LEGGERO',
  /** L'equilibrio consigliato: linguaggio, link, spam, raid. */
  'NORMALE',
  /** Chat molto attive o sotto attacco: soglie strette, primo messaggio limitato. */
  'ALTO',
  /** Sotto molestie: link vietati a chi non è abbonato, raid trattato al primo segnale. */
  'BLINDATO',
  /** Nessun preset: valori scelti a mano. */
  'PERSONALIZZATO',
]);
export type LivelloSicurezza = z.infer<typeof LivelloSicurezza>;

/* ── Configurazione completa di un canale ─────────────────────────────── */

export const TwitchChannelConfigSchema = z
  .object({
    version: z.literal(1).default(1),

    /** Il bot risponde in chat. Spento, resta collegato e registra soltanto. */
    attivo: z.boolean().default(true),
    livello: LivelloSicurezza.default('NORMALE'),
    /** Prefisso dei comandi. */
    prefisso: z.string().trim().min(1).max(3).default('!'),
    /** Lingua delle risposte automatiche. */
    lingua: z.enum(['it', 'en']).default('it'),

    /**
     * Modalità prova: valuta tutto, non sanziona nulla, registra cosa avrebbe
     * fatto. Sopra ogni singolo modulo, perché la domanda «cosa succederebbe
     * se accendessi tutto» merita una risposta che non costi una sospensione
     * ingiusta.
     */
    modalitaProva: z.boolean().default(false),

    sicurezza: z
      .object({
        linguaggio: TwitchLinguaggio.default({}),
        link: TwitchLink.default({}),
        antiSpam: TwitchAntiSpam.default({}),
        antiRaid: TwitchAntiRaid.default({}),
        botSpam: TwitchBotSpam.default({}),
        impersonazione: TwitchImpersonazione.default({}),
        primoMessaggio: TwitchPrimoMessaggio.default({}),
      })
      .default({}),

    chat: z
      .object({
        /** Messaggi a tempo. */
        timer: z.array(TwitchTimerConfig).default([]),
        /** Comandi personalizzati. */
        comandi: z.array(TwitchComandoConfig).default([]),
        /** Comandi di serie: !uptime, !comandi, !dado, !seguito. */
        comandiIntegrati: z.boolean().default(true),
        /** Chi può guidare il bot dalla chat con `!angel …`. */
        livelloComandiBot: LivelloTwitch.default('MODERATORI'),
        /** Saluta i raid in arrivo. Vuoto = niente saluto. */
        salutoRaid: z.string().max(400).default(''),
        /** Ringrazia i nuovi abbonati. Vuoto = niente. */
        salutoAbbonato: z.string().max(400).default(''),
      })
      .default({}),

    registro: TwitchRegistro.default({}),
    conservazione: TwitchConservazione.default({}),
  })
  .default({});
export type TwitchChannelConfig = z.infer<typeof TwitchChannelConfigSchema>;

export function defaultTwitchConfig(): TwitchChannelConfig {
  return TwitchChannelConfigSchema.parse({});
}

/* ── I preset ─────────────────────────────────────────────────────────── */

/**
 * Cosa cambia ogni livello.
 *
 * Scritto come differenza rispetto al default e non come configurazione
 * intera: così un campo nuovo aggiunto allo schema arriva in tutti i livelli
 * con il proprio valore predefinito, invece di restare fuori da quattro
 * preset che nessuno si ricorda di aggiornare.
 */
type Ritocchi = (config: TwitchChannelConfig) => void;

const PRESET: Record<Exclude<LivelloSicurezza, 'PERSONALIZZATO'>, Ritocchi> = {
  OSSERVA: (c) => {
    c.modalitaProva = true;
  },

  LEGGERO: (c) => {
    c.sicurezza.linguaggio.attivo = false;
    c.sicurezza.antiSpam.attivo = false;
    c.sicurezza.impersonazione.attivo = false;
    c.sicurezza.primoMessaggio.vietaMaiuscole = false;
    c.sicurezza.antiRaid.nuoviMax = 40;
    c.sicurezza.antiRaid.bandisciPartecipanti = false;
  },

  NORMALE: () => {
    /* I valori predefiniti dello schema *sono* il livello normale. */
  },

  ALTO: (c) => {
    c.sicurezza.linguaggio.gravitaMinima = 'LIEVE';
    c.sicurezza.antiSpam.messaggiMax = 4;
    c.sicurezza.antiSpam.ripetizioniMax = 2;
    c.sicurezza.antiSpam.emoteMax = 8;
    c.sicurezza.antiRaid.nuoviMax = 8;
    c.sicurezza.antiRaid.finestraSec = 20;
    c.sicurezza.primoMessaggio.lunghezzaMax = 200;
    c.sicurezza.link.scala = [
      { dalPunteggio: 20, azione: 'ELIMINA_MESSAGGIO', durataSec: 0 },
      { dalPunteggio: 40, azione: 'SILENZIA', durataSec: 1800 },
      { dalPunteggio: 70, azione: 'BANDISCI', durataSec: 0 },
    ];
  },

  BLINDATO: (c) => {
    c.sicurezza.linguaggio.gravitaMinima = 'LIEVE';
    c.sicurezza.linguaggio.sincronizzaTerminiTwitch = true;
    c.sicurezza.link.soloPermessi = true;
    c.sicurezza.antiSpam.messaggiMax = 3;
    c.sicurezza.antiSpam.ripetizioniMax = 2;
    c.sicurezza.antiSpam.emoteMax = 5;
    c.sicurezza.antiSpam.maiuscolePercento = 50;
    c.sicurezza.antiRaid.nuoviMax = 5;
    c.sicurezza.antiRaid.finestraSec = 15;
    c.sicurezza.antiRaid.soloSeguaciDaMinuti = 1440;
    c.sicurezza.antiRaid.rallentaSec = 30;
    c.sicurezza.antiRaid.bandisciPartecipanti = true;
    c.sicurezza.primoMessaggio.lunghezzaMax = 120;
    c.sicurezza.impersonazione.sogliaSomiglianza = 75;
    c.sicurezza.impersonazione.azione = 'SILENZIA';
  },
};

/**
 * Applica un livello, conservando quello che il livello non riguarda.
 *
 * Timer, comandi, canali di registro e domini ammessi restano dove sono: sono
 * il lavoro dello streamer, e un preset che li cancellasse renderebbe i
 * livelli qualcosa che non si osa più toccare.
 */
export function applicaLivello(
  livello: LivelloSicurezza,
  precedente?: TwitchChannelConfig,
): TwitchChannelConfig {
  const base = defaultTwitchConfig();

  if (precedente) {
    base.prefisso = precedente.prefisso;
    base.lingua = precedente.lingua;
    base.attivo = precedente.attivo;
    base.chat = precedente.chat;
    base.registro = precedente.registro;
    base.conservazione = precedente.conservazione;
    base.sicurezza.link.dominiAmmessi = precedente.sicurezza.link.dominiAmmessi;
    base.sicurezza.link.dominiVietati = precedente.sicurezza.link.dominiVietati;
    base.sicurezza.linguaggio.paroleAggiuntive = precedente.sicurezza.linguaggio.paroleAggiuntive;
    base.sicurezza.linguaggio.paroleAmmesse = precedente.sicurezza.linguaggio.paroleAmmesse;
    base.sicurezza.botSpam.loginVietati = precedente.sicurezza.botSpam.loginVietati;
    base.sicurezza.botSpam.frasiVietate = precedente.sicurezza.botSpam.frasiVietate;
    base.sicurezza.primoMessaggio.saluto = precedente.sicurezza.primoMessaggio.saluto;
  }

  base.livello = livello;
  if (livello !== 'PERSONALIZZATO') PRESET[livello](base);
  return base;
}

/** Descrizione di ogni livello, per il pannello e per `!angel livello`. */
export const DESCRIZIONE_LIVELLI: Record<LivelloSicurezza, string> = {
  OSSERVA:
    'Guarda e non tocca. Valuta ogni messaggio e scrive cosa avrebbe fatto, senza sanzionare ' +
    'nessuno. È il modo di capire come si comporterebbe sul tuo canale prima di lasciarglielo fare.',
  LEGGERO:
    'Solo link malevoli e bot di spam noti. Nessun filtro sul linguaggio, nessun anti-spam: ' +
    'la chat resta com’è, sparisce solo chi vende follower.',
  NORMALE:
    'L’equilibrio consigliato. Linguaggio, link, spam e raid attivi con soglie larghe: ' +
    'interviene su quello che disturba davvero e lascia stare il resto.',
  ALTO:
    'Per chat molto attive o periodi difficili. Soglie strette, primo messaggio limitato, ' +
    'raid trattato prima. Qualche falso positivo in più è il prezzo.',
  BLINDATO:
    'Sotto attacco. Link vietati a chi non è abbonato, raid al primo segnale, chat rallentata ' +
    'e riservata a chi segue da un giorno. Scomodo di proposito: serve a far passare la nottata.',
  PERSONALIZZATO: 'Valori scelti a mano. Nessun preset li tocca più.',
};
