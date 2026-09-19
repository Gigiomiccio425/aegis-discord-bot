import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type Client,
} from 'discord.js';
import { getPrisma, type CaseType } from '@angel/db';
import {
  RedisKeys,
  type Decision,
  type DecisionAction,
  type GuildConfig,
  type LogEventType,
} from '@angel/shared';
import { childLogger } from './logger.js';
import { getRedis } from './redis.js';
import { canActOn, dangerousRoles } from './permissions.js';
import { createCase } from './cases.js';
import { descriviErroreDiscord } from './erroriDiscord.js';
import { recordEvent } from '../logging/auditLogger.js';
import { humanDuration, t } from './i18n.js';
import { unverifiedRoleId } from '@angel/shared';

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

  await announceAction(ctx, decision, applied, dryRun).catch((error) =>
    log.debug({ err: error }, 'avviso pubblico non pubblicato'),
  );

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

    case 'PURGE_RECENT': {
      const targetId = ctx.member?.id ?? ctx.message?.author.id;
      if (!targetId) return false;
      // `durationSec` dice quanto indietro andare. Senza, ogni pulizia usava
      // le ore del modulo account compromessi — sei ore anche quando chi
      // chiamava intendeva cinque minuti.
      const secondi =
        action.durationSec && action.durationSec > 0
          ? action.durationSec
          : ctx.config.security.compromise.purgeHours * 3600;
      return purgeRecent(ctx.guild, targetId, secondi) > 0;
    }

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

  // Solo il ruolo di quarantena. Ripiegare su quello di verifica farebbe
  // uscire dalla sanzione chiunque prema il pulsante di verifica.
  const roleId = ctx.config.general.quarantineRoleId;
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

  // I ruoli gestiti — il booster, quelli delle integrazioni — restano: il bot
  // non può toglierli, e includerli è ciò che distingue una sostituzione che
  // Discord accetta da una che rifiuta per intero.
  const gestiti = member.roles.cache.filter((role) => role.managed).map((role) => role.id);
  try {
    await member.roles.set([roleId, ...gestiti], truncateReason(reason));
  } catch (error) {
    // Il profilo non deve dire «in quarantena» di chi non lo è: il pannello
    // lo elencherebbe fra gli isolati e il pulsante di revoca non avrebbe
    // niente da revocare.
    await prisma.userProfile
      .update({
        where: { guildId_userId: { guildId: ctx.guild.id, userId: member.id } },
        data: { quarantinedAt: null, quarantineReason: null, rolesBeforeQuarantine: [] },
      })
      .catch(() => undefined);
    throw error;
  }
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
  return (await revocaQuarantena(client, guild, userId, actorId)).ok;
}

/**
 * Come `liftQuarantine`, ma dice perché quando non riesce.
 *
 * Prima un rifiuto di Discord — il ruolo del bot sotto quello della persona,
 * per esempio — finiva in un `catch` vuoto: il profilo veniva segnato «non
 * più in quarantena», il registro diceva «ruoli ripristinati», e la persona
 * restava isolata. Il pannello rispondeva «fatto» e nessuno sapeva perché
 * lei continuasse a non vedere i canali.
 */
