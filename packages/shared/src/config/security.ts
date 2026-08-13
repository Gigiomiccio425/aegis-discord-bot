import { z } from 'zod';
import { DEFAULT_ALLOWLIST, DEFAULT_WORDLIST } from './wordlist.js';
import {
  ActionKind,
  ActionLadder,
  ActiveModuleBase,
  GuardModuleBase,
  RateThreshold,
  Seconds,
  Snowflake,
  SnowflakeList,
} from './common.js';

/* ═══════════════════════════════════════════════════════════════════════
   ANTI-RAID  —  minaccia B2
   Le reti di self-bot generano migliaia di account in pochi minuti e i primi
   30 secondi decidono l'esito: il rilevamento deve essere su finestra breve.
   ═══════════════════════════════════════════════════════════════════════ */
export const AntiRaidConfig = ActiveModuleBase.extend({
  /** Trigger primario: troppi join in poco tempo. */
  joinBurst: RateThreshold.default({ count: 10, windowSec: 30 }),

  /**
   * Trigger secondario: i join sono pochi ma *simili tra loro*.
   * Un raid lento resta un raid.
   */
  clustering: z
    .object({
      enabled: z.boolean().default(true),
      /** Account creati da meno di N ore contano come sospetti. */
      newAccountHours: z.number().int().min(0).max(8760).default(72),
      /** Similarità minima fra username per considerarli lo stesso cluster (0-1). */
      nameSimilarity: z.number().min(0).max(1).default(0.85),
      /** Quanti membri simili servono per far scattare il cluster. */
      minClusterSize: z.number().int().min(2).max(100).default(5),
      windowSec: Seconds(10, 3600, 300),
    })
    .default({}),

  /** Livello di risposta raggiunto automaticamente al trigger. */
  responseLevel: z
    .enum(['MONITOR', 'VERIFY', 'QUARANTINE', 'LOCKDOWN'])
    .default('QUARANTINE'),

  /** Azione applicata ai membri identificati come parte del raid. */
  raiderAction: ActionKind.default('QUARANTINE'),

  /** Il lockdown si disattiva da solo dopo N secondi (0 = manuale). */
  autoLiftAfterSec: Seconds(0, 86400, 900),

  /** Durante il lockdown mette in pausa gli inviti del server. */
  pauseInvites: z.boolean().default(true),

  /** Rende i canali pubblici in sola lettura durante il lockdown. */
  lockChannels: z.boolean().default(true),

  /** Canali da NON bloccare (es. #annunci-emergenza). */
  lockdownExemptChannels: SnowflakeList,

  /**
   * Scrive in ogni canale bloccato che il server è in lockdown.
   *
   * Senza, chi sta scrivendo vede solo il campo di testo diventare inerte e
   * non capisce se è stato zittito lui o se è rotto qualcosa. L'avviso costa
   * un messaggio per canale e toglie di mezzo la metà delle domande allo staff
   * proprio nel momento in cui è più occupato.
   */
  announceLockdown: z.boolean().default(true),

  /** Testo dell'avviso. Variabili: {motivo} {durata} */
  lockdownMessage: z
    .string()
    .max(1500)
    .default(
      '🔒 **Server temporaneamente bloccato**\n' +
        'È in corso un intervento di sicurezza: nessuno può scrivere finché non rientra.\n' +
        'Motivo: {motivo}\n{durata}',
    ),

  /** Testo pubblicato alla revoca, negli stessi canali. */
  lockdownLiftMessage: z
    .string()
    .max(1500)
    .default('🔓 **Blocco rimosso.** Potete tornare a scrivere. Grazie della pazienza.'),

  /**
   * Canali su cui agire per singolo lotto. Discord accetta poche modifiche di
   * permessi al secondo per server: mandarne 200 insieme le fa accodare tutte,
   * e le ultime arrivano dopo minuti — cioè a raid concluso. Un lotto per volta
   * mantiene la latenza prevedibile.
   */
  lockdownBatchSize: z.number().int().min(1).max(50).default(10),

  /**
   * Ban di massa via endpoint bulk (fino a 200 utenti per chiamata) invece di
   * ban singoli: evita il rate limit proprio quando serve velocità.
   */
  useBulkBan: z.boolean().default(true),

  /** Giorni di messaggi da cancellare al ban di un raider (0-7). */
  banDeleteMessageDays: z.number().int().min(0).max(7).default(1),
}).default({});
export type AntiRaidConfig = z.infer<typeof AntiRaidConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   ANTI-NUKE  —  minacce B1, B5
   L'eccesso di permessi è la causa numero uno delle compromissioni: qui si
   contano le azioni distruttive *per singolo attore* e si reagisce subito.
   ═══════════════════════════════════════════════════════════════════════ */
const NukeRule = z.object({
  enabled: z.boolean().default(true),
  threshold: RateThreshold,
  action: ActionKind.default('STRIP_ROLES'),
});

