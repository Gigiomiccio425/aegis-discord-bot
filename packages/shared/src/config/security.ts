import { z } from 'zod';
import {
  ActionKind,
  ActionLadder,
  ActiveModuleBase,
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
export const AntiSpamConfig = ActiveModuleBase.extend({
  messageRate: RateThreshold.default({ count: 6, windowSec: 5 }),
  /** Stesso testo ripetuto, anche in canali diversi. */
  duplicateMessages: RateThreshold.default({ count: 3, windowSec: 30 }),
  /** Stesso messaggio in più canali: firma tipica dello scam bot. */
  crossChannelSpam: RateThreshold.default({ count: 3, windowSec: 20 }),
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
export const CompromiseConfig = ActiveModuleBase.extend({
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
export const AccountGuardConfig = ActiveModuleBase.extend({
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
      /** Account con la stessa impronta di altri entrati nello stesso minuto. */
      joinCluster: z.number().int().min(0).max(100).default(25),
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
export const InviteGuardConfig = ActiveModuleBase.extend({
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
export const SafetyConfig = ActiveModuleBase.extend({
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
  /** Ruolo che isola chi non ha ancora verificato. */
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
