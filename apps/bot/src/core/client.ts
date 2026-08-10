import {
  Client,
  GatewayIntentBits,
  Options,
  Partials,
  type ClientOptions,
} from 'discord.js';
import { childLogger } from './logger.js';

const log = childLogger('client');

/**
 * Intent richiesti.
 *
 * `GuildMessages` + `MessageContent` sono privilegiati. Dal 10 giugno 2026 la
 * soglia per l'approvazione non è più "100 server" ma 10.000 utenti unici
 * raggiunti dall'app; sotto quella soglia bastano gli interruttori nel
 * Developer Portal. La verifica del bot a 100 server resta un procedimento
 * separato, e l'approvazione degli intent va rinnovata ogni anno.
 *
 * Il bot deve funzionare anche senza `MessageContent`: in quel caso lo scanner
 * dei contenuti non può leggere il testo, ma anti-raid, anti-nuke, logging e
 * controllo account continuano a lavorare. Meglio un bot parziale che un bot
 * che non parte.
 */
export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers, // privilegiato: join, ruoli, profili
  GatewayIntentBits.GuildModeration, // ban, unban, azioni AutoMod
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildMessageTyping,
  // Voti nei sondaggi nativi di Discord: senza questo intent i due eventi
  // relativi non arrivano affatto.
  GatewayIntentBits.GuildMessagePolls,
  GatewayIntentBits.MessageContent, // privilegiato: necessario allo scanner
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.AutoModerationExecution,
];

export function buildClientOptions(): ClientOptions {
  return {
    intents: REQUIRED_INTENTS,
    // I partial servono a ricevere gli eventi su oggetti non in cache:
    // senza, un messaggio eliminato dopo un riavvio non produrrebbe alcun log.
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
      Partials.GuildMember,
      Partials.User,
      Partials.ThreadMember,
      Partials.GuildScheduledEvent,
      // Senza questo, i voti ai sondaggi nativi su messaggi non in cache —
      // cioè tutti quelli precedenti l'ultimo riavvio — non arriverebbero.
      Partials.PollAnswer,
    ],
    allowedMentions: { parse: [], repliedUser: false },
    // La cache va tenuta a freno: su server grandi, mantenere tutti i messaggi
    // in memoria porta il processo a diversi gigabyte. Si conservano i ruoli e
    // i membri (indispensabili ai controlli di sicurezza) e poco altro.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 200,
      ReactionManager: 0,
      GuildMemberManager: {
        maxSize: 5000,
        keepOverLimit: (member) => member.id === member.client.user.id,
      },
      UserManager: {
        maxSize: 5000,
        keepOverLimit: (user) => user.id === user.client.user.id,
      },
      PresenceManager: 0,
      ThreadManager: 100,
      GuildInviteManager: 200,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 900 },
      users: {
        interval: 3600,
        filter: () => (user) => user.bot && user.id !== user.client.user.id,
      },
    },
  };
}

export function createClient(): Client {
  const client = new Client(buildClientOptions());

  client.on('error', (error) => log.error({ err: error }, 'errore del client'));
  client.on('warn', (message) => log.warn({ message }, 'avviso del client'));
  client.on('shardError', (error, shardId) =>
    log.error({ err: error, shardId }, 'errore dello shard'),
  );
  client.on('shardDisconnect', (event, shardId) =>
    log.warn({ shardId, code: event.code }, 'shard disconnesso'),
  );
  client.on('shardReconnecting', (shardId) => log.info({ shardId }, 'shard in riconnessione'));

  return client;
}

/** Verifica che gli intent privilegiati siano effettivamente concessi. */
export function checkPrivilegedIntents(client: Client): { messageContent: boolean; members: boolean } {
  const granted = {
    messageContent: client.options.intents.has(GatewayIntentBits.MessageContent),
    members: client.options.intents.has(GatewayIntentBits.GuildMembers),
  };
  if (!granted.messageContent) {
    log.warn(
      'Intent MESSAGE_CONTENT assente: lo scanner dei contenuti non potrà leggere i messaggi. ' +
        'Attivalo nel Developer Portal, sezione Bot → Privileged Gateway Intents.',
    );
  }
  return granted;
}