export const AntiNukeConfig = ActiveModuleBase.extend({
  /**
   * Whitelist esplicita. Senza questa lista un bot legittimo che riorganizza i
   * canali verrebbe punito. Gli owner del bot e il proprietario del server sono
   * sempre inclusi.
   */
  whitelist: z
    .object({
      userIds: SnowflakeList,
      roleIds: SnowflakeList,
      botIds: SnowflakeList,
    })
    .default({}),

  rules: z
    .object({
      channelDelete: NukeRule.default({ enabled: true, threshold: { count: 3, windowSec: 20 }, action: 'STRIP_ROLES' }),
      channelCreate: NukeRule.default({ enabled: true, threshold: { count: 8, windowSec: 20 }, action: 'STRIP_ROLES' }),
      roleDelete: NukeRule.default({ enabled: true, threshold: { count: 3, windowSec: 20 }, action: 'STRIP_ROLES' }),
      roleCreate: NukeRule.default({ enabled: true, threshold: { count: 5, windowSec: 20 }, action: 'ALERT_STAFF' }),
      /** Modifica di un ruolo che *aggiunge* permessi pericolosi. */
      roleEscalation: NukeRule.default({ enabled: true, threshold: { count: 1, windowSec: 60 }, action: 'STRIP_ROLES' }),
      memberBan: NukeRule.default({ enabled: true, threshold: { count: 5, windowSec: 30 }, action: 'STRIP_ROLES' }),
      memberKick: NukeRule.default({ enabled: true, threshold: { count: 5, windowSec: 30 }, action: 'STRIP_ROLES' }),
      webhookCreate: NukeRule.default({ enabled: true, threshold: { count: 2, windowSec: 60 }, action: 'ALERT_STAFF' }),
      emojiDelete: NukeRule.default({ enabled: true, threshold: { count: 5, windowSec: 30 }, action: 'ALERT_STAFF' }),
      guildUpdate: NukeRule.default({ enabled: true, threshold: { count: 3, windowSec: 60 }, action: 'ALERT_STAFF' }),
      /** Aggiunta di un'integrazione/bot nuovo. */
      integrationCreate: NukeRule.default({ enabled: true, threshold: { count: 1, windowSec: 60 }, action: 'ALERT_STAFF' }),
    })
    .default({}),

  /**
   * Permessi considerati pericolosi. Chi li possiede è sorvegliato e, in caso
   * di trigger, li perde per primo.
   */
  dangerousPermissions: z
    .array(z.string())
    .default([
      'Administrator',
      'ManageGuild',
      'ManageRoles',
      'ManageChannels',
      'ManageWebhooks',
      'BanMembers',
      'KickMembers',
      'ManageGuildExpressions',
      'MentionEveryone',
    ]),

  /** Snapshot d'emergenza al primo trigger, prima che il danno prosegua. */
  emergencySnapshot: z.boolean().default(true),

  /** Ripristino automatico di canali e ruoli cancellati (dallo snapshot più recente). */
  autoRestore: z.boolean().default(false),

  /** Ban dell'attore oltre allo strip dei ruoli. Irreversibile: default off. */
  banOffender: z.boolean().default(false),
}).default({});
export type AntiNukeConfig = z.infer<typeof AntiNukeConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   ANTI-SPAM
   ═══════════════════════════════════════════════════════════════════════ */
export const AntiSpamConfig = GuardModuleBase.extend({
  messageRate: RateThreshold.default({ count: 6, windowSec: 5 }),
  /** Stesso testo ripetuto, anche in canali diversi. */
  duplicateMessages: RateThreshold.default({ count: 3, windowSec: 30 }),
  /** Stesso messaggio in più canali: firma tipica dello scam bot. */
  crossChannelSpam: RateThreshold.default({ count: 3, windowSec: 20 }),
  /**
   * Immagini e allegati in sequenza.
   *
   * È una forma di spam che il conteggio dei messaggi non intercetta: sei
   * immagini in dieci secondi sono sei messaggi, sotto la soglia del ritmo,
   * ma riempiono lo schermo di chiunque stia leggendo e spingono fuori dalla
   * vista tutto il resto. Nelle campagne di truffa è anche il vettore
   * principale — l'immagine con il QR o il finto premio.
   */
  imageRate: RateThreshold.default({ count: 5, windowSec: 20 }),

  /** Allegati massimi in un singolo messaggio. Discord ne consente dieci. */
  maxAttachmentsPerMessage: z.number().int().min(1).max(10).default(5),

  /**
   * Minuti di messaggi da eliminare quando qualcuno viene silenziato.
   *
   * Silenziare chi ha inondato il canale ferma il seguito ma lascia in piedi
   * ciò che ha già scritto: il canale resta illeggibile e chi arriva dopo
   * trova comunque il muro di messaggi. La pulizia retroattiva è la metà
   * dell'intervento che di solito manca.
   *
   * 0 = non elimina nulla. Discord non consente l'eliminazione in blocco oltre
   * i 14 giorni, ma qui si parla di minuti.
   */
  purgeOnMuteMinutes: z.number().int().min(0).max(1440).default(5),

  mentionsPerMessage: z.number().int().min(1).max(50).default(5),
  mentionRate: RateThreshold.default({ count: 10, windowSec: 30 }),
  maxEmojisPerMessage: z.number().int().min(1).max(200).default(20),
  maxLinesPerMessage: z.number().int().min(1).max(200).default(25),
  /** Percentuale massima di MAIUSCOLE su messaggi lunghi. */
  capsPercent: z.number().int().min(10).max(100).default(80),
  capsMinLength: z.number().int().min(5).max(500).default(20),
  blockZalgo: z.boolean().default(true),
  blockEveryoneAbuse: z.boolean().default(true),
  /** Inviti Discord non autorizzati (vedi anche inviteGuard). */
  blockInvites: z.boolean().default(true),
  /**
   * Sorveglianza rafforzata per chi è entrato da poco: la maggior parte dello
   * spam arriva nella prima ora di permanenza.
   */
  newMemberMinutes: z.number().int().min(0).max(1440).default(60),
  newMemberMultiplier: z.number().min(1).max(5).default(2),

  ladder: ActionLadder.default([
    { atScore: 30, action: 'DELETE_MESSAGE', durationSec: 0 },
    { atScore: 50, action: 'WARN', durationSec: 0 },
    { atScore: 70, action: 'TIMEOUT', durationSec: 600 },
    { atScore: 90, action: 'KICK', durationSec: 0 },
  ]),
}).default({});
export type AntiSpamConfig = z.infer<typeof AntiSpamConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   COMPROMISE DETECTOR  —  minacce A1-A6, C1
   L'ondata "MrBeast" non arriva da account nuovi ma da account *veri e noti*
   che di colpo cambiano comportamento. Serve una baseline per utente.
   ═══════════════════════════════════════════════════════════════════════ */
