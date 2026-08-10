import {
  Events,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type PartialGuildMember,
  type PartialUser,
  type User,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import { getGuildConfig } from '../core/config.js';
import { applyDecision } from '../core/enforcer.js';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';
import { evaluateAccount } from '../security/accountGuard.js';
import { onBotJoin } from '../security/botGuard.js';
import { trackJoin } from '../security/antiRaid.js';
import { attributeInvite } from './invites.js';

const log = childLogger('events:members');

export function registerMemberEvents(client: Client): void {
  client.on(Events.GuildMemberAdd, (member) => {
    void handleJoin(client, member).catch((error) =>
      log.error({ err: error, userId: member.id }, 'gestione ingresso fallita'),
    );
  });

  client.on(Events.GuildMemberRemove, (member) => {
    void handleLeave(client, member).catch((error) =>
      log.error({ err: error }, 'gestione uscita fallita'),
    );
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    void handleUpdate(client, oldMember, newMember).catch((error) =>
      log.error({ err: error }, 'gestione aggiornamento membro fallita'),
    );
  });

  client.on(Events.GuildBanAdd, (ban) => {
    void recordEvent(client, {
      guildId: ban.guild.id,
      type: 'MEMBER_BANNED',
      targetId: ban.user.id,
      targetTag: ban.user.tag,
      severity: 40,
      summary: ban.reason ? `Motivo: ${ban.reason}` : undefined,
    });
  });

  client.on(Events.GuildBanRemove, (ban) => {
    void recordEvent(client, {
      guildId: ban.guild.id,
      type: 'MEMBER_UNBANNED',
      targetId: ban.user.id,
      targetTag: ban.user.tag,
    });
  });

  /**
   * Cambi di username e avatar globali.
   *
   * `userUpdate` è un evento *globale*, non legato a un server: va quindi
   * registrato in ogni guild in cui la persona è presente, altrimenti chi
   * amministra un server non vedrebbe che uno dei suoi membri ha appena
   * cambiato identità.
   */
  client.on(Events.UserUpdate, (oldUser, newUser) => {
    void handleUserUpdate(client, oldUser, newUser).catch(() => undefined);
  });
}

async function handleUserUpdate(
  client: Client,
  oldUser: User | PartialUser,
  newUser: User,
): Promise<void> {
  const nameChanged =
    oldUser.username !== undefined && oldUser.username !== newUser.username;
  const displayChanged =
    oldUser.globalName !== undefined && oldUser.globalName !== newUser.globalName;
  const avatarChanged = oldUser.avatar !== undefined && oldUser.avatar !== newUser.avatar;

  if (!nameChanged && !avatarChanged && !displayChanged) return;

  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(newUser.id);
    if (!member) continue;

    if (nameChanged || displayChanged) {
      await recordEvent(client, {
        guildId: guild.id,
        type: 'MEMBER_USERNAME_CHANGED',
        targetId: newUser.id,
        targetTag: newUser.tag,
        summary:
          (nameChanged
            ? `Username: \`${oldUser.username}\` → \`${newUser.username}\``
            : '') +
          (displayChanged
            ? `${nameChanged ? '\n' : ''}Nome visualizzato: \`${oldUser.globalName ?? '(nessuno)'}\` → \`${newUser.globalName ?? '(nessuno)'}\``
            : ''),
        payload: {
          usernameBefore: oldUser.username,
          usernameAfter: newUser.username,
          globalNameBefore: oldUser.globalName,
          globalNameAfter: newUser.globalName,
        },
      });
    }

    if (avatarChanged) {
      await recordEvent(client, {
        guildId: guild.id,
        type: 'MEMBER_AVATAR_CHANGED',
        targetId: newUser.id,
        targetTag: newUser.tag,
        summary: newUser.avatar
          ? 'Immagine del profilo cambiata'
          : 'Immagine del profilo rimossa',
        payload: {
          before: oldUser.avatar,
          after: newUser.avatar,
          url: newUser.displayAvatarURL({ size: 256 }),
        },
      });
    }

    // Un cambio d'identità è il momento giusto per riesaminare l'account: chi
    // entra pulito e poi si traveste da moderatore non verrebbe altrimenti mai
    // rivalutato.
    const config = await getGuildConfig(guild.id);
    if (config.security.accountGuard.enabled) {
      const decision = await evaluateAccount(client, member, config).catch(() => null);
      if (decision?.triggered && decision.score >= 60) {
        await applyDecision(
          { client, guild, config, member, module: 'accountGuard' },
          decision,
        );
      }
    }
  }
}

