import {
  AuditLogEvent,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildAuditLogsEntry,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import { RedisKeys, type GuildConfig } from '@aegis/shared';
import { slidingWindowCount } from '../core/redis.js';
import { childLogger } from '../core/logger.js';
import { isNukeWhitelisted } from '../core/permissions.js';
import { recordEvent } from '../logging/auditLogger.js';
import { stripDangerousRoles } from '../core/enforcer.js';
import { autoRestoreAfterNuke, createSnapshot } from './snapshot.js';

const log = childLogger('antiNuke');

/* ═══════════════════════════════════════════════════════════════════════
   ANTI-NUKE

   Il nuke non è un attacco esterno: arriva sempre da un account che *ha già*
   i permessi. Amministratore con token rubato, oppure moderatore scontento.
   Non c'è nulla da bloccare all'ingresso — si può solo notare che qualcuno sta
   facendo, in venti secondi, ciò che nessuno fa in venti secondi.

   Da qui la forma del modulo: un contatore per attore e per tipo di azione,
   su finestra scorrevole. Superata la soglia, i ruoli con permessi vengono
   rimossi immediatamente e viene salvato uno snapshot d'emergenza.

   La whitelist non è un dettaglio: senza, il primo bot legittimo che
   riorganizza i canali verrebbe disarmato.
   ═══════════════════════════════════════════════════════════════════════ */

type RuleName = keyof GuildConfig['security']['antiNuke']['rules'];

/** Mappa evento del registro di controllo → regola configurata. */
const AUDIT_RULE_MAP: Partial<Record<AuditLogEvent, RuleName>> = {
  [AuditLogEvent.ChannelDelete]: 'channelDelete',
  [AuditLogEvent.ChannelCreate]: 'channelCreate',
  [AuditLogEvent.RoleDelete]: 'roleDelete',
  [AuditLogEvent.RoleCreate]: 'roleCreate',
  [AuditLogEvent.RoleUpdate]: 'roleEscalation',
  [AuditLogEvent.MemberBanAdd]: 'memberBan',
  [AuditLogEvent.MemberKick]: 'memberKick',
  [AuditLogEvent.WebhookCreate]: 'webhookCreate',
  [AuditLogEvent.EmojiDelete]: 'emojiDelete',
  [AuditLogEvent.GuildUpdate]: 'guildUpdate',
  [AuditLogEvent.IntegrationCreate]: 'integrationCreate',
};

const RULE_LABEL: Record<RuleName, string> = {
  channelDelete: 'eliminazione canali',
  channelCreate: 'creazione canali',
  roleDelete: 'eliminazione ruoli',
  roleCreate: 'creazione ruoli',
  roleEscalation: 'aggiunta di permessi pericolosi a un ruolo',
  memberBan: 'ban di membri',
  memberKick: 'espulsione di membri',
  webhookCreate: 'creazione webhook',
  emojiDelete: 'eliminazione emoji',
  guildUpdate: 'modifica impostazioni server',
  integrationCreate: 'aggiunta di integrazioni',
};

/**
 * Valuta una voce del registro di controllo.
 *
 * Il gateway non consegna l'autore delle azioni distruttive: `channelDelete`
 * dice *cosa* è stato cancellato, non *da chi*. L'unica fonte è il registro di
 * controllo, che va quindi interrogato a ogni evento sospetto.
 */
export async function inspectAuditEntry(
  client: Client,
  guild: Guild,
  entry: GuildAuditLogsEntry,
  config: GuildConfig,
): Promise<void> {
  const settings = config.security.antiNuke;
  if (!settings.enabled) return;

  const rule = AUDIT_RULE_MAP[entry.action as AuditLogEvent];
  if (!rule) return;

  const ruleConfig = settings.rules[rule];
  if (!ruleConfig.enabled) return;

  const executorId = entry.executorId;
  if (!executorId || executorId === client.user?.id) return;

  const member = await guild.members.fetch(executorId).catch(() => null);
  if (member && isNukeWhitelisted(member, config)) return;

  // La modifica di un ruolo conta solo se *aggiunge* permessi pericolosi:
  // rinominare un ruolo non è un nuke.
  if (rule === 'roleEscalation' && !isPermissionEscalation(entry, settings.dangerousPermissions)) {
    return;
  }

  const count = await slidingWindowCount(
    RedisKeys.nukeCounter(guild.id, executorId, rule),
    ruleConfig.threshold.windowSec * 1000,
    `${entry.id}`,
  );

  if (count < ruleConfig.threshold.count) return;

  log.error(
    { guildId: guild.id, executorId, rule, count },
    'soglia anti-nuke superata',
  );

  const reason =
    `${RULE_LABEL[rule]}: ${count} azioni in ${ruleConfig.threshold.windowSec} secondi`;

  const prisma = getPrisma();
  const incident = await prisma.incident.create({
    data: {
      guildId: guild.id,
      kind: 'NUKE',
      actorId: executorId,
      peakRate: count,
      summary: reason,
      actionsTaken: [{ rule, action: ruleConfig.action, count }] as object,
    },
  });

  // Lo snapshot d'emergenza va fatto *subito*: se l'attacco prosegue, è la
  // sola copia della struttura ancora integra.
  if (settings.emergencySnapshot) {
    await createSnapshot(guild, 'EMERGENCY', client.user?.id ?? 'system').catch((error) =>
      log.error({ err: error }, 'snapshot d\'emergenza fallito'),
    );
  }

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_NUKE_DETECTED',
    actorId: executorId,
    actorTag: member?.user.tag ?? null,
    severity: 100,
    automated: true,
    summary:
      `💣 **Tentativo di nuke**\n<@${executorId}> — ${reason}\n` +
      `Azione applicata: **${ruleConfig.action}**`,
    payload: { incidentId: incident.id, rule, count, action: ruleConfig.action },
  });

  if (config.general.dryRun) return;

  /**
   * Ripristino automatico.
   *
   * Si esegue **dopo** aver disarmato l'attaccante, mai prima: ricreare i
   * canali mentre qualcuno li sta ancora cancellando è una gara che si perde.
   * Riguarda solo ciò che è sparito di recente, non tutto ciò che manca
   * rispetto allo snapshot.
   */
  if (settings.autoRestore && (rule === 'channelDelete' || rule === 'roleDelete')) {
    // Volutamente non atteso: il ripristino può richiedere decine di secondi e
    // le azioni difensive sull'attore hanno la precedenza.
    void (async () => {
      const restored = await autoRestoreAfterNuke(guild).catch((error) => {
        log.error({ err: error, guildId: guild.id }, 'ripristino automatico fallito');
        return null;
      });
      if (!restored) return;

      const total = restored.rolesRestored.length + restored.channelsRestored.length;
      if (total === 0) return;

      await recordEvent(client, {
        guildId: guild.id,
        type: 'SECURITY_SNAPSHOT_RESTORED',
        actorId: client.user?.id,
        severity: 70,
        automated: true,
        summary:
          `♻️ Ripristino automatico dopo il tentativo di nuke\n` +
          `Ruoli ricreati: ${restored.rolesRestored.length}` +
          (restored.rolesRestored.length > 0 ? ` (${restored.rolesRestored.join(', ')})` : '') +
          `\nCanali ricreati: ${restored.channelsRestored.length}` +
          (restored.channelsRestored.length > 0 ? ` (${restored.channelsRestored.join(', ')})` : '') +
          '\n\n⚠️ I permessi sono stati riapplicati dallo snapshot, ma i **messaggi non tornano**: ' +
          'Discord non lo consente. Restano consultabili nell\'archivio con `/archivio esporta`.',
        payload: restored as unknown as Record<string, unknown>,
      });
    })();
  }

  if (member) {
    switch (ruleConfig.action) {
      case 'STRIP_ROLES':
        await stripDangerousRoles(
          { client, guild, config, member, module: 'antiNuke' },
          `Anti-nuke: ${reason}`,
        );
        if (settings.banOffender) {
          await guild.bans.create(executorId, { reason: `Anti-nuke: ${reason}` }).catch(() => undefined);
        }
        break;
      case 'BAN':
        await guild.bans.create(executorId, { reason: `Anti-nuke: ${reason}` }).catch(() => undefined);
        break;
      case 'KICK':
        await member.kick(`Anti-nuke: ${reason}`).catch(() => undefined);
        break;
      case 'QUARANTINE':
        await stripDangerousRoles(
          { client, guild, config, member, module: 'antiNuke' },
          `Anti-nuke: ${reason}`,
        );
        break;
      default:
        break;
    }
  } else {
    // Nessun membro: è un'applicazione o un utente già uscito. Si può comunque
    // rimuovere l'integrazione o bandire.
    await guild.bans
      .create(executorId, { reason: `Anti-nuke: ${reason}` })
      .catch(() => undefined);
  }
}

/**
 * Riconosce l'aggiunta di permessi pericolosi confrontando i valori prima e
 * dopo riportati dal registro di controllo.
 */
function isPermissionEscalation(
  entry: GuildAuditLogsEntry,
  dangerousPermissions: string[],
): boolean {
  const change = entry.changes.find((c) => c.key === 'permissions');
  if (!change) return false;

  const before = BigInt((change.old as string | undefined) ?? '0');
  const after = BigInt((change.new as string | undefined) ?? '0');
  const added = after & ~before;
  if (added === 0n) return false;

  return dangerousPermissions.some((name) => {
    const flag = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
    return typeof flag === 'bigint' && (added & flag) === flag;
  });
}

/**
 * Sorveglianza dei bot: le stesse soglie valgono per le applicazioni.
 * Un bot compromesso agisce esattamente come un amministratore compromesso, e
 * spesso più in fretta.
 */
export function shouldWatchBot(config: GuildConfig): boolean {
  return config.security.botGuard.enabled && config.security.botGuard.applyAntiNukeToBots;
}