export const CompromiseConfig = GuardModuleBase.extend({
  /** Utente inattivo da N giorni che riprende a scrivere con link/immagini. */
  dormantDays: z.number().int().min(1).max(365).default(30),
  /** Peso dei singoli segnali nel punteggio finale (0-100). */
  signals: z
    .object({
      dormantThenLink: z.number().int().min(0).max(100).default(35),
      sameMessageManyChannels: z.number().int().min(0).max(100).default(40),
      imageWithUrl: z.number().int().min(0).max(100).default(20),
      knownScamKeywords: z.number().int().min(0).max(100).default(30),
      firstMessageIsLink: z.number().int().min(0).max(100).default(25),
      mentionsEveryoneWithLink: z.number().int().min(0).max(100).default(35),
      /** Il messaggio contiene un QR: quasi mai innocuo in una chat testuale. */
      containsQrCode: z.number().int().min(0).max(100).default(30),
    })
    .default({}),

  /**
   * Parole chiave delle campagne attive. L'elenco è modificabile dal pannello;
   * questi sono i default osservati nelle ondate 2025-2026.
   */
  scamKeywords: z
    .array(z.string())
    .default([
      'mrbeast',
      'andrew tate',
      'free nitro',
      'nitro gratis',
      'steam gift',
      'steam giveaway',
      'connect wallet',
      'claim your',
      'airdrop',
      'casino',
      'promo code',
      '50$ gift',
      'bro check this',
      'try my game',
      'playtest',
      'beta test',
    ]),

  /**
   * Sotto questa soglia il messaggio resta dov'è e si registra soltanto.
   *
   * Prima non esisteva, e un solo segnale bastava a far sparire il messaggio:
   * chi pubblicava una GIF valeva venticinque punti su sessanta e si vedeva
   * eliminare il messaggio comunque. Un sospetto non è un verdetto — se il
   * punteggio non arriva nemmeno a metà strada, la cosa giusta è annotarlo e
   * lasciar parlare la gente.
   */
  deleteAtScore: z.number().int().min(0).max(100).default(45),

  /** Sopra questa soglia scatta la quarantena e la pulizia dei messaggi. */
  quarantineAtScore: z.number().int().min(0).max(100).default(60),
  /** Elimina tutti i messaggi dell'utente nelle ultime N ore. */
  purgeHours: z.number().int().min(0).max(168).default(6),
  /** Avvisa l'utente in DM spiegando come mettere in sicurezza l'account. */
  notifyUser: z.boolean().default(true),
}).default({});
export type CompromiseConfig = z.infer<typeof CompromiseConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   ACCOUNT GUARD  —  minaccia D4 + profilazione account sospetti
   ═══════════════════════════════════════════════════════════════════════ */
