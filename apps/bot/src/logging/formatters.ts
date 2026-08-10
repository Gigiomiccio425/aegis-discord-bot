import { EmbedBuilder, escapeMarkdown, type APIEmbedField } from 'discord.js';
import { EVENT_CATEGORY, type LogCategory, type LogEventType } from '@aegis/shared';

/** Colore per categoria: rende il canale di log leggibile a colpo d'occhio. */
const CATEGORY_COLOR: Record<LogCategory, number> = {
  MESSAGE: 0x5865f2,
  REACTION: 0x9b59b6,
  MEMBER: 0x2ecc71,
  VOICE: 0x1abc9c,
  CHANNEL: 0x3498db,
  ROLE: 0xe67e22,
  SERVER: 0x95a5a6,
  INVITE: 0xf1c40f,
  WEBHOOK: 0xe91e63,
  MODERATION: 0xe74c3c,
  SECURITY: 0xff0000,
  AUTOMOD: 0xff6b35,
  BOT: 0x7289da,
};

const EVENT_EMOJI: Partial<Record<LogEventType, string>> = {
  MESSAGE_CREATED: '💬',
  MESSAGE_EDITED: '✏️',
  MESSAGE_DELETED: '🗑️',
  MESSAGE_BULK_DELETED: '🧹',
  ATTACHMENT_POSTED: '📎',
  REACTION_ADDED: '➕',
  REACTION_REMOVED: '➖',
  MEMBER_JOINED: '📥',
  MEMBER_LEFT: '📤',
  MEMBER_BANNED: '🔨',
  MEMBER_UNBANNED: '🕊️',
  MEMBER_KICKED: '👢',
  MEMBER_ROLE_ADDED: '🎭',
  MEMBER_ROLE_REMOVED: '🎭',
  MEMBER_TIMED_OUT: '⏳',
  MEMBER_NICKNAME_CHANGED: '🏷️',
  VOICE_JOINED: '🔊',
  VOICE_LEFT: '🔇',
  VOICE_MOVED: '↔️',
  VOICE_STREAM_STARTED: '📺',
  CHANNEL_CREATED: '📁',
  CHANNEL_DELETED: '🗂️',
  ROLE_CREATED: '🆕',
  ROLE_DELETED: '❌',
  ROLE_PERMISSIONS_ESCALATED: '⚠️',
  INVITE_CREATED: '🔗',
  INVITE_POSTED: '🔗',
  INVITE_BLOCKED: '⛔',
  VANITY_AT_RISK: '🚨',
  WEBHOOK_CREATED: '🪝',
  WEBHOOK_UNAUTHORIZED: '🚨',
  BOT_JOINED: '🤖',
  BOT_PERMISSION_RISK: '⚠️',
  SECURITY_RAID_DETECTED: '🚨',
  SECURITY_NUKE_DETECTED: '💣',
  SECURITY_LOCKDOWN_ENABLED: '🔒',
  SECURITY_LOCKDOWN_DISABLED: '🔓',
  SECURITY_QUARANTINE_APPLIED: '🚧',
  SECURITY_COMPROMISE_SUSPECTED: '🕵️',
  SECURITY_SCAM_BLOCKED: '🛡️',
  SECURITY_MALICIOUS_URL: '🔗',
  SECURITY_MALICIOUS_QR: '📵',
  SECURITY_REMOTE_AUTH_QR: '🚨',
  SECURITY_CLICKFIX_BLOCKED: '⌨️',
  SECURITY_MALICIOUS_FILE: '📛',
  SECURITY_IMPERSONATION: '🎭',
  SECURITY_IP_GRABBER: '📡',
  SECURITY_GROOMING_SUSPECTED: '🚨',
  SECURITY_SNAPSHOT_CREATED: '💾',
  SECURITY_SNAPSHOT_RESTORED: '♻️',
  SECURITY_PANIC: '🆘',
  AUTOMOD_TRIGGERED: '🤖',
  MOD_WARN: '⚠️',
  MOD_BAN: '🔨',
  PERSONA_MESSAGE_SENT: '🎭',
  CONFIG_CHANGED: '⚙️',
  PANEL_LOGIN: '🔑',
};

