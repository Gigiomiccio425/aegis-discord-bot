export * from './config/index.js';
export * from './types/events.js';
export * from './types/decision.js';
export * from './types/customCommands.js';
export * from './util/text.js';
export * from './util/json.js';
// In fondo alle altre: importa RedisKeys, definito più sotto in questo file.
export * from './version.js';
export * from './env.js';

/** Chiavi Redis, centralizzate per evitare collisioni fra bot, api e worker. */
export const RedisKeys = {
  /** Configurazione di un server, in cache. */
  guildConfig: (guildId: string) => `cfg:${guildId}`,
  /**
   * Canali e ruoli del server, scritti dal bot e letti dal pannello.
   *
   * Il pannello non è connesso a Discord: senza questa copia, configurare un
   * canale significa incollarne l'ID a mano, che è come si finisce per salvare
   * l'ID sbagliato senza accorgersene.
   */
  guildInventory: (guildId: string) => `inv:${guildId}`,
  /** Canale pub/sub su cui il pannello annuncia i cambi di configurazione. */
  configChannel: 'aegis:config',
  /** Canale pub/sub per i comandi dal pannello al bot (lockdown, panic…). */
  commandChannel: 'aegis:command',
  /** Canale pub/sub per il feed live verso il pannello. */
  eventChannel: 'aegis:events',

  joinWindow: (guildId: string) => `raid:joins:${guildId}`,
  raidState: (guildId: string) => `raid:state:${guildId}`,
  lockdown: (guildId: string) => `lockdown:${guildId}`,

  nukeCounter: (guildId: string, actorId: string, rule: string) =>
    `nuke:${guildId}:${actorId}:${rule}`,

  spamMessages: (guildId: string, userId: string) => `spam:msg:${guildId}:${userId}`,
  spamFingerprints: (guildId: string, userId: string) => `spam:fp:${guildId}:${userId}`,
  spamMentions: (guildId: string, userId: string) => `spam:mention:${guildId}:${userId}`,
  spamImages: (guildId: string, userId: string) => `spam:img:${guildId}:${userId}`,

  urlVerdict: (url: string) => `url:${url}`,
  phashSeen: (guildId: string) => `phash:${guildId}`,

  cooldown: (guildId: string, commandName: string, userId: string) =>
    `cd:${guildId}:${commandName}:${userId}`,

  lastSeen: (guildId: string, userId: string) => `seen:${guildId}:${userId}`,

  /**
   * Versione dichiarata da ciascun processo, con scadenza.
   *
   * Serve a rendere visibile un disallineamento che altrimenti non si vede:
   * i quattro servizi usano la stessa immagine ma sono container distinti, e
   * un aggiornamento può ricrearne tre su quattro. Da fuori tutto sembra a
   * posto, mentre un pezzo continua a girare con il codice di prima.
   *
   * La chiave scade: un servizio spento smette di comparire da solo, invece
   * di restare per sempre nell'elenco come se fosse ancora vivo.
   */
  serviceVersion: (service: string) => `version:${service}`,
} as const;

/** Ogni quanto ciascun processo riafferma la propria versione, in secondi. */
export const VERSION_HEARTBEAT_SEC = 60;
/** Dopo quanto un servizio che tace sparisce dall'elenco. */
export const VERSION_TTL_SEC = 180;

/** Nomi delle code BullMQ. */
export const Queues = {
  deepScan: 'deep-scan',
  snapshot: 'snapshot',
  threatFeeds: 'threat-feeds',
  twitch: 'twitch',
  retention: 'retention',
  logDelivery: 'log-delivery',
  /** Scadenze di sondaggi e giveaway: richiede precisione al minuto. */
  integrations: 'integrations',
  /** Revisione periodica di webhook e bot, con intervallo per server. */
  securityAudit: 'security-audit',
  /** Fonti esterne: YouTube e feed RSS. */
  social: 'social',
  /** Copia dei propri dati fuori dal volume dell'applicazione. */
  selfBackup: 'self-backup',
  /** Rapporto giornaliero a chi possiede il bot. */
  rapporto: 'rapporto',
} as const;