export const AccountGuardConfig = GuardModuleBase.extend({
  /** Punti assegnati a ciascun segnale di rischio al join. */
  weights: z
    .object({
      /** Account creato da meno di `newAccountHours`. */
      newAccount: z.number().int().min(0).max(100).default(25),
      noAvatar: z.number().int().min(0).max(100).default(15),
      /** Username tipo `user82736451`, alta entropia o pattern generato. */
      generatedName: z.number().int().min(0).max(100).default(20),
      /** Flag "spammer likely" impostato da Discord. */
      discordSpammerFlag: z.number().int().min(0).max(100).default(40),
      /** Nome o avatar simili a quelli di un membro dello staff. */
      staffImpersonation: z.number().int().min(0).max(100).default(50),
      /** Nome che contiene omoglifi (caratteri cirillici/greci mascherati). */
      homoglyphName: z.number().int().min(0).max(100).default(30),
      /** Nessun badge, nessuna attività, profilo completamente vuoto. */
      emptyProfile: z.number().int().min(0).max(100).default(10),
    })
    .default({}),

  newAccountHours: z.number().int().min(0).max(8760).default(72),

  /** Ruoli considerati "staff" per il confronto anti-impersonificazione. */
  staffRoleIds: SnowflakeList,

  ladder: ActionLadder.default([
    { atScore: 40, action: 'LOG_ONLY', durationSec: 0 },
    { atScore: 60, action: 'ALERT_STAFF', durationSec: 0 },
    { atScore: 80, action: 'REQUIRE_VERIFICATION', durationSec: 0 },
  ]),

  /** Riprofila periodicamente i membri già presenti (cambi nome/avatar). */
  rescanIntervalHours: z.number().int().min(0).max(720).default(24),
}).default({});
export type AccountGuardConfig = z.infer<typeof AccountGuardConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   INVITE GUARD  —  minaccia C3 (invite hijacking)
   Discord consente di riusare codici invito scaduti o liberati come vanity,
   normalizzandoli in minuscolo: i link "storici" pubblicati altrove possono
   finire su un server ostile.
   ═══════════════════════════════════════════════════════════════════════ */
export const InviteGuardConfig = GuardModuleBase.extend({
  /** Risolve ogni invito postato e mostra allo staff nome, età e dimensione del server. */
  resolvePostedInvites: z.boolean().default(true),
  /** Blocca gli inviti verso server non presenti in allowlist. */
  blockUnknownInvites: z.boolean().default(true),
  allowedGuildIds: SnowflakeList,
  /** Consente sempre gli inviti verso il server corrente. */
  allowOwnGuild: z.boolean().default(true),
  /**
   * Sorveglia i propri codici vanity/invito: se uno scade o si libera avvisa,
   * perché diventa immediatamente rivendicabile da un attaccante.
   */
  watchOwnVanity: z.boolean().default(true),
  watchedCodes: z.array(z.string().min(2).max(64)).default([]),
  action: ActionKind.default('DELETE_MESSAGE'),
}).default({});
export type InviteGuardConfig = z.infer<typeof InviteGuardConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   WEBHOOK GUARD  —  minaccia B3
   I webhook Discord sono usati come canale C2 anche da pacchetti npm/PyPI
   compromessi, e permettono messaggi dall'aspetto ufficiale.
   ═══════════════════════════════════════════════════════════════════════ */
export const WebhookGuardConfig = ActiveModuleBase.extend({
  /** Elenco dei webhook approvati (quelli delle personas sono aggiunti in automatico). */
  allowedWebhookIds: SnowflakeList,
  /** Elimina i webhook non in allowlist appena vengono creati. */
  autoDeleteUnknown: z.boolean().default(true),
  /** Inventario periodico di tutti i webhook del server. */
  auditIntervalHours: z.number().int().min(0).max(168).default(6),
  /** Chi può creare webhook legittimamente. */
  allowedCreatorIds: SnowflakeList,
}).default({});
export type WebhookGuardConfig = z.infer<typeof WebhookGuardConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   BOT GUARD  —  minaccia B4
   Un bot con Administrator equivale al server compromesso; il vettore può
   essere una dipendenza avvelenata o l'account dello sviluppatore rubato.
   ═══════════════════════════════════════════════════════════════════════ */
export const BotGuardConfig = ActiveModuleBase.extend({
  /** Avvisa quando un bot entra nel server. */
  alertOnBotJoin: z.boolean().default(true),
  /** Rimuove subito Administrator da qualunque bot che non sia in allowlist. */
  blockAdministrator: z.boolean().default(true),
  allowedBotIds: SnowflakeList,
  /** Espelle i bot aggiunti da chi non è in questa lista. */
  allowedInviterIds: SnowflakeList,
  /** Punteggio di rischio dei permessi, ricalcolato a ogni audit. */
  auditIntervalHours: z.number().int().min(0).max(168).default(12),
  /** Quarantena il bot se supera le soglie anti-nuke (vale anche per i bot). */
  applyAntiNukeToBots: z.boolean().default(true),
}).default({});
export type BotGuardConfig = z.infer<typeof BotGuardConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   SAFETY  —  minacce D1, D2
   Tutela dei minori e link che raccolgono IP. Il bot non vede i DM: qui si
   agisce sui canali e si offre un percorso di segnalazione rapido.
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════
   DOVE SI POSSONO METTERE LINK E GIF

   Questo modulo non c'entra con la sicurezza: un link malevolo lo ferma lo
   scanner, e lo ferma ovunque. Qui si decide una cosa diversa e puramente
   redazionale — in quali canali è ammesso pubblicare link e GIF.

   Nasce da un problema concreto: i canali di annunci e di regolamento che si
   riempiono di link, e la chat generale che diventa un muro di GIF. Non è una
   minaccia, è disordine, e trattarlo come una minaccia sarebbe sbagliato: chi
   incolla un link nel canale sbagliato non è un aggressore.

   Per questo il messaggio viene tolto e basta, con una spiegazione, senza
   punteggi di rischio né sanzioni che si accumulano.
   ═══════════════════════════════════════════════════════════════════════ */
