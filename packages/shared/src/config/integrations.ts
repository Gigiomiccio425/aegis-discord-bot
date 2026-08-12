import { z } from 'zod';
import { ModuleBase, Snowflake, SnowflakeList } from './common.js';

/* ═══════════════════════════════════════════════════════════════════════
   TWITCH
   Gli avvisi live arrivano via EventSub (webhook firmato HMAC-SHA256), non
   via polling: la notifica è immediata e non consuma rate limit.
   I clip invece richiedono polling, l'API non ha un evento dedicato.
   ═══════════════════════════════════════════════════════════════════════ */
export const TwitchStreamerConfig = z.object({
  /**
   * Sospende questa voce senza cancellarla.
   *
   * Serve per la pausa: uno streamer che non trasmette per un mese, un feed
   * troppo rumoroso in un periodo. Senza, l'unico modo di zittirlo era
   * eliminarlo e riscrivere tutto da capo quando serviva di nuovo.
   */
  enabled: z.boolean().default(true),
  /** Login Twitch (non l'ID numerico: più comodo da inserire nel pannello). */
  login: z.string().min(1).max(64),
  /** ID numerico risolto e memorizzato dal bot. */
  userId: z.string().optional(),
  announceChannelId: Snowflake.nullable().default(null),
  /** Ruolo assegnato mentre lo streamer è in diretta. */
  liveRoleId: Snowflake.nullable().default(null),
  /**
   * L'account Discord dello streamer, a cui dare il ruolo mentre trasmette.
   *
   * Twitch e Discord non hanno niente in comune: il bot sa che il canale
   * Twitch è in diretta, non chi sia quella persona nel server. Senza questo
   * collegamento il ruolo «in diretta» resta configurato e non viene mai dato
   * a nessuno.
   */
  discordUserId: Snowflake.nullable().default(null),
  /** Ruolo da menzionare nell'annuncio. */
  mentionRoleId: Snowflake.nullable().default(null),
  /** Template del messaggio. Variabili: {streamer} {title} {game} {url} {viewers} */
  template: z
    .string()
    .max(2000)
    .default('🔴 **{streamer}** è in diretta!\n**{title}**\n{game}\n{url}'),
  /** Non riannunciare se lo stream era già stato annunciato negli ultimi N minuti. */
  cooldownMinutes: z.number().int().min(0).max(1440).default(60),
  /** Pubblica i nuovi clip che superano questa soglia di visualizzazioni (0 = disattivo). */
  clipMinViews: z.number().int().min(0).max(100000).default(0),
  clipChannelId: Snowflake.nullable().default(null),
});
export type TwitchStreamerConfig = z.infer<typeof TwitchStreamerConfig>;

export const TwitchConfig = ModuleBase.extend({
  streamers: z.array(TwitchStreamerConfig).default([]),
  /** Intervallo di polling per i clip, in minuti. */
  clipPollMinutes: z.number().int().min(5).max(1440).default(15),
}).default({});
export type TwitchConfig = z.infer<typeof TwitchConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   YOUTUBE

   Funziona con il feed RSS ufficiale dei canali
   (`youtube.com/feeds/videos.xml?channel_id=…`): niente chiave API, niente
   quota giornaliera da consumare, e niente approvazioni. È la via più solida
   dopo Twitch, e sopravvive ai cambi di prezzo delle API.

   Il feed elenca gli ultimi 15 caricamenti. Le dirette vi compaiono come video
   normali, quindi vengono riconosciute dal titolo e dalla durata assente.
   ═══════════════════════════════════════════════════════════════════════ */