/**
 * Ingresso di un membro.
 *
 * L'ordine conta: prima l'anti-raid, che deve reagire nell'arco di secondi, poi
 * la profilazione dell'account. Se il raid è già stato riconosciuto, il membro
 * viene trattato come parte dell'attacco e non serve valutarlo singolarmente.
 */
async function handleJoin(client: Client, member: GuildMember): Promise<void> {
  const config = await getGuildConfig(member.guild.id);

  const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  const invite = config.logging.trackInviteAttribution
    ? await attributeInvite(member.guild).catch(() => null)
    : null;

  await recordEvent(client, {
    guildId: member.guild.id,
    type: member.user.bot ? 'BOT_JOINED' : 'MEMBER_JOINED',
    targetId: member.id,
    targetTag: member.user.tag,
    summary:
      `Account creato ${accountAgeDays} giorni fa` +
      (invite ? `\nEntrato con l'invito \`${invite.code}\`` : '') +
      (invite?.inviterId ? ` creato da <@${invite.inviterId}>` : ''),
    payload: {
      accountAgeDays,
      hasAvatar: member.user.avatar !== null,
      inviteCode: invite?.code,
      inviterId: invite?.inviterId,
    },
  });

  if (invite) {
    // L'invito usato ha un evento proprio: «chi porta account problematici in
    // questo server» è una domanda che si risolve solo aggregando questi dati.
    await recordEvent(client, {
      guildId: member.guild.id,
      type: 'INVITE_USED',
      actorId: invite.inviterId ?? null,
      targetId: member.id,
      targetTag: member.user.tag,
      summary:
        `Invito \`${invite.code}\` usato da <@${member.id}>` +
        (invite.inviterId ? `\nCreato da <@${invite.inviterId}>` : ''),
      payload: { code: invite.code, inviterId: invite.inviterId },
    });

    const prisma = getPrisma();
    await prisma.userProfile
      .upsert({
        where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
        create: {
          guildId: member.guild.id,
          userId: member.id,
          inviteCode: invite.code,
          invitedBy: invite.inviterId ?? null,
        },
        update: { inviteCode: invite.code, invitedBy: invite.inviterId ?? null },
      })
      .catch(() => undefined);
  }

  if (member.user.bot) {
    await onBotJoin(client, member, config);
    return;
  }

  await applyVerificationGate(client, member, config);
  await restoreStickyRoles(client, member, config);

  const raidDetected = await trackJoin(client, member, config);
  if (raidDetected) return;

  const decision = await evaluateAccount(client, member, config);
  if (decision.triggered) {
    await applyDecision(
      { client, guild: member.guild, config, member, module: 'accountGuard' },
      decision,
    );
  }
}

/**
 * Isola chi entra finché non supera la verifica.
 *
 * Il ruolo va assegnato *prima* di qualunque altra cosa: fra l'ingresso e la
 * verifica c'è una finestra in cui un account automatico può già scrivere, e
 * quella finestra va chiusa subito.
 */
async function applyVerificationGate(
  client: Client,
  member: GuildMember,
  config: Awaited<ReturnType<typeof getGuildConfig>>,
): Promise<void> {
  const settings = config.security.verification;
  if (!settings.enabled || settings.mode === 'OFF') return;

  const roleId = settings.quarantineRoleId ?? config.general.quarantineRoleId;
  if (!roleId) return;

  await member.roles.add(roleId, 'Verifica d\'ingresso richiesta').catch(() => undefined);

  if (settings.kickAfterMinutes > 0) {
    // Attesa in memoria: un riavvio del bot annulla le espulsioni pendenti.
    // È un compromesso accettabile — la conseguenza è che qualcuno resta in
    // quarantena più a lungo, non che entri senza verifica.
    setTimeout(
      () => {
        void (async () => {
          const fresh = await member.guild.members.fetch(member.id).catch(() => null);
          if (!fresh) return;
          if (settings.verifiedRoleId && fresh.roles.cache.has(settings.verifiedRoleId)) return;
          await fresh
            .kick(`Verifica non completata entro ${settings.kickAfterMinutes} minuti`)
            .catch(() => undefined);
        })();
      },
      settings.kickAfterMinutes * 60_000,
    );
  }
}