export const LinkPolicyConfig = GuardModuleBase.extend({
  /**
   * Spento di partenza, a differenza degli altri moduli.
   *
   * Le difese arrivano accese perché un server senza difese è esposto. Questa
   * invece è una regola di redazione: accenderla da sola cambierebbe le regole
   * di un server senza che nessuno l'abbia chiesto.
   */
  enabled: z.boolean().default(false),

  /** Canali dove i link sono ammessi. Vuoto = ovunque. */
  linkChannelIds: SnowflakeList,
  /** Canali dove le GIF sono ammesse. Vuoto = ovunque. */
  gifChannelIds: SnowflakeList,

  /**
   * Nei ticket si può sempre.
   *
   * Chi apre un ticket sta descrivendo un problema, e la prova del problema è
   * quasi sempre un link o un'immagine: lo screenshot su un host esterno, il
   * messaggio segnalato, la clip. Vietarli lì significa impedire di spiegarsi
   * proprio nel posto nato per farlo.
   */
  allowInTickets: z.boolean().default(true),

  /**
   * Domini ammessi ovunque, anche fuori dai canali consentiti.
   *
   * Serve per i link di casa — il proprio sito, il proprio canale, la wiki del
   * server — che non ha senso confinare.
   */
  alwaysAllowedDomains: z.array(z.string().max(120)).max(100).default([]),

  /** Spiegazione pubblicata al posto del messaggio tolto. */
  notice: z
    .string()
    .max(500)
    .default('{utente} qui non si possono pubblicare {cosa}. Canali dove si può: {canali}'),
  /** Secondi dopo i quali la spiegazione si cancella da sola. 0 = resta. */
  noticeSeconds: z.number().int().min(0).max(300).default(20),
}).default({});
export type LinkPolicyConfig = z.infer<typeof LinkPolicyConfig>;

export const SafetyConfig = GuardModuleBase.extend({
  /** Rilevamento pattern di adescamento nei canali pubblici. */
  groomingPatterns: z.boolean().default(true),
  /** Canale privato dove finiscono le segnalazioni con le prove congelate. */
  reportChannelId: Snowflake.nullable().default(null),
  /** Ruolo da menzionare per le segnalazioni urgenti. */
  escalationRoleId: Snowflake.nullable().default(null),
  /** Blocca i domini noti per la raccolta di IP (grabify e simili). */
  blockIpGrabbers: z.boolean().default(true),
  ipGrabberDomains: z
    .array(z.string())
    .default([
      'grabify.link',
      'iplogger.org',
      'iplogger.com',
      'blasze.com',
      '2no.co',
      'yip.su',
      'iplis.ru',
      'ipgrabber.ru',
      'ps3cfw.com',
      'stopify.co',
    ]),
  /** Congela le prove (screenshot testuale + metadati) prima di eliminare. */
  preserveEvidence: z.boolean().default(true),
}).default({});
export type SafetyConfig = z.infer<typeof SafetyConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   VERIFICATION  —  gate d'ingresso
   ═══════════════════════════════════════════════════════════════════════ */
export const VerificationConfig = ActiveModuleBase.extend({
  mode: z.enum(['OFF', 'BUTTON', 'CAPTCHA', 'PANEL']).default('BUTTON'),
  /** Ruolo concesso dopo la verifica. */
  verifiedRoleId: Snowflake.nullable().default(null),

  /**
   * Ruolo assegnato a chi entra e non ha ancora verificato.
   *
   * **Distinto dal ruolo di quarantena**, e la distinzione non è formale.
   * Non aver ancora premuto un pulsante è la condizione normale di chiunque
   * arrivi; la quarantena è un provvedimento. Confonderli significa
   * accogliere ogni nuovo membro con un ruolo che dice «sospetto» — e
   * riempire l'elenco dei quarantenati con persone che non hanno fatto
   * nulla, rendendolo inservibile proprio per ciò a cui serve.
   *
   * Diversi anche negli effetti: chi non ha verificato non deve vedere il
   * server, chi è in quarantena lo vede ma non può scrivere — era già dentro
   * e togliergli il contesto non aiuta nessuno.
   */
  unverifiedRoleId: Snowflake.nullable().default(null),

  /**
   * Vecchio campo, mantenuto per le configurazioni già salvate.
   *
   * Fino alla 1.7 il ruolo d'ingresso e quello di quarantena erano lo stesso.
   * Chi aveva già configurato qui un ruolo continua a funzionare senza
   * toccare nulla: viene usato solo se `unverifiedRoleId` è vuoto.
   *
   * @deprecated Usare `unverifiedRoleId`.
   */
  quarantineRoleId: Snowflake.nullable().default(null),
  verifyChannelId: Snowflake.nullable().default(null),
  /** Espelle chi non verifica entro N minuti (0 = mai). */
  kickAfterMinutes: z.number().int().min(0).max(10080).default(0),
  /** Attende N secondi prima di mostrare il pulsante: blocca i bot istantanei. */
  minDelaySec: Seconds(0, 300, 3),
}).default({});
export type VerificationConfig = z.infer<typeof VerificationConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   RUOLI APPICCICOSI

   Chi esce e rientra ritrova i ruoli che aveva. Serve a due cose diverse:
   la comodità (nessuno deve richiedere i ruoli dopo un rientro) e la
   sicurezza — uscire e rientrare è il modo più banale per liberarsi di un
   ruolo di silenziamento o di quarantena, e senza questo modulo funziona.

   I ruoli con permessi pericolosi non vengono mai riassegnati in automatico:
   restituire `ManageRoles` a chi rientra sarebbe una scalata di privilegi
   gratuita per chiunque riesca a farsi assegnare quel ruolo una volta sola.
   ═══════════════════════════════════════════════════════════════════════ */