export const YouTubeChannelConfig = z.object({
  /**
   * Sospende questa voce senza cancellarla.
   *
   * Serve per la pausa: uno streamer che non trasmette per un mese, un feed
   * troppo rumoroso in un periodo. Senza, l'unico modo di zittirlo era
   * eliminarlo e riscrivere tutto da capo quando serviva di nuovo.
   */
  enabled: z.boolean().default(true),
  /** ID del canale (`UC…`), oppure `@handle` o URL: il bot lo risolve. */
  channel: z.string().min(2).max(200),
  /** ID risolto e memorizzato, per non ripetere la risoluzione ogni volta. */
  channelId: z.string().optional(),
  /** Nome mostrato negli annunci, riempito alla prima lettura del feed. */
  displayName: z.string().optional(),
  announceChannelId: Snowflake.nullable().default(null),
  mentionRoleId: Snowflake.nullable().default(null),
  /** Variabili: {autore} {titolo} {url} {tipo} */
  template: z.string().max(2000).default('📺 Nuovo video di **{autore}**\n**{titolo}**\n{url}'),
  /** Annuncia anche le dirette, con un messaggio dedicato. */
  announceLive: z.boolean().default(true),
});
export type YouTubeChannelConfig = z.infer<typeof YouTubeChannelConfig>;

export const YouTubeConfig = ModuleBase.extend({
  channels: z.array(YouTubeChannelConfig).max(50).default([]),
  /** Intervallo di controllo, in minuti. */
  pollMinutes: z.number().int().min(5).max(1440).default(10),
}).default({});
export type YouTubeConfig = z.infer<typeof YouTubeConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   FEED RSS/ATOM

   Un solo modulo che copre decine di fonti: blog, Reddit (`/r/x/.rss`),
   Mastodon, GitHub releases, siti di notizie, podcast. Dove esiste un feed non
   serve un'integrazione dedicata, e i feed non cambiano contratto ogni sei mesi
   come le API dei social.

   Non ci sono TikTok, Instagram e X: non offrono un modo pubblico e stabile di
   leggere i contenuti. Le alternative sarebbero scraping fragile o servizi a
   pagamento, e un'integrazione che si rompe da sola è peggio della sua assenza.
   ═══════════════════════════════════════════════════════════════════════ */
export const RssFeedConfig = z.object({
  /**
   * Sospende questa voce senza cancellarla.
   *
   * Serve per la pausa: uno streamer che non trasmette per un mese, un feed
   * troppo rumoroso in un periodo. Senza, l'unico modo di zittirlo era
   * eliminarlo e riscrivere tutto da capo quando serviva di nuovo.
   */
  enabled: z.boolean().default(true),
  url: z.string().url(),
  /** Nome mostrato negli annunci. Vuoto = titolo del feed. */
  label: z.string().max(100).default(''),
  announceChannelId: Snowflake.nullable().default(null),
  mentionRoleId: Snowflake.nullable().default(null),
  /** Variabili: {titolo} {url} {autore} {fonte} {descrizione} */
  template: z.string().max(2000).default('📰 **{fonte}**\n**{titolo}**\n{url}'),
  /** Pubblica solo le voci il cui titolo contiene una di queste parole. */
  includeKeywords: z.array(z.string().max(60)).max(20).default([]),
  /** Scarta le voci il cui titolo contiene una di queste parole. */
  excludeKeywords: z.array(z.string().max(60)).max(20).default([]),
  /** Voci massime pubblicate per singolo controllo: evita il diluvio iniziale. */
  maxPerCheck: z.number().int().min(1).max(10).default(3),
});
export type RssFeedConfig = z.infer<typeof RssFeedConfig>;

export const RssConfig = ModuleBase.extend({
  feeds: z.array(RssFeedConfig).max(50).default([]),
  pollMinutes: z.number().int().min(5).max(1440).default(15),
}).default({});
export type RssConfig = z.infer<typeof RssConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   SONDAGGI
   Discord ha i poll nativi (semplici, effimeri). Qui si aggiungono quelli
   persistenti: a scadenza, ristretti a ruoli, anonimi, esportabili.
   ═══════════════════════════════════════════════════════════════════════ */