/**
 * Ruoli appiccicosi: chi rientra si ritrova i ruoli che aveva.
 *
 * Oltre alla comodità, chiude il trucco più banale della moderazione — uscire
 * e rientrare per liberarsi di un silenziamento o di una quarantena. I ruoli
 * con permessi non vengono mai restituiti in automatico: sarebbe una scalata
 * di privilegi a disposizione di chiunque ottenga quel ruolo una volta sola.
 */
async function restoreStickyRoles(
  client: Client,
  member: GuildMember,
  config: Awaited<ReturnType<typeof getGuildConfig>>,
): Promise<void> {
  const settings = config.security.stickyRoles;
  if (!settings.enabled) return;

  const prisma = getPrisma();
  const profile = await prisma.userProfile
    .findUnique({ where: { guildId_userId: { guildId: member.guild.id, userId: member.id } } })
    .catch(() => null);

  if (!profile?.lastRoles.length || !profile.lastRolesAt) return;

  const ageDays = (Date.now() - profile.lastRolesAt.getTime()) / 86_400_000;
  if (ageDays > settings.maxAgeDays) return;

  const me = await member.guild.members.fetchMe();
  const dangerous = config.security.antiNuke.dangerousPermissions;

  const restorable = profile.lastRoles.filter((roleId) => {
    const role = member.guild.roles.cache.get(roleId);
    if (!role || role.managed || role.id === member.guild.id) return false;
    if (settings.excludedRoleIds.includes(roleId)) return false;
    // Non si può assegnare un ruolo più alto del proprio: tentarlo produce
    // soltanto un errore a ogni ingresso.
    if (role.position >= me.roles.highest.position) return false;
    return !dangerous.some((name) => {
      const flag = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
      return typeof flag === 'bigint' && role.permissions.has(flag);
    });
  });

  // I ruoli di sanzione si riapplicano solo se richiesto, ma è il default:
  // è il motivo per cui questo modulo esiste.
  const quarantineRoleId = config.general.quarantineRoleId;
  const finalRoles = settings.reapplyPunishments
    ? restorable
    : restorable.filter((roleId) => roleId !== quarantineRoleId);

  if (finalRoles.length === 0) return;

  const apply = async () => {
    await member.roles.add(finalRoles, 'Ruoli ripristinati al rientro').catch(() => undefined);
    await recordEvent(client, {
      guildId: member.guild.id,
      type: 'STICKY_ROLES_RESTORED',
      targetId: member.id,
      targetTag: member.user.tag,
      summary:
        `Ripristinati ${finalRoles.length} ruoli al rientro` +
        (profile.lastRoles.length > finalRoles.length
          ? ` (${profile.lastRoles.length - finalRoles.length} esclusi perché privilegiati, gestiti o troppo alti)`
          : ''),
      payload: { restored: finalRoles, saved: profile.lastRoles },
    });
  };

  if (settings.delaySec > 0) {
    setTimeout(() => void apply(), settings.delaySec * 1000);
  } else {
    await apply();
  }
}

async function handleLeave(
  client: Client,
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  const prisma = getPrisma();
  // I ruoli vanno salvati *adesso*: dopo l'uscita l'oggetto membro non esiste
  // più e l'informazione è perduta per sempre.
  const heldRoles =
    member.roles?.cache
      .filter((role) => role.id !== member.guild.id && !role.managed)
      .map((role) => role.id) ?? [];

  await prisma.userProfile
    .upsert({
      where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
      create: {
        guildId: member.guild.id,
        userId: member.id,
        leftAt: new Date(),
        lastRoles: heldRoles,
        lastRolesAt: new Date(),
      },
      update: {
        leftAt: new Date(),
        ...(heldRoles.length > 0 ? { lastRoles: heldRoles, lastRolesAt: new Date() } : {}),
      },
    })
    .catch(() => undefined);

  await recordEvent(client, {
    guildId: member.guild.id,
    type: member.user.bot ? 'BOT_LEFT' : 'MEMBER_LEFT',
    targetId: member.id,
    targetTag: member.user.tag,
    summary: member.joinedAt
      ? `Era nel server da ${Math.floor((Date.now() - member.joinedAt.getTime()) / 86_400_000)} giorni`
      : undefined,
    payload: { roles: member.roles?.cache.map((role) => role.id) ?? [] },
  });
}

/**
 * Aggiornamento di un membro: nickname, ruoli, timeout, boost.
 *
 * I cambi di ruolo si registrano uno per uno perché è la domanda che si pone
 * dopo ogni incidente: chi ha dato quel permesso, e quando.
 */
