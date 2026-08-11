import { AuditLogEvent, Events, type Client, type GuildAuditLogsEntry } from 'discord.js';
import type { LogEventType } from '@angel/shared';
import { getGuildConfig } from '../core/config.js';
import { childLogger } from '../core/logger.js';
import { inspectAuditEntry } from '../security/antiNuke.js';
import { recordEvent } from '../logging/auditLogger.js';

const log = childLogger('events:auditLog');

/**
 * Registro di controllo di Discord.
 *
 * È l'unica fonte che collega un'azione al suo autore: gli eventi del gateway
 * dicono che un canale è sparito, non chi l'ha eliminato. Tutto l'anti-nuke
 * poggia su questo flusso, e diverse azioni — fissare un messaggio, espellere
 * un membro dall'interfaccia, eliminare un webhook — **esistono solo qui**:
 * senza il registro di controllo non produrrebbero alcun evento.
 *
 * Richiede il permesso `ViewAuditLog`.
 */
export function registerAuditLogEvents(client: Client): void {
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    void (async () => {
      try {
        const config = await getGuildConfig(guild.id);
        await inspectAuditEntry(client, guild, entry, config);
        await attributeAction(client, guild.id, entry);
      } catch (error) {
        log.error({ err: error, action: entry.action }, 'analisi registro di controllo fallita');
      }
    })();
  });
}

/**
 * Azioni con un tipo di evento dedicato.
 *
 * Sono quelle che il gateway non riporta affatto, o che riporta senza autore:
 * meritano una riga propria nel registro invece di finire nel calderone delle
 * azioni generiche.
 */
const DEDICATED: Partial<Record<AuditLogEvent, LogEventType>> = {
  [AuditLogEvent.MessagePin]: 'MESSAGE_PINNED',
  [AuditLogEvent.MessageUnpin]: 'MESSAGE_UNPINNED',
  [AuditLogEvent.MemberKick]: 'MEMBER_KICKED',
  [AuditLogEvent.WebhookDelete]: 'WEBHOOK_DELETED',
  [AuditLogEvent.WebhookUpdate]: 'WEBHOOK_UPDATED',
  [AuditLogEvent.IntegrationCreate]: 'INTEGRATION_CREATED',
  [AuditLogEvent.IntegrationDelete]: 'INTEGRATION_DELETED',
};

/** Azioni senza tipo dedicato di cui vale comunque la pena registrare l'autore. */
const ATTRIBUTION_LABELS: Partial<Record<AuditLogEvent, string>> = {
  [AuditLogEvent.ChannelDelete]: 'eliminazione canale',
  [AuditLogEvent.ChannelCreate]: 'creazione canale',
  [AuditLogEvent.ChannelOverwriteCreate]: 'creazione permessi canale',
  [AuditLogEvent.ChannelOverwriteUpdate]: 'modifica permessi canale',
  [AuditLogEvent.ChannelOverwriteDelete]: 'rimozione permessi canale',
  [AuditLogEvent.RoleDelete]: 'eliminazione ruolo',
  [AuditLogEvent.RoleUpdate]: 'modifica ruolo',
  [AuditLogEvent.MemberRoleUpdate]: 'modifica ruoli di un membro',
  [AuditLogEvent.MemberBanAdd]: 'ban',
  [AuditLogEvent.MemberBanRemove]: 'revoca ban',
  [AuditLogEvent.MemberUpdate]: 'modifica membro',
  [AuditLogEvent.MemberMove]: 'spostamento in vocale',
  [AuditLogEvent.MemberDisconnect]: 'disconnessione dalla vocale',
  [AuditLogEvent.WebhookCreate]: 'creazione webhook',
  [AuditLogEvent.BotAdd]: 'aggiunta di un bot',
  [AuditLogEvent.GuildUpdate]: 'modifica impostazioni server',
  [AuditLogEvent.MessageDelete]: 'eliminazione messaggio altrui',
  [AuditLogEvent.MessageBulkDelete]: 'eliminazione di massa',
  [AuditLogEvent.InviteCreate]: 'creazione invito',
  [AuditLogEvent.InviteDelete]: 'eliminazione invito',
  [AuditLogEvent.EmojiUpdate]: 'modifica emoji',
  [AuditLogEvent.StickerUpdate]: 'modifica sticker',
  [AuditLogEvent.ThreadCreate]: 'creazione thread',
  [AuditLogEvent.ThreadDelete]: 'eliminazione thread',
  [AuditLogEvent.ThreadUpdate]: 'modifica thread',
  [AuditLogEvent.StageInstanceCreate]: 'avvio di uno stage',
  [AuditLogEvent.StageInstanceDelete]: 'chiusura di uno stage',
  [AuditLogEvent.AutoModerationRuleCreate]: 'creazione regola AutoMod',
  [AuditLogEvent.AutoModerationRuleUpdate]: 'modifica regola AutoMod',
  [AuditLogEvent.AutoModerationRuleDelete]: 'eliminazione regola AutoMod',
  [AuditLogEvent.GuildScheduledEventCreate]: 'creazione evento programmato',
  [AuditLogEvent.GuildScheduledEventUpdate]: 'modifica evento programmato',
  [AuditLogEvent.GuildScheduledEventDelete]: 'eliminazione evento programmato',
};

