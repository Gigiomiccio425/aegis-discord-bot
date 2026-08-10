import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type Client,
} from 'discord.js';
import { getPrisma, type CaseType } from '@aegis/db';
import {
  RedisKeys,
  type Decision,
  type DecisionAction,
  type GuildConfig,
  type LogEventType,
} from '@aegis/shared';
import { childLogger } from './logger.js';
import { getRedis } from './redis.js';
import { canActOn, dangerousRoles } from './permissions.js';
import { createCase } from './cases.js';
import { recordEvent } from '../logging/auditLogger.js';
import { humanDuration, t } from './i18n.js';

const log = childLogger('enforcer');

export interface EnforceContext {
  client: Client;
  guild: Guild;
  config: GuildConfig;
  /** Membro colpito, quando l'azione riguarda una persona. */
  member?: GuildMember | null;
  /** Messaggio che ha generato la decisione, se presente. */
  message?: Message | null;
  /** Modulo che ha prodotto la decisione, per i log. */
  module: string;
}

/**
 * Esecutore delle decisioni.
 *
 * Tutti i moduli di sicurezza passano da qui, e questo è il punto in cui si
 * applicano tre garanzie trasversali:
 *   • la modalità prova (`dryRun`) blocca ogni sanzione ma non il log;
 *   • ogni azione produce un caso e un evento tracciato;
 *   • un fallimento su Discord (permessi mancanti, gerarchia dei ruoli) non
 *     interrompe le azioni successive.
 */
export async function applyDecision(ctx: EnforceContext, decision: Decision): Promise<void> {
  if (!decision.triggered || decision.actions.length === 0) return;

  const dryRun = ctx.config.general.dryRun;
  const applied: string[] = [];

  for (const action of decision.actions) {
    if (dryRun && action.kind !== 'LOG_ONLY' && action.kind !== 'ALERT_STAFF') {
      applied.push(`${action.kind} (simulata)`);
      continue;
    }
    try {
      const done = await executeAction(ctx, action, decision);
      if (done) applied.push(action.kind);
    } catch (error) {
      log.warn(
        { err: error, action: action.kind, guildId: ctx.guild.id, module: ctx.module },
        'azione non applicata',
      );
    }
  }

  await recordEvent(ctx.client, {
    guildId: ctx.guild.id,
    type: decision.logEvent ?? defaultEventFor(decision.actions[0]?.kind),
    actorId: ctx.member?.id ?? ctx.message?.author.id ?? null,
    actorTag: ctx.member?.user.tag ?? ctx.message?.author.tag ?? null,
    channelId: ctx.message?.channelId ?? null,
    messageId: ctx.message?.id ?? null,
    severity: decision.score,
    automated: true,
    summary:
      `Modulo **${ctx.module}** · punteggio ${decision.score}/100` +
      (dryRun ? '\n⚠️ modalità prova: nessuna sanzione applicata' : '') +
      (applied.length ? `\nAzioni: ${applied.join(', ')}` : ''),
    fields: decision.reasons.slice(0, 10).map((reason) => ({
      name: reason.code,
      value: reason.detail.slice(0, 1024),
      inline: false,
    })),
    payload: {
      module: ctx.module,
      score: decision.score,
      reasons: decision.reasons,
      applied,
      dryRun,
    },
  });
}