export const PollsConfig = ModuleBase.extend({
  /** Chi può creare sondaggi. Vuoto = chiunque abbia il permesso ManageMessages. */
  creatorRoleIds: SnowflakeList,
  maxOptions: z.number().int().min(2).max(25).default(10),
  maxDurationHours: z.number().int().min(1).max(8760).default(720),
  /** Consente sondaggi anonimi (i voti non sono attribuibili nel pannello). */
  allowAnonymous: z.boolean().default(true),
  /** Registra ogni voto in AuditEvent. Disattivare per i sondaggi anonimi reali. */
  logVotes: z.boolean().default(false),
}).default({});
export type PollsConfig = z.infer<typeof PollsConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   EVENTI PROGRAMMATI
   ═══════════════════════════════════════════════════════════════════════ */
export const EventsConfig = ModuleBase.extend({
  managerRoleIds: SnowflakeList,
  announceChannelId: Snowflake.nullable().default(null),
  /** Promemoria automatici, in minuti prima dell'inizio. */
  reminderMinutes: z.array(z.number().int().min(1).max(10080)).default([1440, 60, 10]),
  /** Ruolo temporaneo assegnato a chi si iscrive. */
  rsvpRoleId: Snowflake.nullable().default(null),
}).default({});
export type EventsConfig = z.infer<typeof EventsConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   GIVEAWAY
   I requisiti d'ingresso non sono un vezzo: senza, ogni giveaway attira
   account monouso creati per l'occasione.
   ═══════════════════════════════════════════════════════════════════════ */
export const GiveawaysConfig = ModuleBase.extend({
  hostRoleIds: SnowflakeList,

  /**
   * Ruolo avvisato a ogni nuovo giveaway, e testo che accompagna il riquadro.
   *
   * Stanno qui e non nel singolo giveaway perché sono una scelta del server,
   * non dell'estrazione: chi indice un giveaway non deve ricordarsi ogni volta
   * quale ruolo si avvisa e con che tono.
   */
  mentionRoleId: Snowflake.nullable().default(null),
  /** Variabili: {premio} {vincitori} {fine} */
  announceTemplate: z.string().max(1000).default(''),
  /** Requisiti predefiniti applicati a ogni nuovo giveaway. */
  defaultRequirements: z
    .object({
      minAccountAgeDays: z.number().int().min(0).max(3650).default(30),
      minMembershipDays: z.number().int().min(0).max(3650).default(7),
      requiredRoleIds: SnowflakeList,
      blockedRoleIds: SnowflakeList,
    })
    .default({}),
  maxWinners: z.number().int().min(1).max(100).default(20),
  maxDurationDays: z.number().int().min(1).max(365).default(30),
}).default({});
export type GiveawaysConfig = z.infer<typeof GiveawaysConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   REACTION ROLES
   ═══════════════════════════════════════════════════════════════════════ */
/*
 * Nessuna opzione «usa i componenti invece delle reazioni»: si usano sempre i
 * menu. Le reazioni hanno tre difetti concreti — si perdono se il messaggio non
 * è in cache, chiunque può aggiungerne di proprie creando confusione, e non
 * permettono di rispondere in privato a chi interagisce. Offrire la scelta
 * significherebbe mantenere una modalità peggiore sotto ogni aspetto.
 */
export const ReactionRolesConfig = ModuleBase.extend({
  /** Vieta di assegnare ruoli con permessi pericolosi tramite questo sistema. */
  blockPrivilegedRoles: z.boolean().default(true),
}).default({});
export type ReactionRolesConfig = z.infer<typeof ReactionRolesConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   BACHECA (STARBOARD)

   I messaggi che la comunità apprezza vengono raccolti in un canale. Sembra
   una funzione frivola, ma ha un effetto concreto sulla moderazione: sposta
   l'attenzione su ciò che il server vuole premiare, invece di lasciarla solo
   su ciò che va punito.
   ═══════════════════════════════════════════════════════════════════════ */