export async function revocaQuarantena(
  client: Client,
  guild: Guild,
  userId: string,
  actorId: string,
): Promise<{ ok: boolean; motivo?: string }> {
  const prisma = getPrisma();
  const profile = await prisma.userProfile.findUnique({
    where: { guildId_userId: { guildId: guild.id, userId } },
  });
  if (!profile?.quarantinedAt) return { ok: false, motivo: 'non risulta in quarantena' };

  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    const restorable = profile.rolesBeforeQuarantine.filter((roleId) => {
      const role = guild.roles.cache.get(roleId);
      return role !== undefined && !role.managed;
    });
    // I ruoli gestiti che ha adesso restano: il bot non può toglierli, e
    // ometterli farebbe rifiutare a Discord l'intera sostituzione.
    const gestiti = member.roles.cache.filter((role) => role.managed).map((role) => role.id);
    try {
      await member.roles.set([...new Set([...restorable, ...gestiti])], 'Quarantena revocata');
    } catch (error) {
      return { ok: false, motivo: descriviErroreDiscord(error) };
    }
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
    summary: member
      ? 'Quarantena revocata, ruoli precedenti ripristinati'
      : 'Quarantena revocata: la persona non è più nel server, al rientro non risulterà isolata',
  });
  return { ok: true };
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

  // Il registro elenca ruolo per ruolo quali permessi pericolosi sono stati
  // tolti. «Rimossi 3 ruoli» non basta a nessuno: chi rivede l'incidente deve
  // poter dire se la persona aveva davvero i mezzi per fare il danno, e chi
  // deve rimettere le cose a posto deve sapere cosa restituire.
  const detail = toRemove.map((roleId) => {
    const role = ctx.guild.roles.cache.get(roleId);
    if (!role) return `\`${roleId}\` (ruolo non più esistente)`;
    const dangerous = role.permissions
      .toArray()
      .filter((permission) => ctx.config.security.antiNuke.dangerousPermissions.includes(permission));
    return `**${role.name}** → ${dangerous.join(', ') || 'nessun permesso pericoloso residuo'}`;
  });

  await recordEvent(ctx.client, {
    guildId: ctx.guild.id,
    type: 'SECURITY_ROLES_STRIPPED',
    actorId: ctx.client.user?.id,
    targetId: member.id,
    targetTag: member.user.tag,
    severity: 90,
    automated: true,
    summary:
      `Rimossi ${toRemove.length} ruoli a <@${member.id}>: ${reason}\n\n` +
      detail.slice(0, 10).join('\n') +
      (detail.length > 10 ? `\n…e altri ${detail.length - 10}` : ''),
    fields: [
      {
        name: 'Come rimettere le cose a posto',
        value:
          'I ruoli sono conservati nel profilo dell\'utente: dal pannello, scheda della ' +
          'persona, si restituiscono con un clic. Non serve ricostruirli a mano.',
        inline: false,
      },
    ],
    payload: {
      removedRoles: toRemove,
      removedRoleNames: detail,
      module: ctx.module,
    },
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
export function purgeRecent(guild: Guild, userId: string, seconds: number): number {
  if (seconds <= 0) return 0;
  const since = Date.now() - seconds * 1000;
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

/* ── Lockdown ─────────────────────────────────────────────────────────────
   Vive in `lockdown.ts`: qui si riesporta perché i chiamanti storici lo
   importano da questo file, e spostare dieci import per un trasloco interno
   sarebbe rumore nel diff senza nessun guadagno. */
export {
  descriviBlocco,
  descriviSblocco,
  disableLockdown,
  enableLockdown,
  isLockedDown,
  readLockdownState,
  startLockdownSweeper,
  statoRecente,
  type EsitoBlocco,
  type EsitoSblocco,
  type LockdownState,
} from './lockdown.js';
import { enableLockdown } from './lockdown.js';

async function requireVerification(ctx: EnforceContext): Promise<boolean> {
  const roleId = unverifiedRoleId(ctx.config);
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
    actorTag: ctx.client.user?.tag ?? 'ANGEL',
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

/* ═══════════════════════════════════════════════════════════════════════
   AVVISO PUBBLICO

   Il DM è il canale sbagliato per una sanzione automatica: la maggioranza
   degli utenti tiene chiusi i messaggi privati dagli sconosciuti, e un bot lo
   è. Chi viene zittito non riceve nulla e non capisce cosa sia successo, chi
   guardava vede solo un messaggio sparire.

   Un cartellino in chat risolve tutt'e due, e si cancella da solo per non
   lasciare la cronologia piena di avvisi vecchi.
   ═══════════════════════════════════════════════════════════════════════ */

/** Descrizione leggibile di ciò che è stato fatto, per l'avviso in chat. */
const ACTION_LABEL: Record<string, string> = {
  DELETE_MESSAGE: 'messaggio rimosso',
  PURGE_RECENT: 'messaggi recenti rimossi',
  WARN: 'avvertimento',
  TIMEOUT: 'silenziato temporaneamente',
  QUARANTINE: 'messo in quarantena',
  STRIP_ROLES: 'ruoli con permessi rimossi',
  KICK: 'espulso dal server',
  BAN: 'bandito dal server',
  REQUIRE_VERIFICATION: 'verifica richiesta prima di poter scrivere',
};

async function announceAction(
  ctx: EnforceContext,
  decision: Decision,
  applied: string[],
  dryRun: boolean,
): Promise<void> {
  const settings = ctx.config.general.actionNotice;
  if (!settings.enabled) return;
  if (dryRun && !settings.announceDryRun) return;

  // `applied` in modalità prova contiene voci tipo «BAN (simulata)».
  const kinds = applied.map((entry) => entry.replace(' (simulata)', ''));
  const meaningful = kinds.filter((kind) => kind in ACTION_LABEL);
  if (meaningful.length === 0) return;

  // Un messaggio eliminato senza altro seguito è rumore in un server attivo:
  // chi vuole vederlo comunque ha un interruttore dedicato.
  if (!settings.announceDeletions && meaningful.every((kind) => kind === 'DELETE_MESSAGE')) return;

  const channelId = settings.channelId ?? ctx.message?.channelId;
  if (!channelId) return;

  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) return;

  const targetId = ctx.member?.id ?? ctx.message?.author.id;
  const targetName = ctx.member?.user.tag ?? ctx.message?.author.tag ?? 'un utente';
  const who =
    settings.mentionTarget && targetId ? `<@${targetId}>` : `**${targetName.replace(/\*/g, '')}**`;

  const what = [...new Set(meaningful.map((kind) => ACTION_LABEL[kind]))].join(', ');
  const reason = decision.reasons[0]?.detail ?? '';

  const parts = [`🛡️ ${who} — ${what}${dryRun ? ' *(modalità prova: non applicata)*' : ''}`];
  if (settings.showReason && reason) parts.push(`Motivo: ${reason.slice(0, 300)}`);
  if (settings.showModule) parts.push(`-# rilevato da ${ctx.module}`);

  const sent = await channel
    .send({
      content: parts.join('\n'),
      // Si menziona la persona ma non le si notifica addosso una raffica:
      // l'avviso serve a informare chi legge il canale, non a insistere.
      allowedMentions: { users: settings.mentionTarget && targetId ? [targetId] : [] },
    })
    .catch(() => null);

  if (sent && settings.deleteAfterSec > 0) {
    setTimeout(() => {
      void sent.delete().catch(() => undefined);
    }, settings.deleteAfterSec * 1000).unref?.();
  }
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
