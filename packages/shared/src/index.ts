export * from './config/index.js';
export * from './types/events.js';
export * from './types/decision.js';
export * from './types/customCommands.js';
export * from './util/text.js';
export * from './env.js';

/** Chiavi Redis, centralizzate per evitare collisioni fra bot, api e worker. */
export const RedisKeys = {
  /** Configurazione di un server, in cache. */
  guildConfig: (guildId: string) => `cfg:${guildId}`,
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

  urlVerdict: (url: string) => `url:${url}`,
  phashSeen: (guildId: string) => `phash:${guildId}`,

  cooldown: (guildId: string, commandName: string, userId: string) =>
    `cd:${guildId}:${commandName}:${userId}`,

  lastSeen: (guildId: string, userId: string) => `seen:${guildId}:${userId}`,
} as const;

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
} as const;
