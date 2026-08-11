import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type ForumChannel,
  type Guild,
  type NewsChannel,
  type TextChannel,
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
import { getGuildConfig } from './config.js';

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

/* ═══════════════════════════════════════════════════════════════════════
   LOCKDOWN

   Tre cose che la prima versione sbagliava, tutte scoperte sul campo:

   1. Lo stato in Redis scadeva dopo 24 ore. Passate quelle, i canali restavano
      bloccati ma la revoca non trovava più l'elenco e usciva senza fare nulla:
      il server rimaneva muto e nessun comando lo sbloccava. Ora la chiave non
      scade, e la scadenza è un campo dentro lo stato — sorvegliato da un ciclo
      che sopravvive ai riavvii, cosa che un `setTimeout` non fa.

   2. I canali venivano modificati uno alla volta, in serie. Su un server con
      cinquanta canali significa cinquanta chiamate sequenziali, e il blocco
      arrivava a raid già concluso. Ora si procede a lotti in parallelo.

   3. Si leggeva solo la cache dei canali, che dopo un riavvio può essere
      incompleta: i canali non ancora visti restavano aperti. Ora si chiede
      l'elenco a Discord.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Tipi di canale su cui il lockdown ha effetto.
 *
 * I thread non ci sono: ereditano i permessi dal canale che li contiene, e
 * bloccare il canale li blocca di conseguenza. Elencarli significherebbe
 * moltiplicare le chiamate per nulla, proprio quando la velocità conta.
 */
const LOCKABLE = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
] as const;

type LockableChannel = TextChannel | NewsChannel | ForumChannel;

/**
 * Canale bloccabile: ha `permissionOverwrites`, che i thread non hanno.
 *
 * Generico perché i due chiamanti partono da insiemi diversi — l'elenco
 * completo dei canali e il singolo canale recuperato per ID — e restringere
 * ciascuno al proprio sottoinsieme evita di riaprire il controllo dopo.
 */
function isLockable<T extends { type: ChannelType }>(
  channel: T | null | undefined,
): channel is Extract<T, LockableChannel> {
  return channel != null && (LOCKABLE as readonly ChannelType[]).includes(channel.type);
}

interface LockdownState {
  reason: string;
  channels: string[];
  startedAt: number;
  /** Timestamp di revoca automatica. 0 = solo manuale. */
  expiresAt: number;
  /** Messaggi d'avviso pubblicati, per poterli sostituire alla revoca. */
  notices: { channelId: string; messageId: string }[];
}

export async function readLockdownState(guildId: string): Promise<LockdownState | null> {
  const raw = await getRedis().get(RedisKeys.lockdown(guildId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockdownState;
  } catch {
    return null;
  }
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
): Promise<{ locked: number; alreadyActive: boolean }> {
  const redis = getRedis();
  const key = RedisKeys.lockdown(guild.id);
  if (await redis.exists(key)) return { locked: 0, alreadyActive: true };

  const settings = config.security.antiRaid;
  const everyone = guild.roles.everyone;
  const affected: string[] = [];
  const notices: LockdownState[ 'notices' ] = [];

  // Lo stato si scrive **prima** di toccare i canali: se il processo muore a
  // metà, la revoca trova comunque un elenco parziale da cui ripartire. Il
  // contrario — bloccare e poi salvare — lascerebbe un server bloccato di cui
  // nessuno sa più nulla, che è esattamente il guasto che si sta correggendo.
  const state: LockdownState = {
    reason,
    channels: affected,
    startedAt: Date.now(),
    expiresAt: durationSec > 0 ? Date.now() + durationSec * 1000 : 0,
    notices,
  };
  await redis.set(key, JSON.stringify(state));

  if (settings.lockChannels) {
    // Dall'API e non dalla cache: dopo un riavvio la cache può essere parziale,
    // e un canale dimenticato aperto è la falla da cui passa tutto il resto.
    const channels = await guild.channels.fetch().catch(() => null);
    const targets = [...(channels?.values() ?? [])].filter(
      (channel) => isLockable(channel) && !settings.lockdownExemptChannels.includes(channel.id),
    ) as LockableChannel[];

    const announcement = settings.announceLockdown
      ? settings.lockdownMessage
          .replace('{motivo}', reason.slice(0, 300))
          .replace(
            '{durata}',
            durationSec > 0 ? `Durata prevista: ${humanDuration(durationSec)}` : '',
          )
          .trim()
      : null;

    for (const batch of chunk(targets, settings.lockdownBatchSize)) {
      await Promise.allSettled(
        batch.map(async (channel) => {
          const current = channel.permissionOverwrites.cache.get(everyone.id);
          // Già in sola lettura per scelta dello staff: non lo si tocca, perché
          // alla revoca verrebbe riaperto un canale che doveva restare chiuso.
          if (current?.deny.has(PermissionFlagsBits.SendMessages)) return;

          await channel.permissionOverwrites.edit(
            everyone,
            { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false },
            { reason: truncateReason(reason) },
          );
          affected.push(channel.id);

          if (announcement && channel.isTextBased()) {
            const sent = await channel
              .send({ content: announcement, allowedMentions: { parse: [] } })
              .catch(() => null);
            if (sent) notices.push({ channelId: channel.id, messageId: sent.id });
          }
        }),
      );
      await redis.set(key, JSON.stringify(state));
    }
  }

  if (settings.pauseInvites) {
    // `invitesDisabled` è la pausa inviti nativa di Discord.
    await guild.disableInvites(true).catch(() => undefined);
  }

  await redis.set(key, JSON.stringify(state));

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_LOCKDOWN_ENABLED',
    actorId: client.user?.id,
    severity: 95,
    automated: true,
    summary:
      `🔒 Server bloccato: ${reason}\n` +
      `Canali chiusi: ${affected.length}` +
      (durationSec > 0 ? `\nRevoca automatica fra ${humanDuration(durationSec)}` : ''),
    payload: { channels: affected, durationSec, invitesPaused: settings.pauseInvites },
  });

  return { locked: affected.length, alreadyActive: false };
}