async function executeAction(
  ctx: EnforceContext,
  action: DecisionAction,
  decision: Decision,
): Promise<boolean> {
  switch (action.kind) {
    case 'NONE':
    case 'LOG_ONLY':
      return false;

    case 'ALERT_STAFF':
      // L'alert è già prodotto dall'evento finale: qui non serve altro.
      return true;

    case 'DELETE_MESSAGE':
      return deleteMessage(ctx.message ?? null);

    case 'PURGE_RECENT':
      if (!ctx.member) return false;
      return purgeRecent(ctx.guild, ctx.member.id, ctx.config.security.compromise.purgeHours) > 0;

    case 'WARN':
      if (!ctx.member) return false;
      await notifyMember(ctx, 'mod.warned', action.reason);
      await openCase(ctx, 'WARN', action.reason, decision);
      return true;

    case 'TIMEOUT': {
      if (!ctx.member) return false;
      const seconds = Math.min(action.durationSec ?? 600, 2419200); // massimo Discord: 28 giorni
      if (!canActOn(await ctx.guild.members.fetchMe(), ctx.member)) return false;
      await ctx.member.timeout(seconds * 1000, truncateReason(action.reason));
      await notifyMember(ctx, 'mod.muted', action.reason, humanDuration(seconds));
      await openCase(ctx, 'MUTE', action.reason, decision, new Date(Date.now() + seconds * 1000));
      return true;
    }

    case 'QUARANTINE':
      if (!ctx.member) return false;
      return quarantineMember(ctx, action.reason, decision);

    case 'STRIP_ROLES':
      if (!ctx.member) return false;
      return stripDangerousRoles(ctx, action.reason, decision);

    case 'KICK': {
      if (!ctx.member) return false;
      if (!canActOn(await ctx.guild.members.fetchMe(), ctx.member)) return false;
      await notifyMember(ctx, 'mod.kicked', action.reason);
      await ctx.member.kick(truncateReason(action.reason));
      await openCase(ctx, 'KICK', action.reason, decision);
      return true;
    }

    case 'BAN': {
      const targetId = ctx.member?.id ?? ctx.message?.author.id;
      if (!targetId) return false;
      if (ctx.member && !canActOn(await ctx.guild.members.fetchMe(), ctx.member)) return false;
      await notifyMember(ctx, 'mod.banned', action.reason);
      await ctx.guild.bans.create(targetId, {
        reason: truncateReason(action.reason),
        deleteMessageSeconds: 24 * 3600,
      });
      await openCase(ctx, 'BAN', action.reason, decision);
      return true;
    }

    case 'LOCKDOWN':
      await enableLockdown(ctx.client, ctx.guild, ctx.config, action.reason, action.durationSec ?? 0);
      return true;

    case 'REQUIRE_VERIFICATION':
      if (!ctx.member) return false;
      return requireVerification(ctx);

    default:
      return false;
  }
}

/* ── Azioni ───────────────────────────────────────────────────────────── */

async function deleteMessage(message: Message | null): Promise<boolean> {
  if (!message || !message.deletable) return false;
  try {
    await message.delete();
    return true;
  } catch (error) {
    // 10008 = messaggio già eliminato: succede spesso quando due moduli
    // reagiscono allo stesso contenuto, e non è un errore.
    if (error instanceof DiscordAPIError && error.code === 10008) return true;
    throw error;
  }
}

/**
 * Quarantena: si rimuovono tutti i ruoli e si assegna quello isolante.
 *
 * I ruoli precedenti vengono salvati nel profilo utente, altrimenti annullare
 * un falso positivo significherebbe ricostruirli a mano — inaccettabile dopo un
 * raid che ha coinvolto decine di persone.
 */
export async function quarantineMember(
  ctx: EnforceContext,
  reason: string,
  decision?: Decision,
): Promise<boolean> {
  const member = ctx.member;
  if (!member) return false;

  const roleId =
    ctx.config.general.quarantineRoleId ?? ctx.config.security.verification.quarantineRoleId;
  if (!roleId) {
    log.warn({ guildId: ctx.guild.id }, 'ruolo di quarantena non configurato');
    return false;
  }

  const me = await ctx.guild.members.fetchMe();
  if (!canActOn(me, member)) return false;

  const previousRoles = member.roles.cache
    .filter((role) => role.id !== ctx.guild.id && !role.managed)
    .map((role) => role.id);

  const prisma = getPrisma();
  await prisma.userProfile.upsert({
    where: { guildId_userId: { guildId: ctx.guild.id, userId: member.id } },
    create: {
      guildId: ctx.guild.id,
      userId: member.id,
      quarantinedAt: new Date(),
      quarantineReason: reason,
      rolesBeforeQuarantine: previousRoles,
    },
    update: {
      quarantinedAt: new Date(),
      quarantineReason: reason,
      rolesBeforeQuarantine: previousRoles,
    },
  });

  await member.roles.set([roleId], truncateReason(reason));
  await notifyMember(ctx, 'mod.quarantined', reason);
  if (decision) await openCase(ctx, 'QUARANTINE', reason, decision);

  await recordEvent(ctx.client, {
    guildId: ctx.guild.id,
    type: 'SECURITY_QUARANTINE_APPLIED',
    actorId: ctx.client.user?.id,
    targetId: member.id,
    targetTag: member.user.tag,
    severity: 70,
    automated: true,
    summary: `Quarantena applicata: ${reason}`,
    payload: { previousRoles, module: ctx.module },
  });
  return true;
}

/** Restituisce i ruoli salvati prima della quarantena. */
export async function liftQuarantine(
  client: Client,
  guild: Guild,
  userId: string,
  actorId: string,
): Promise<boolean> {
  const prisma = getPrisma();
  const profile = await prisma.userProfile.findUnique({
    where: { guildId_userId: { guildId: guild.id, userId } },
  });
  if (!profile?.quarantinedAt) return false;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    const restorable = profile.rolesBeforeQuarantine.filter((roleId) => guild.roles.cache.has(roleId));
    await member.roles.set(restorable, 'Quarantena revocata').catch(() => undefined);
  }

  await prisma.userProfile.update({
    where: { guildId_userId: { guildId: guild.id, userId } },
    data: { quarantinedAt: null, quarantineReason: null, rolesBeforeQuarantine: [] },
  });

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_QUARANTINE_LIFTED',
    actorId,
    targetId: userId,
    summary: 'Quarantena revocata, ruoli precedenti ripristinati',
  });
  return true;
}