export const StickyRolesConfig = ActiveModuleBase.extend({
  /** Ruoli da non riassegnare mai (oltre a quelli con permessi pericolosi). */
  excludedRoleIds: SnowflakeList,
  /**
   * Riassegna anche il ruolo di quarantena e quelli di silenziamento.
   * Attivo per impostazione predefinita: è il motivo principale del modulo.
   */
  reapplyPunishments: z.boolean().default(true),
  /** Oltre questi giorni dall'uscita i ruoli non vengono più restituiti. */
  maxAgeDays: z.number().int().min(1).max(3650).default(90),
  /** Attende N secondi dopo l'ingresso prima di riassegnare. */
  delaySec: Seconds(0, 300, 2),
}).default({});
export type StickyRolesConfig = z.infer<typeof StickyRolesConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   LINGUAGGIO  —  parolacce e insulti

   Due difese sovrapposte, che agiscono in momenti diversi.

   La prima è AutoMod di Discord, con i suoi elenchi predefiniti: agisce
   **prima che il messaggio esista**, è multilingue e la mantiene Discord.
   Nessun bot può fare altrettanto, perché un bot il messaggio lo vede solo
   dopo la pubblicazione.

   La seconda è l'elenco proprio, che vede ciò che AutoMod lascia passare —
   le forme elusive, le espressioni locali, gli insulti che non sono
   parolacce. Arriva dopo, ma può graduare la risposta e distinguere lo sfogo
   dall'aggressione rivolta a qualcuno.
   ═══════════════════════════════════════════════════════════════════════ */
export const LanguageCategoryName = z.enum([
  'VOLGARITA',
  'INSULTO',
  'DISCRIMINAZIONE',
  'MINACCIA',
  'AUTOLESIONISMO',
  'BESTEMMIA',
  'SESSUALE',
]);
export type LanguageCategoryName = z.infer<typeof LanguageCategoryName>;

export const LanguageTerm = z.object({
  term: z.string().min(2).max(60),
  severity: z.enum(['LIEVE', 'MEDIA', 'GRAVE']).default('MEDIA'),
  category: LanguageCategoryName.default('INSULTO'),
  /**
   * Cerca anche dentro altre parole. Da usare con parsimonia: è l'opzione che
   * produce i falsi positivi, e un filtro che blocca chi parla di edilizia
   * insegna in un pomeriggio che il bot va ignorato.
   */
  substring: z.boolean().default(false),
});
export type LanguageTerm = z.infer<typeof LanguageTerm>;