/**
 * Revoca il lockdown.
 *
 * Con `force` riapre **tutti** i canali che negano la scrittura a @everyone,
 * non solo quelli registrati. È la via d'uscita quando lo stato è andato perso
 * — un Redis svuotato, un ripristino da backup — e il server è rimasto muto
 * senza che nessun comando riesca a sbloccarlo.
 */
export async function disableLockdown(
  client: Client,
  guild: Guild,
  reason: string,
  options: { force?: boolean; config?: GuildConfig } = {},
): Promise<{ unlocked: number; hadState: boolean }> {
  const redis = getRedis();
  const key = RedisKeys.lockdown(guild.id);
  const state = await readLockdownState(guild.id);
  if (!state && !options.force) return { unlocked: 0, hadState: false };

  const everyone = guild.roles.everyone;
  let ids = state?.channels ?? [];

  if (options.force) {
    const channels = await guild.channels.fetch().catch(() => null);
    const denied = [...(channels?.values() ?? [])]
      .filter(
        (channel) =>
          isLockable(channel) &&
          channel.permissionOverwrites.cache
            .get(everyone.id)
            ?.deny.has(PermissionFlagsBits.SendMessages),
      )
      .map((channel) => channel!.id);
    ids = [...new Set([...ids, ...denied])];
  }

  const batchSize = options.config?.security.antiRaid.lockdownBatchSize ?? 10;
  let unlocked = 0;

  for (const batch of chunk(ids, batchSize)) {
    await Promise.allSettled(
      batch.map(async (channelId) => {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!isLockable(channel)) return;
        // Si rimuove solo il divieto aggiunto dal lockdown, non l'intero
        // overwrite: sovrascriverlo cancellerebbe permessi impostati dallo staff.
        await channel.permissionOverwrites
          .edit(
            everyone,
            { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null },
            { reason: truncateReason(reason) },
          )
          .then(() => {
            unlocked += 1;
          })
          .catch(() => undefined);
      }),
    );
  }

  await guild.disableInvites(false).catch(() => undefined);

  // L'avviso di revoca prende il posto di quello di blocco, nello stesso
  // messaggio: due cartellini contraddittori uno sotto l'altro confondono più
  // del silenzio.
  const liftText = options.config?.security.antiRaid.lockdownLiftMessage;
  if (liftText && state?.notices.length) {
    await Promise.allSettled(
      state.notices.map(async (notice) => {
        const channel = await guild.channels.fetch(notice.channelId).catch(() => null);
        if (!channel?.isTextBased()) return;
        const message = await channel.messages.fetch(notice.messageId).catch(() => null);
        await message?.edit({ content: liftText, allowedMentions: { parse: [] } });
      }),
    );
  }

  await redis.del(key);

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_LOCKDOWN_DISABLED',
    actorId: client.user?.id,
    summary:
      `🔓 Lockdown revocato: ${reason}\nCanali riaperti: ${unlocked}` +
      (options.force && !state ? '\n(revoca forzata: nessuno stato salvato)' : ''),
    payload: { unlocked, forced: options.force ?? false, hadState: Boolean(state) },
  });

  return { unlocked, hadState: Boolean(state) };
}

export async function isLockedDown(guildId: string): Promise<boolean> {
  return (await getRedis().exists(RedisKeys.lockdown(guildId))) === 1;
}

/**
 * Revoca i lockdown scaduti.
 *
 * Sostituisce il `setTimeout` di prima, che moriva con il processo: un riavvio
 * durante un lockdown a tempo lasciava il server bloccato per sempre. Il ciclo
 * riparte a ogni avvio e ritrova lo stato in Redis.
 */
export function startLockdownSweeper(client: Client, intervalMs = 20_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      for (const guild of client.guilds.cache.values()) {
        const state = await readLockdownState(guild.id).catch(() => null);
        if (!state?.expiresAt || state.expiresAt > Date.now()) continue;
        const config = await getGuildConfig(guild.id).catch(() => undefined);
        await disableLockdown(client, guild, 'scadenza automatica', { config }).catch(() =>
          undefined,
        );
      }
    })();
  }, intervalMs);
  // Non deve tenere vivo il processo da solo.
  timer.unref?.();
  return timer;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