/**
 * Risposta all'anti-nuke: si tolgono i ruoli che concedono permessi pericolosi,
 * lasciando quelli innocui. L'obiettivo è fermare il danno in corso, non
 * espellere la persona — che potrebbe essere una vittima del furto di token,
 * non l'attaccante.
 */
export async function stripDangerousRoles(
  ctx: EnforceContext,
  reason: string,
  decision?: Decision,
): Promise<boolean> {
  const member = ctx.member;
  if (!member) return false;

  const me = await ctx.guild.members.fetchMe();
  if (!canActOn(me, member)) {
    log.error(
      { guildId: ctx.guild.id, target: member.id },
      'impossibile rimuovere i ruoli: il bersaglio ha una posizione superiore al bot',
    );
    return false;
  }

  const toRemove = dangerousRoles(member, ctx.config.security.antiNuke.dangerousPermissions);
  if (toRemove.length === 0) return false;

  await member.roles.remove(toRemove, truncateReason(reason));

  const prisma = getPrisma();
  await prisma.userProfile.upsert({
    where: { guildId_userId: { guildId: ctx.guild.id, userId: member.id } },
    create: { guildId: ctx.guild.id, userId: member.id, rolesBeforeQuarantine: toRemove },
    update: { rolesBeforeQuarantine: toRemove },
  });

  if (decision) await openCase(ctx, 'ROLE_STRIP', reason, decision);

  await recordEvent(ctx.client, {
    guildId: ctx.guild.id,
    type: 'SECURITY_ROLES_STRIPPED',
    actorId: ctx.client.user?.id,
    targetId: member.id,
    targetTag: member.user.tag,
    severity: 90,
    automated: true,
    summary: `Rimossi ${toRemove.length} ruoli con permessi pericolosi: ${reason}`,
    payload: { removedRoles: toRemove, module: ctx.module },
  });
  return true;
}

/**
 * Elimina i messaggi recenti di un utente.
 *
 * Serve contro gli account compromessi: quando parte l'ondata di messaggi con
 * link, fermare l'autore non basta — quanto già pubblicato continua a fare
 * danno finché resta leggibile.
 */
export function purgeRecent(guild: Guild, userId: string, hours: number): number {
  if (hours <= 0) return 0;
  const since = Date.now() - hours * 3600 * 1000;
  let deleted = 0;

  const channels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.PublicThread,
  );

  // Volutamente non atteso: la pulizia può richiedere secondi e non deve
  // rallentare la quarantena, che è l'azione urgente.
  void (async () => {
    for (const channel of channels.values()) {
      if (!channel.isTextBased()) continue;
      const me = await guild.members.fetchMe();
      if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) continue;

      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages) continue;

      const targets = messages.filter(
        (message) => message.author.id === userId && message.createdTimestamp >= since,
      );
      if (targets.size === 0) continue;

      // bulkDelete non funziona sui messaggi più vecchi di 14 giorni.
      await channel.bulkDelete(targets, true).catch(() => undefined);
      deleted += targets.size;
    }
  })();

  return deleted;
}

/**
 * Lockdown: canali pubblici in sola lettura e inviti in pausa.
 *
 * La pausa degli inviti è la parte decisiva: senza, i nuovi account continuano
 * ad arrivare mentre si ripulisce quanto già entrato.
 */
export async function enableLockdown(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  reason: string,
  durationSec: number,
): Promise<void> {
  const redis = getRedis();
  const key = RedisKeys.lockdown(guild.id);
  if (await redis.exists(key)) return; // già attivo

  const affected: string[] = [];

  if (config.security.antiRaid.lockChannels) {
    const everyone = guild.roles.everyone;
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildText) continue;
      if (config.security.antiRaid.lockdownExemptChannels.includes(channel.id)) continue;

      const current = channel.permissionOverwrites.cache.get(everyone.id);
      if (current?.deny.has(PermissionFlagsBits.SendMessages)) continue;

      await channel.permissionOverwrites
        .edit(everyone, { SendMessages: false }, { reason: truncateReason(reason) })
        .then(() => affected.push(channel.id))
        .catch(() => undefined);
    }
  }

  if (config.security.antiRaid.pauseInvites) {
    // `invitesDisabled` è la pausa inviti nativa di Discord.
    await guild.disableInvites(true).catch(() => undefined);
  }

  await redis.set(
    key,
    JSON.stringify({ reason, channels: affected, startedAt: Date.now() }),
    'EX',
    durationSec > 0 ? durationSec + 60 : 86400,
  );

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_LOCKDOWN_ENABLED',
    actorId: client.user?.id,
    severity: 95,
    automated: true,
    summary: `🔒 Server bloccato: ${reason}\nCanali interessati: ${affected.length}`,
    payload: { channels: affected, durationSec },
  });

  if (durationSec > 0) {
    setTimeout(() => {
      void disableLockdown(client, guild, 'scadenza automatica');
    }, durationSec * 1000);
  }
}