export const StarboardConfig = ModuleBase.extend({
  channelId: Snowflake.nullable().default(null),
  /** Emoji che conta come voto. Unicode oppure `<:nome:id>` per le personalizzate. */
  emoji: z.string().min(1).max(64).default('⭐'),
  /** Reazioni necessarie perché il messaggio finisca in bacheca. */
  threshold: z.number().int().min(1).max(100).default(5),
  /** Canali i cui messaggi non vanno mai in bacheca. */
  ignoredChannelIds: SnowflakeList,
  /**
   * Consente di votare il proprio messaggio. Disattivo per impostazione
   * predefinita: altrimenti bastano quattro amici e l'autore per arrivare a
   * cinque, e la bacheca smette di dire qualcosa.
   */
  allowSelfStar: z.boolean().default(false),
  /** Ignora i messaggi dei bot. */
  ignoreBots: z.boolean().default(true),
  /** Rimuove dalla bacheca il messaggio che scende sotto la soglia. */
  removeBelowThreshold: z.boolean().default(true),
  /** Non promuove i messaggi dei canali con contenuti espliciti. */
  ignoreNsfw: z.boolean().default(true),
}).default({});
export type StarboardConfig = z.infer<typeof StarboardConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   TICKET

   Una conversazione privata fra un utente e lo staff, in un canale creato al
   momento. Serve a togliere dai DM le richieste di assistenza: nei DM non c'è
   registro, non c'è passaggio di consegne fra moderatori, e soprattutto non c'è
   modo di distinguere un moderatore vero da chi si finge tale.
   ═══════════════════════════════════════════════════════════════════════ */
export const TicketsConfig = ModuleBase.extend({
  /** Categoria in cui creare i canali dei ticket. */
  categoryId: Snowflake.nullable().default(null),
  /** Ruoli che vedono e gestiscono i ticket. */
  supportRoleIds: SnowflakeList,
  /** Canale dove pubblicare il pulsante di apertura. */
  panelChannelId: Snowflake.nullable().default(null),

  /**
   * Canale dove finiscono le trascrizioni dei ticket chiusi.
   *
   * Riservato allo staff: una trascrizione contiene per intero una
   * conversazione privata fra una persona e i moderatori, spesso su questioni
   * che quella persona non ha raccontato a nessun altro.
   */
  transcriptChannelId: Snowflake.nullable().default(null),
  /** Quanti ticket aperti può avere la stessa persona. */
  maxOpenPerUser: z.number().int().min(1).max(10).default(1),
  /** Salva la trascrizione alla chiusura ed elimina il canale. */
  transcriptOnClose: z.boolean().default(true),
  /**
   * Chiude i ticket senza attività da N ore (0 = mai). Un ticket dimenticato
   * aperto per settimane è rumore che nasconde quelli veri.
   */
  autoCloseHours: z.number().int().min(0).max(720).default(72),
  /** Messaggio di apertura mostrato nel canale del ticket. */
  welcomeMessage: z
    .string()
    .max(1500)
    .default(
      'Descrivi la tua richiesta con quanti più dettagli possibile. ' +
        'Lo staff risponderà appena disponibile.',
    ),
  /** Menziona i ruoli di supporto all'apertura. */
  pingSupport: z.boolean().default(true),
}).default({});
export type TicketsConfig = z.infer<typeof TicketsConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   INTEGRAZIONI — contenitore
   ═══════════════════════════════════════════════════════════════════════ */
export const IntegrationsConfig = z
  .object({
    twitch: TwitchConfig,
    polls: PollsConfig,
    events: EventsConfig,
    giveaways: GiveawaysConfig,
    reactionRoles: ReactionRolesConfig,
    starboard: StarboardConfig,
    tickets: TicketsConfig,
    youtube: YouTubeConfig,
    rss: RssConfig,
  })
  .default({});
export type IntegrationsConfig = z.infer<typeof IntegrationsConfig>;
