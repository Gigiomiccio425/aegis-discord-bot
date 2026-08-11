import { PermissionFlagsBits, type GuildMember, type PermissionsString } from 'discord.js';
import type { Exemptions, GuildConfig } from '@angel/shared';

/** ID dei proprietari del bot, letti una sola volta. */
const ownerIds = (process.env.OWNER_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

export function isBotOwner(userId: string): boolean {
  return ownerIds.includes(userId);
}

/**
 * Verifica se un membro è esente da un modulo.
 *
 * Nota sulla scelta di default: `administrators` è false. Esentare
 * automaticamente chi ha Administrator sembra ragionevole, ma è proprio
 * l'account con Administrator il bersaglio del furto di token e il vettore dei
 * nuke. Chi vuole quell'esenzione deve attivarla consapevolmente.
 */
export function isExempt(
  member: GuildMember | null,
  exemptions: Exemptions,
  channelId?: string,
): boolean {
  if (!member) return false;
  if (isBotOwner(member.id)) return true;
  if (member.id === member.client.user.id) return true;

  if (exemptions.userIds.includes(member.id)) return true;
  if (channelId && exemptions.channelIds.includes(channelId)) return true;
  if (exemptions.roleIds.some((roleId) => member.roles.cache.has(roleId))) return true;

  if (exemptions.administrators && member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  if (exemptions.verifiedBots && member.user.bot && member.user.flags?.has('VerifiedBot')) {
    return true;
  }
  return false;
}

/** Membri dello staff secondo la configurazione generale. */
export function isStaff(member: GuildMember | null, config: GuildConfig): boolean {
  if (!member) return false;
  if (isBotOwner(member.id)) return true;
  if (member.id === member.guild.ownerId) return true;
  return config.general.staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

/**
 * Whitelist anti-nuke. Il proprietario del server non viene mai colpito:
 * privarlo dei ruoli lascerebbe il server senza nessuno in grado di rimediare.
 */
export function isNukeWhitelisted(member: GuildMember, config: GuildConfig): boolean {
  if (isBotOwner(member.id)) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.id === member.client.user.id) return true;

  const { whitelist } = config.security.antiNuke;
  if (whitelist.userIds.includes(member.id)) return true;
  if (member.user.bot && whitelist.botIds.includes(member.id)) return true;
  return whitelist.roleIds.some((roleId) => member.roles.cache.has(roleId));
}

/**
 * Ruoli che concedono almeno uno dei permessi considerati pericolosi.
 * Sono quelli che l'anti-nuke rimuove per primi.
 */
export function dangerousRoles(member: GuildMember, dangerousPermissions: string[]): string[] {
  const flags = dangerousPermissions.filter(
    (name): name is PermissionsString => name in PermissionFlagsBits,
  );

  return member.roles.cache
    .filter((role) => {
      if (role.id === member.guild.id) return false; // @everyone non è rimovibile
      if (role.managed) return false; // ruoli di integrazione: non si toccano
      return flags.some((flag) => role.permissions.has(PermissionFlagsBits[flag]));
    })
    .map((role) => role.id);
}

/** Il bot può agire su questo membro? Serve a evitare tentativi destinati a fallire. */
export function canActOn(actor: GuildMember, target: GuildMember): boolean {
  if (target.id === target.guild.ownerId) return false;
  if (target.id === actor.client.user.id) return false;
  return actor.roles.highest.comparePositionTo(target.roles.highest) > 0;
}

/** Permessi minimi perché ANGEL possa svolgere il proprio lavoro. */
export const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
];

export function missingBotPermissions(member: GuildMember): string[] {
  return REQUIRED_BOT_PERMISSIONS.filter((flag) => !member.permissions.has(flag)).map(
    (flag) =>
      Object.entries(PermissionFlagsBits).find(([, value]) => value === flag)?.[0] ?? 'sconosciuto',
  );
}