async function handleUpdate(
  client: Client,
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
): Promise<void> {
  const guildId = newMember.guild.id;

  if (oldMember.nickname !== newMember.nickname) {
    await recordEvent(client, {
      guildId,
      type: 'MEMBER_NICKNAME_CHANGED',
      targetId: newMember.id,
      targetTag: newMember.user.tag,
      summary: `\`${oldMember.nickname ?? '(nessuno)'}\` → \`${newMember.nickname ?? '(nessuno)'}\``,
      payload: { before: oldMember.nickname, after: newMember.nickname },
    });
  }

  const oldRoles = oldMember.roles?.cache ?? new Map();
  const added = newMember.roles.cache.filter((role) => !oldRoles.has(role.id));
  const removed = [...oldRoles.values()].filter(
    (role) => !newMember.roles.cache.has((role as { id: string }).id),
  ) as { id: string; name: string }[];

  for (const role of added.values()) {
    await recordEvent(client, {
      guildId,
      type: 'MEMBER_ROLE_ADDED',
      targetId: newMember.id,
      targetTag: newMember.user.tag,
      roleId: role.id,
      summary: `Ruolo assegnato: <@&${role.id}>`,
      payload: { roleId: role.id, roleName: role.name },
    });
  }

  for (const role of removed) {
    await recordEvent(client, {
      guildId,
      type: 'MEMBER_ROLE_REMOVED',
      targetId: newMember.id,
      targetTag: newMember.user.tag,
      roleId: role.id,
      summary: `Ruolo rimosso: <@&${role.id}>`,
      payload: { roleId: role.id, roleName: role.name },
    });
  }

  const oldTimeout = oldMember.communicationDisabledUntilTimestamp ?? null;
  const newTimeout = newMember.communicationDisabledUntilTimestamp ?? null;
  if (oldTimeout !== newTimeout) {
    await recordEvent(client, {
      guildId,
      type: newTimeout ? 'MEMBER_TIMED_OUT' : 'MEMBER_TIMEOUT_REMOVED',
      targetId: newMember.id,
      targetTag: newMember.user.tag,
      severity: newTimeout ? 30 : 0,
      summary: newTimeout ? `Fino a <t:${Math.floor(newTimeout / 1000)}:f>` : undefined,
    });
  }

  if (!oldMember.premiumSince && newMember.premiumSince) {
    await recordEvent(client, {
      guildId,
      type: 'MEMBER_BOOSTED',
      targetId: newMember.id,
      targetTag: newMember.user.tag,
    });
  }
  if (oldMember.premiumSince && !newMember.premiumSince) {
    await recordEvent(client, {
      guildId,
      type: 'MEMBER_UNBOOSTED',
      targetId: newMember.id,
      targetTag: newMember.user.tag,
      summary: `Boost terminato dopo <t:${Math.floor(oldMember.premiumSince.getTime() / 1000)}:R>`,
    });
  }

  // L'avatar *del server* è distinto da quello globale: si può cambiare solo
  // qui, ed è il modo meno appariscente per imitare un moderatore.
  if (oldMember.avatar !== undefined && oldMember.avatar !== newMember.avatar) {
    await recordEvent(client, {
      guildId,
      type: 'MEMBER_AVATAR_CHANGED',
      targetId: newMember.id,
      targetTag: newMember.user.tag,
      summary: newMember.avatar
        ? 'Immagine del profilo specifica per questo server cambiata'
        : 'Immagine del profilo specifica per questo server rimossa',
      payload: { scope: 'guild', before: oldMember.avatar, after: newMember.avatar },
    });
  }

  // Un cambio di avatar o nome dopo l'ingresso è un modo per aggirare il
  // controllo fatto al momento del join: chi entra pulito e poi si traveste da
  // moderatore non verrebbe altrimenti mai riesaminato.
  const config = await getGuildConfig(guildId);
  const identityChanged =
    oldMember.displayName !== newMember.displayName ||
    oldMember.user?.avatar !== newMember.user.avatar;

  if (identityChanged && config.security.accountGuard.enabled) {
    const decision = await evaluateAccount(client, newMember, config).catch(() => null);
    if (decision?.triggered && decision.score >= 60) {
      await applyDecision(
        { client, guild: newMember.guild, config, member: newMember, module: 'accountGuard' },
        decision,
      );
    }
  }
}