async function attributeAction(
  client: Client,
  guildId: string,
  entry: GuildAuditLogsEntry,
): Promise<void> {
  if (!entry.executorId || entry.executorId === client.user?.id) return;

  const action = entry.action as AuditLogEvent;
  const dedicated = DEDICATED[action];

  if (dedicated) {
    // `extra` contiene i dettagli che il tipo dell'azione non porta con sé:
    // per un pin, il canale e l'ID del messaggio fissato.
    const extra = entry.extra as { channel?: { id: string }; messageId?: string } | undefined;

    await recordEvent(client, {
      guildId,
      type: dedicated,
      actorId: entry.executorId,
      actorTag: entry.executor?.tag ?? null,
      targetId: typeof entry.targetId === 'string' ? entry.targetId : null,
      channelId: extra?.channel?.id ?? null,
      messageId: extra?.messageId ?? null,
      severity: dedicated === 'MEMBER_KICKED' ? 50 : 0,
      summary: describeDedicated(dedicated, entry, extra),
      payload: {
        action,
        reason: entry.reason,
        changes: entry.changes.map((change) => ({
          key: change.key,
          old: change.old,
          new: change.new,
        })),
      },
    });
    return;
  }

  const label = ATTRIBUTION_LABELS[action];
  if (!label) return;

  await recordEvent(client, {
    guildId,
    type: 'PANEL_ACTION',
    actorId: entry.executorId,
    actorTag: entry.executor?.tag ?? null,
    targetId: typeof entry.targetId === 'string' ? entry.targetId : null,
    summary:
      `Azione dal registro di controllo: **${label}**` +
      (entry.reason ? `\nMotivo indicato: ${entry.reason}` : ''),
    payload: {
      action,
      changes: entry.changes.map((change) => ({
        key: change.key,
        old: change.old,
        new: change.new,
      })),
    },
  });
}

function describeDedicated(
  type: LogEventType,
  entry: GuildAuditLogsEntry,
  extra?: { channel?: { id: string }; messageId?: string },
): string {
  switch (type) {
    case 'MESSAGE_PINNED':
      return `Messaggio fissato in <#${extra?.channel?.id ?? '?'}>`;
    case 'MESSAGE_UNPINNED':
      return `Messaggio non più fissato in <#${extra?.channel?.id ?? '?'}>`;
    case 'MEMBER_KICKED':
      return (
        `<@${entry.targetId}> espulso da <@${entry.executorId}>` +
        (entry.reason ? `\nMotivo: ${entry.reason}` : '')
      );
    case 'WEBHOOK_DELETED':
      return `Webhook eliminato da <@${entry.executorId}>`;
    case 'WEBHOOK_UPDATED':
      return `Webhook modificato da <@${entry.executorId}>`;
    case 'INTEGRATION_CREATED':
      return `Integrazione aggiunta da <@${entry.executorId}>`;
    case 'INTEGRATION_DELETED':
      return `Integrazione rimossa da <@${entry.executorId}>`;
    default:
      return '';
  }
}