export const LanguageConfig = GuardModuleBase.extend({
  /** Filtri predefiniti di Discord: agiscono prima della pubblicazione. */
  usePresetProfanity: z.boolean().default(true),
  usePresetSlurs: z.boolean().default(true),
  usePresetSexual: z.boolean().default(false),

  /**
   * Categorie attive. Le voci delle categorie spente non vengono cercate.
   *
   * Il contenuto sessuale parte spento: su un server di adulti la
   * conversazione può essere legittima, e accenderlo senza chiedere significa
   * moderare una comunità che non si conosce.
   */
  categories: z
    .object({
      VOLGARITA: z.boolean().default(true),
      INSULTO: z.boolean().default(true),
      DISCRIMINAZIONE: z.boolean().default(true),
      MINACCIA: z.boolean().default(true),
      AUTOLESIONISMO: z.boolean().default(true),
      BESTEMMIA: z.boolean().default(true),
      SESSUALE: z.boolean().default(false),
    })
    .default({}),

  /**
   * Elenco proprio. I valori predefiniti coprono l'italiano corrente, divisi
   * per categoria e gravità: sono un punto di partenza ragionevole, non una
   * verità. Si aggiunge, si toglie, si spengono intere categorie.
   */
  terms: z.array(LanguageTerm).max(2000).default(DEFAULT_WORDLIST),

  /**
   * Parole legittime che contengono una voce dell'elenco. Vincono sempre.
   *
   * È l'errore chiamato «Scunthorpe», dal comune inglese che per anni non
   * poté registrarsi online. In italiano capita con gli attrezzi da muratore
   * e con qualche nome di città.
   */
  allowlist: z.array(z.string().min(2).max(60)).max(1000).default(DEFAULT_ALLOWLIST),

  /** Punti per gravità, sommati fino al punteggio del messaggio. */
  weights: z
    .object({
      LIEVE: z.number().int().min(0).max(100).default(15),
      MEDIA: z.number().int().min(0).max(100).default(40),
      GRAVE: z.number().int().min(0).max(100).default(75),
    })
    .default({}),

  /**
   * Punti aggiuntivi se il messaggio menziona qualcuno o risponde a qualcuno.
   *
   * È la differenza fra imprecare e aggredire, e senza questa distinzione il
   * filtro tratta allo stesso modo chi si è dato una martellata sul dito e
   * chi sta insultando un altro membro.
   */
  targetedBonus: z.number().int().min(0).max(100).default(25),

  /**
   * Rimuove sempre il messaggio, qualunque sia il punteggio.
   *
   * Non è una sanzione: è ciò che serve per primo. Finché la frase resta
   * pubblicata continua a fare quello che faceva, e nella versione precedente
   * un insulto grave finiva sull'avvertimento — che non elimina — quindi più
   * l'offesa era grave, più il messaggio restava lì.
   */
  rimuoviSempre: z.boolean().default(true),

  /**
   * Sanzione crescente sulle recidive.
   *
   * Distingue la parola sfuggita dal comportamento. Sanzionare la prima
   * produce risentimento; non sanzionare il secondo produce un canale
   * invivibile.
   */
  recidiva: z
    .object({
      enabled: z.boolean().default(true),

      /**
       * Per quanti minuti si ricorda un'infrazione.
       *
       * La finestra si rinnova a ogni episodio: è «dall'ultima volta», non
       * «dalla prima», altrimenti chi continua uscirebbe dal conteggio solo
       * perché il primo episodio è ormai lontano.
       */
      finestraMinuti: z.number().int().min(5).max(10080).default(120),

      /** Cosa fare alla n-esima infrazione nella finestra. */
      scala: z
        .array(
          z.object({
            infrazioni: z.number().int().min(1).max(50),
            action: ActionKind,
            /** Durata di base, poi moltiplicata per la gravità. */
            durationSec: z.number().int().min(0).max(2419200).default(0),
          }),
        )
        .default([
          // La prima volta il messaggio sparisce e basta: è già successo
          // qualcosa, e aggiungere una sanzione a chi si è lasciato sfuggire
          // una parola insegna solo che il bot è ostile.
          { infrazioni: 2, action: 'WARN', durationSec: 0 },
          { infrazioni: 3, action: 'TIMEOUT', durationSec: 600 },
          { infrazioni: 5, action: 'TIMEOUT', durationSec: 3600 },
          { infrazioni: 8, action: 'TIMEOUT', durationSec: 86400 },
        ]),

      /**
       * Moltiplicatore della durata secondo la gravità peggiore trovata.
       *
       * La stessa recidiva vale dieci minuti per una parolaccia e quaranta per
       * un insulto razzista: la progressione è la stessa, il peso no.
       */
      moltiplicatori: z
        .object({
          LIEVE: z.number().min(0.1).max(10).default(1),
          MEDIA: z.number().min(0.1).max(10).default(2),
          GRAVE: z.number().min(0.1).max(10).default(4),
        })
        .default({}),
    })
    .default({}),

  /** Canali dove il filtro non interviene. */
  exemptChannelIds: SnowflakeList,
}).default({});
export type LanguageConfig = z.infer<typeof LanguageConfig>;


/* ═══════════════════════════════════════════════════════════════════════
   ANTI-FLAME

   Il filtro delle parole guarda un messaggio alla volta; il flame non è un
   messaggio, è uno scambio. Una sola inciviltà basta a innescare una
   discussione che degenera, e da lì ogni risposta è difensiva: chi assiste
   smette di partecipare e il canale resta alle voci più aggressive.

   La prima risposta è **rallentare il canale**, non sanzionare. Silenziare
   chi litiga punisce allo stesso modo chi ha cominciato e chi ha risposto, e
   non impedisce che ricomincino altrove; togliere la rapidità toglie invece
   proprio ciò di cui la spirale si nutre.
   ═══════════════════════════════════════════════════════════════════════ */