/** Titoli in italiano per il canale di log. */
const EVENT_TITLE: Partial<Record<LogEventType, string>> = {
  MESSAGE_CREATED: 'Messaggio inviato',
  MESSAGE_EDITED: 'Messaggio modificato',
  MESSAGE_DELETED: 'Messaggio eliminato',
  MESSAGE_BULK_DELETED: 'Eliminazione di massa',
  ATTACHMENT_POSTED: 'Allegato inviato',
  REACTION_ADDED: 'Reazione aggiunta',
  REACTION_REMOVED: 'Reazione rimossa',
  REACTION_CLEARED: 'Reazioni azzerate',
  MEMBER_JOINED: 'Ingresso nel server',
  MEMBER_LEFT: 'Uscita dal server',
  MEMBER_BANNED: 'Membro bandito',
  MEMBER_UNBANNED: 'Ban revocato',
  MEMBER_KICKED: 'Membro espulso',
  MEMBER_NICKNAME_CHANGED: 'Nickname modificato',
  MEMBER_AVATAR_CHANGED: 'Avatar modificato',
  MEMBER_USERNAME_CHANGED: 'Username modificato',
  MEMBER_ROLE_ADDED: 'Ruolo assegnato',
  MEMBER_ROLE_REMOVED: 'Ruolo rimosso',
  MEMBER_TIMED_OUT: 'Membro silenziato',
  MEMBER_TIMEOUT_REMOVED: 'Silenziamento rimosso',
  MEMBER_BOOSTED: 'Nuovo boost',
  VOICE_JOINED: 'Ingresso in vocale',
  VOICE_LEFT: 'Uscita dalla vocale',
  VOICE_MOVED: 'Spostamento di canale',
  VOICE_SELF_MUTED: 'Microfono disattivato',
  VOICE_SELF_DEAFENED: 'Audio disattivato',
  VOICE_SERVER_MUTED: 'Silenziato dal server',
  VOICE_STREAM_STARTED: 'Condivisione schermo avviata',
  VOICE_STREAM_STOPPED: 'Condivisione schermo terminata',
  VOICE_SESSION_SUMMARY: 'Riepilogo sessione vocale',
  CHANNEL_CREATED: 'Canale creato',
  CHANNEL_DELETED: 'Canale eliminato',
  CHANNEL_UPDATED: 'Canale modificato',
  CHANNEL_PERMISSIONS_UPDATED: 'Permessi canale modificati',
  THREAD_CREATED: 'Thread creato',
  THREAD_DELETED: 'Thread eliminato',
  ROLE_CREATED: 'Ruolo creato',
  ROLE_DELETED: 'Ruolo eliminato',
  ROLE_UPDATED: 'Ruolo modificato',
  ROLE_PERMISSIONS_ESCALATED: 'Permessi pericolosi aggiunti a un ruolo',
  GUILD_UPDATED: 'Impostazioni server modificate',
  EMOJI_CREATED: 'Emoji aggiunta',
  EMOJI_DELETED: 'Emoji rimossa',
  INVITE_CREATED: 'Invito creato',
  INVITE_DELETED: 'Invito eliminato',
  INVITE_USED: 'Invito utilizzato',
  INVITE_POSTED: 'Invito pubblicato in chat',
  INVITE_BLOCKED: 'Invito bloccato',
  VANITY_AT_RISK: 'Codice invito a rischio dirottamento',
  WEBHOOK_CREATED: 'Webhook creato',
  WEBHOOK_DELETED: 'Webhook eliminato',
  WEBHOOK_UNAUTHORIZED: 'Webhook non autorizzato',
  BOT_JOINED: 'Bot aggiunto al server',
  BOT_LEFT: 'Bot rimosso',
  BOT_PERMISSION_RISK: 'Bot con permessi rischiosi',
  MOD_WARN: 'Avvertimento',
  MOD_MUTE: 'Silenziamento',
  MOD_KICK: 'Espulsione',
  MOD_BAN: 'Ban',
  MOD_PURGE: 'Pulizia messaggi',
  SECURITY_RAID_DETECTED: 'RAID RILEVATO',
  SECURITY_RAID_ENDED: 'Raid terminato',
  SECURITY_NUKE_DETECTED: 'TENTATIVO DI NUKE',
  SECURITY_LOCKDOWN_ENABLED: 'Server in lockdown',
  SECURITY_LOCKDOWN_DISABLED: 'Lockdown revocato',
  SECURITY_QUARANTINE_APPLIED: 'Utente in quarantena',
  SECURITY_QUARANTINE_LIFTED: 'Quarantena revocata',
  SECURITY_ROLES_STRIPPED: 'Ruoli rimossi per sicurezza',
  SECURITY_COMPROMISE_SUSPECTED: 'Sospetto account compromesso',
  SECURITY_SCAM_BLOCKED: 'Contenuto truffaldino bloccato',
  SECURITY_MALICIOUS_URL: 'Link malevolo bloccato',
  SECURITY_MALICIOUS_QR: 'QR malevolo bloccato',
  SECURITY_REMOTE_AUTH_QR: 'QR DI FURTO ACCOUNT BLOCCATO',
  SECURITY_CLICKFIX_BLOCKED: 'Schema ClickFix bloccato',
  SECURITY_MALICIOUS_FILE: 'File pericoloso bloccato',
  SECURITY_IMPERSONATION: 'Tentativo di impersonificazione',
  SECURITY_IP_GRABBER: 'Link raccolta IP bloccato',
  SECURITY_GROOMING_SUSPECTED: 'Sospetto adescamento',
  SECURITY_ACCOUNT_FLAGGED: 'Account segnalato',
  SECURITY_SNAPSHOT_CREATED: 'Backup creato',
  SECURITY_SNAPSHOT_RESTORED: 'Backup ripristinato',
  SECURITY_PANIC: 'PULSANTE DI EMERGENZA',
  AUTOMOD_TRIGGERED: 'AutoMod attivato',
  COMMAND_USED: 'Comando usato',
  CUSTOM_COMMAND_USED: 'Comando personalizzato',
  PERSONA_MESSAGE_SENT: 'Messaggio di una persona',
  CONFIG_CHANGED: 'Configurazione modificata',
  PANEL_LOGIN: 'Accesso al pannello',
  GDPR_DATA_DELETED: 'Dati utente cancellati',
};