export async function disableLockdown(
  client: Client,
  guild: Guild,
  reason: string,
): Promise<boolean> {
  const redis = getRedis();
  const key = RedisKeys.lockdown(guild.id);
  const raw = await redis.get(key);
  if (!raw) return false;

  const state = JSON.parse(raw) as { channels: string[] };
  const everyone = guild.roles.everyone;

  for (const channelId of state.channels) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    // Si rimuove solo il divieto aggiunto dal lockdown, non l'intero overwrite:
    // sovrascriverlo cancellerebbe permessi impostati dallo staff.
    await channel.permissionOverwrites
      .edit(everyone, { SendMessages: null }, { reason: truncateReason(reason) })
      .catch(() => undefined);
  }

  await guild.disableInvites(false).catch(() => undefined);
  await redis.del(key);

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_LOCKDOWN_DISABLED',
    actorId: client.user?.id,
    summary: `🔓 Lockdown revocato: ${reason}`,
  });
  return true;
}

export async function isLockedDown(guildId: string): Promise<boolean> {
  return (await getRedis().exists(RedisKeys.lockdown(guildId))) === 1;
}

async function requireVerification(ctx: EnforceContext): Promise<boolean> {
  const roleId = ctx.config.security.verification.quarantineRoleId ?? ctx.config.general.quarantineRoleId;
  if (!roleId || !ctx.member) return false;
  await ctx.member.roles.add(roleId, 'Verifica richiesta dal controllo account').catch(() => undefined);
  return true;
}

/* ── Utilità ──────────────────────────────────────────────────────────── */

async function openCase(
  ctx: EnforceContext,
  type: CaseType,
  reason: string,
  decision: Decision,
  expiresAt?: Date,
): Promise<void> {
  const targetId = ctx.member?.id ?? ctx.message?.author.id;
  if (!targetId) return;

  await createCase({
    guildId: ctx.guild.id,
    type,
    targetId,
    targetTag: ctx.member?.user.tag ?? ctx.message?.author.tag ?? null,
    actorId: ctx.client.user?.id ?? 'system',
    actorTag: ctx.client.user?.tag ?? 'Aegis',
    reason: reason.slice(0, 1000),
    automated: true,
    module: ctx.module,
    evidence: {
      score: decision.score,
      reasons: decision.reasons,
      messageId: ctx.message?.id,
      channelId: ctx.message?.channelId,
      content: ctx.message?.content?.slice(0, 2000),
    },
    expiresAt: expiresAt ?? null,
  }).catch((error) => log.warn({ err: error }, 'apertura caso fallita'));
}

/** Avvisa in privato. Se l'utente ha i DM chiusi non è un errore. */
async function notifyMember(
  ctx: EnforceContext,
  key: string,
  reason: string,
  duration?: string,
): Promise<void> {
  if (!ctx.member) return;
  const locale = ctx.config.general.locale;
  const text = t(locale, key, {
    guild: ctx.guild.name,
    reason: reason.slice(0, 500),
    duration: duration ?? '',
  });
  await ctx.member.send(text).catch(() => undefined);
}

function truncateReason(reason: string): string {
  // L'header X-Audit-Log-Reason ha un limite di 512 caratteri.
  return reason.slice(0, 500);
}

function defaultEventFor(kind?: string): LogEventType {
  switch (kind) {
    case 'BAN':
      return 'MOD_BAN';
    case 'KICK':
      return 'MOD_KICK';
    case 'TIMEOUT':
      return 'MOD_MUTE';
    case 'WARN':
      return 'MOD_WARN';
    case 'QUARANTINE':
      return 'SECURITY_QUARANTINE_APPLIED';
    case 'STRIP_ROLES':
      return 'SECURITY_ROLES_STRIPPED';
    case 'LOCKDOWN':
      return 'SECURITY_LOCKDOWN_ENABLED';
    default:
      return 'SECURITY_SCAM_BLOCKED';
  }
}