export const FlameConfig = GuardModuleBase.extend({
  /** Quanto deve risultare ostile un messaggio per entrare nel conteggio (0-100). */
  sogliaMessaggio: z.number().int().min(10).max(100).default(30),

  /** Quanti messaggi ostili nella finestra fanno scattare l'intervento. */
  messaggiPerScatto: z.number().int().min(2).max(50).default(4),

  /** Ampiezza della finestra, in secondi. */
  finestraSec: z.number().int().min(15).max(600).default(90),

  /** Applica la modalità lenta al canale. È l'intervento principale. */
  rallentaCanale: z.boolean().default(true),
  /** Secondi fra un messaggio e l'altro durante il rallentamento. */
  slowmodeSec: z.number().int().min(3).max(120).default(15),
  /** Per quanto tempo resta, prima che il valore precedente venga ripristinato. */
  durataSlowmodeSec: z.number().int().min(60).max(3600).default(300),

  /** Scrive in canale che sta rallentando e perché. */
  avvisaInCanale: z.boolean().default(true),
  /** Testo dell'avviso. Variabile: {secondi} */
  messaggio: z
    .string()
    .max(1000)
    .default(
      '🔥 **Un attimo.** La discussione si sta scaldando, quindi il canale rallenta a {secondi} ' +
        'secondi per qualche minuto.' +
        String.fromCharCode(10) +
        'Nessuno è nei guai. Se avete qualcosa da chiarire fra voi, fatelo in privato o chiedete ' +
        'a un moderatore di fare da tramite.',
    ),
  /** Cancella l'avviso dopo N secondi. 0 = resta. */
  cancellaAvvisoSec: z.number().int().min(0).max(3600).default(300),

  /**
   * Secondi prima che il modulo possa intervenire di nuovo sullo stesso canale.
   *
   * Senza, un litigio che prosegue produrrebbe un avviso ogni pochi secondi:
   * il canale si riempirebbe di cartellini del bot invece che di conversazione,
   * che è il contrario dell'obiettivo.
   */
  raffreddamentoSec: z.number().int().min(60).max(3600).default(600),

  /** Canali dove il modulo non interviene. */
  exemptChannelIds: SnowflakeList,

  /* ── Vocabolario ─────────────────────────────────────────────────────
     Il modulo riconosce l'aggressione dal *modo*, non dalle parolacce: è la
     differenza fra «che schifo di partita» e «fai schifo». Le espressioni
     stavano scritte nel codice, quindi non erano né leggibili né
     modificabili — e un modulo che decide di rallentare un canale in base a
     un elenco che nessuno può vedere è un modulo di cui non ci si fida.

     Sono volutamente inequivocabili: allargarle troppo significa rallentare
     conversazioni normali, ed è il modo più rapido per farlo spegnere. */

  /**
   * Espressioni rivolte a una persona. Confronto su testo normalizzato: gli
   * accenti, i caratteri strani e le lettere ripetute non aiutano a evaderle.
   */
  frasiOstili: z
    .array(z.string().min(2).max(80))
    .max(500)
    .default([
      'sei un',
      'sei una',
      'sei proprio',
      'fai schifo',
      'fai pena',
      'fai cagare',
      'fai vomitare',
      'non capisci',
      'non hai capito niente',
      'non sai niente',
      'stai zitto',
      'stai zitta',
      'chiudi la bocca',
      'chiudi il becco',
      'vai a cagare',
      'vai a quel paese',
      'vai a farti',
      'ma chi sei',
      'ma chi ti credi',
      'impara a',
      'patetico',
      'patetica',
      'ridicolo',
      'ridicola',
      'nessuno ti',
      'chi ti caga',
      'levati',
      'sparisci',
      'smettila',
      'sei tu il problema',
      'colpa tua',
      'parli a vanvera',
      'non sai di cosa parli',
      'taci',
    ]),

  /**
   * Espressioni che *abbassano* il punteggio: chi le usa sta rimediando.
   *
   * Senza, il messaggio con cui qualcuno chiede scusa nel mezzo di un litigio
   * conta come un colpo in più, e l'intervento arriva proprio quando la
   * discussione stava rientrando da sola.
   */
  frasiDiTregua: z
    .array(z.string().min(2).max(80))
    .max(200)
    .default([
      'scusa',
      'scusate',
      'chiedo scusa',
      'ho sbagliato',
      'hai ragione',
      'non volevo',
      'mi sono espresso male',
      'facciamo pace',
      'lasciamo perdere',
      'va bene dai',
      'ok dai',
    ]),

  /** Quanto pesa un'espressione rivolta a una persona. */
  pesoFrase: z.number().int().min(0).max(100).default(30),
  /** Quanto pesa il messaggio urlato, e solo se già rivolto a qualcuno. */
  pesoUrlato: z.number().int().min(0).max(100).default(15),
  /** Quanto pesa la menzione del destinatario. */
  pesoMenzione: z.number().int().min(0).max(100).default(15),
  /** Quanto pesa la ripetizione della punteggiatura: «ma sei scemo???!!!». */
  pesoPunteggiatura: z.number().int().min(0).max(100).default(10),
  /** Quanto vale una frase di tregua, in negativo. */
  scontoTregua: z.number().int().min(0).max(100).default(25),
}).default({});
export type FlameConfig = z.infer<typeof FlameConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   AUTOMOD SYNC  —  regole native Discord pilotate dal pannello
   ═══════════════════════════════════════════════════════════════════════ */
export const AutoModSyncConfig = ActiveModuleBase.extend({
  /** Mantiene allineate le regole AutoMod native con le blocklist di ANGEL. */
  syncBlockedTerms: z.boolean().default(true),
  /**
   * Regola sul profilo utente con azione QUARANTINE_USER: Discord blocca
   * l'utente prima ancora che possa scrivere. Richiede MODERATE_MEMBERS.
   */
  quarantineOnProfileMatch: z.boolean().default(true),
  /** Attiva i filtri nativi spam e contenuti sessuali. */
  enableNativeSpamFilter: z.boolean().default(true),
  enableMentionSpamFilter: z.boolean().default(true),
  mentionSpamLimit: z.number().int().min(1).max(50).default(10),
}).default({});
export type AutoModSyncConfig = z.infer<typeof AutoModSyncConfig>;