export interface LogEventView {
  type: LogEventType;
  createdAt: Date;
  actorId?: string | null;
  actorTag?: string | null;
  targetId?: string | null;
  targetTag?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  summary?: string | null;
  severity?: number;
  fields?: APIEmbedField[];
  guildId: string;
}

export function eventTitle(type: LogEventType): string {
  return `${EVENT_EMOJI[type] ?? '•'} ${EVENT_TITLE[type] ?? type}`;
}

export function categoryColor(type: LogEventType, severity = 0): number {
  // La gravità sovrascrive il colore di categoria: un evento critico deve
  // saltare all'occhio anche in un canale affollato.
  if (severity >= 80) return 0xff0000;
  if (severity >= 50) return 0xff9900;
  return CATEGORY_COLOR[EVENT_CATEGORY[type]] ?? 0x2f3136;
}

/** Costruisce l'embed per il canale di log Discord. */
export function buildLogEmbed(view: LogEventView, options: { showUserIds: boolean }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(categoryColor(view.type, view.severity))
    .setTitle(eventTitle(view.type))
    .setTimestamp(view.createdAt);

  const lines: string[] = [];

  if (view.actorId) {
    lines.push(
      `**Autore:** <@${view.actorId}>` +
        (options.showUserIds ? ` \`${view.actorId}\`` : '') +
        (view.actorTag ? ` (${escapeMarkdown(view.actorTag)})` : ''),
    );
  }
  if (view.targetId && view.targetId !== view.actorId) {
    lines.push(
      `**Interessato:** <@${view.targetId}>` +
        (options.showUserIds ? ` \`${view.targetId}\`` : '') +
        (view.targetTag ? ` (${escapeMarkdown(view.targetTag)})` : ''),
    );
  }
  if (view.channelId) lines.push(`**Canale:** <#${view.channelId}>`);
  if (view.messageId && view.channelId) {
    lines.push(
      `**Messaggio:** [vai al messaggio](https://discord.com/channels/${view.guildId}/${view.channelId}/${view.messageId})`,
    );
  }
  if (view.summary) lines.push(view.summary);

  if (lines.length > 0) embed.setDescription(lines.join('\n').slice(0, 4000));
  if (view.fields?.length) embed.addFields(view.fields.slice(0, 25));
  if (view.severity && view.severity > 0) {
    embed.setFooter({ text: `Gravità ${view.severity}/100` });
  }

  return embed;
}

/** Tronca un contenuto per l'inserimento in un campo dell'embed. */
export function truncate(text: string, max = 1000): string {
  const clean = text.replace(/```/g, "'''");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Blocco di codice sicuro per mostrare contenuti utente senza formattazione attiva. */
export function codeBlock(text: string, max = 1000): string {
  return `\`\`\`\n${truncate(text, max) || '(vuoto)'}\n\`\`\``;
}
