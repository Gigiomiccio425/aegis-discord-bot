import {
  ChannelType,
  PermissionsBitField,
  type Guild,
  type NonThreadGuildBasedChannel,
} from 'discord.js';
import { getPrisma, type SnapshotKind } from '@angel/db';
import { childLogger } from '../core/logger.js';

const log = childLogger('snapshot');

/* ═══════════════════════════════════════════════════════════════════════
   SNAPSHOT E RIPRISTINO

   Limite da dichiarare senza giri di parole: Discord non consente di
   ripristinare i messaggi. Uno snapshot ricostruisce ruoli, canali, permessi,
   emoji e impostazioni; la cronologia torna solo per ciò che il bot aveva già
   archiviato in `MessageArchive`, e come ricostruzione, non come originale.

   Detto questo, è comunque la differenza fra "mezz'ora di lavoro" e "il server
   è perduto": la struttura e i permessi sono ciò che costa davvero ricostruire.
   ═══════════════════════════════════════════════════════════════════════ */

interface RoleSnapshot {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  mentionable: boolean;
  managed: boolean;
  icon: string | null;
}

interface OverwriteSnapshot {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface ChannelSnapshot {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number;
  bitrate: number | null;
  userLimit: number | null;
  overwrites: OverwriteSnapshot[];
}

export async function createSnapshot(
  guild: Guild,
  kind: SnapshotKind,
  createdBy: string,
): Promise<string> {
  const roles: RoleSnapshot[] = guild.roles.cache
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      position: role.position,
      permissions: role.permissions.bitfield.toString(),
      mentionable: role.mentionable,
      managed: role.managed,
      icon: role.icon,
    }));

  const channels: ChannelSnapshot[] = guild.channels.cache
    .filter((channel): channel is NonThreadGuildBasedChannel => !channel.isThread())
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      position: 'position' in channel ? channel.position : 0,
      topic: 'topic' in channel ? (channel.topic ?? null) : null,
      nsfw: 'nsfw' in channel ? Boolean(channel.nsfw) : false,
      rateLimitPerUser: 'rateLimitPerUser' in channel ? (channel.rateLimitPerUser ?? 0) : 0,
      bitrate: 'bitrate' in channel ? channel.bitrate : null,
      userLimit: 'userLimit' in channel ? channel.userLimit : null,
      overwrites: channel.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      })),
    }));

  const emojis = guild.emojis.cache.map((emoji) => ({
    id: emoji.id,
    name: emoji.name,
    animated: emoji.animated,
    url: emoji.imageURL(),
  }));

  const stickers = guild.stickers.cache.map((sticker) => ({
    id: sticker.id,
    name: sticker.name,
    description: sticker.description,
    tags: sticker.tags,
    url: sticker.url,
  }));

  const settings = {
    name: guild.name,
    icon: guild.iconURL(),
    banner: guild.bannerURL(),
    description: guild.description,
    verificationLevel: guild.verificationLevel,
    explicitContentFilter: guild.explicitContentFilter,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    afkChannelId: guild.afkChannelId,
    afkTimeout: guild.afkTimeout,
    systemChannelId: guild.systemChannelId,
    rulesChannelId: guild.rulesChannelId,
    publicUpdatesChannelId: guild.publicUpdatesChannelId,
    premiumProgressBarEnabled: guild.premiumProgressBarEnabled,
    mfaLevel: guild.mfaLevel,
  };

  // Le regole AutoMod native fanno parte della configurazione di sicurezza:
  // un nuke che le cancella lascia il server scoperto anche dopo il ripristino
  // di canali e ruoli.
  const automod = await guild.autoModerationRules
    .fetch()
    .then((rules) =>
      rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        eventType: rule.eventType,
        triggerType: rule.triggerType,
        triggerMetadata: rule.triggerMetadata,
        actions: rule.actions,
        enabled: rule.enabled,
        exemptRoles: [...rule.exemptRoles.keys()],
        exemptChannels: [...rule.exemptChannels.keys()],
      })),
    )
    .catch(() => []);

  // I ruoli dei membri sono la parte più pesante e la più preziosa: dopo un
  // nuke che cancella i ruoli, è l'unico modo per rimettere ogni persona al
  // proprio posto.
  const memberRoles: { userId: string; roles: string[] }[] = [];
  const members = await guild.members.fetch().catch(() => null);
  if (members) {
    for (const member of members.values()) {
      const owned = member.roles.cache
        .filter((role) => role.id !== guild.id)
        .map((role) => role.id);
      if (owned.length > 0) memberRoles.push({ userId: member.id, roles: owned });
    }
  }

  const payload = { roles, channels, emojis, stickers, settings, automod, memberRoles };
  const sizeBytes = Buffer.byteLength(JSON.stringify(payload));

  const prisma = getPrisma();
  const snapshot = await prisma.snapshot.create({
    data: {
      guildId: guild.id,
      kind,
      createdBy,
      roles: roles as unknown as object,
      channels: channels as unknown as object,
      emojis: emojis as unknown as object,
      stickers: stickers as unknown as object,
      settings: settings as unknown as object,
      automod: automod as unknown as object,
      memberRoles: memberRoles as unknown as object,
      sizeBytes,
    },
  });

  log.info(
    { guildId: guild.id, snapshotId: snapshot.id, kind, sizeBytes, members: memberRoles.length },
    'snapshot creato',
  );
  return snapshot.id;
}

export interface RestoreOptions {
  roles: boolean;
  channels: boolean;
  permissions: boolean;
  memberRoles: boolean;
  settings: boolean;
}

export interface RestoreReport {
  rolesCreated: number;
  channelsCreated: number;
  overwritesRestored: number;
  membersRestored: number;
  errors: string[];
}

/**
 * Ripristino selettivo.
 *
 * Non ricrea ciò che esiste già: dopo un nuke parziale, sovrascrivere tutto
 * farebbe più danni dell'attacco. Si confronta per nome e si crea solo il
 * mancante, mantenendo una mappa vecchio-ID → nuovo-ID per riagganciare i
 * permessi.
 */
export async function restoreSnapshot(
  guild: Guild,
  snapshotId: string,
  options: RestoreOptions,
  actorId: string,
): Promise<RestoreReport> {
  const prisma = getPrisma();
  const snapshot = await prisma.snapshot.findUnique({ where: { id: snapshotId } });
  if (!snapshot || snapshot.guildId !== guild.id) {
    throw new Error('Snapshot non trovato per questo server');
  }

  // Prima di toccare qualsiasi cosa si salva lo stato attuale: se il ripristino
  // peggiora la situazione, serve una via di ritorno.
  await createSnapshot(guild, 'PRE_RESTORE', actorId);

  const report: RestoreReport = {
    rolesCreated: 0,
    channelsCreated: 0,
    overwritesRestored: 0,
    membersRestored: 0,
    errors: [],
  };

  const roleIdMap = new Map<string, string>();
  const channelIdMap = new Map<string, string>();

  if (options.roles) {
    const roles = snapshot.roles as unknown as RoleSnapshot[];
    // Dal basso verso l'alto: creare prima i ruoli alti li spingerebbe sotto.
    for (const role of [...roles].sort((a, b) => a.position - b.position)) {
      if (role.managed || role.id === guild.id) continue;

      const existing = guild.roles.cache.find((r) => r.name === role.name && !r.managed);
      if (existing) {
        roleIdMap.set(role.id, existing.id);
        continue;
      }
      try {
        const created = await guild.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          mentionable: role.mentionable,
          permissions: BigInt(role.permissions),
          reason: `Ripristino snapshot ${snapshotId}`,
        });
        roleIdMap.set(role.id, created.id);
        report.rolesCreated++;
      } catch (error) {
        report.errors.push(`Ruolo ${role.name}: ${(error as Error).message}`);
      }
    }
  }

  if (options.channels) {
    const channels = snapshot.channels as unknown as ChannelSnapshot[];
    // Le categorie per prime, altrimenti i canali non hanno un genitore.
    const ordered = [...channels].sort((a, b) => {
      if (a.type === ChannelType.GuildCategory && b.type !== ChannelType.GuildCategory) return -1;
      if (b.type === ChannelType.GuildCategory && a.type !== ChannelType.GuildCategory) return 1;
      return a.position - b.position;
    });

    for (const channel of ordered) {
      const existing = guild.channels.cache.find(
        (c) => c.name === channel.name && c.type === channel.type,
      );
      if (existing) {
        channelIdMap.set(channel.id, existing.id);
        continue;
      }
      try {
        const created = await guild.channels.create({
          name: channel.name,
          type: channel.type as ChannelType.GuildText,
          parent: channel.parentId ? (channelIdMap.get(channel.parentId) ?? undefined) : undefined,
          topic: channel.topic ?? undefined,
          nsfw: channel.nsfw,
          rateLimitPerUser: channel.rateLimitPerUser,
          reason: `Ripristino snapshot ${snapshotId}`,
        });
        channelIdMap.set(channel.id, created.id);
        report.channelsCreated++;

        if (options.permissions) {
          for (const overwrite of channel.overwrites) {
            const targetId =
              roleIdMap.get(overwrite.id) ??
              (guild.roles.cache.has(overwrite.id) || overwrite.id === guild.id
                ? overwrite.id
                : null);
            if (!targetId) continue;
            await created.permissionOverwrites
              .create(targetId, {
                // I bitfield si riapplicano tali e quali: ricostruirli campo per
                // campo introdurrebbe differenze silenziose.
                ...decodePermissions(overwrite.allow, true),
                ...decodePermissions(overwrite.deny, false),
              })
              .then(() => report.overwritesRestored++)
              .catch(() => undefined);
          }
        }
      } catch (error) {
        report.errors.push(`Canale ${channel.name}: ${(error as Error).message}`);
      }
    }
  }

  if (options.memberRoles) {
    const memberRoles = snapshot.memberRoles as unknown as { userId: string; roles: string[] }[];
    for (const entry of memberRoles) {
      const member = await guild.members.fetch(entry.userId).catch(() => null);
      if (!member) continue;
      const target = entry.roles
        .map((roleId) => roleIdMap.get(roleId) ?? roleId)
        .filter((roleId) => guild.roles.cache.has(roleId));
      if (target.length === 0) continue;
      await member.roles
        .add(target, `Ripristino snapshot ${snapshotId}`)
        .then(() => report.membersRestored++)
        .catch(() => undefined);
    }
  }

  if (options.settings) {
    const settings = snapshot.settings as unknown as Record<string, unknown>;
    await guild
      .edit({
        name: settings.name as string,
        verificationLevel: settings.verificationLevel as number,
        explicitContentFilter: settings.explicitContentFilter as number,
        reason: `Ripristino snapshot ${snapshotId}`,
      })
      .catch((error) => report.errors.push(`Impostazioni: ${(error as Error).message}`));
  }

  await prisma.snapshot.update({
    where: { id: snapshotId },
    data: { restoredAt: new Date(), restoredBy: actorId },
  });

  return report;
}

/**
 * Ripristino mirato dopo un nuke.
 *
 * Diverso dal ripristino completo: non ricrea tutto ciò che manca rispetto allo
 * snapshot, ma solo ciò che è **sparito negli ultimi minuti**. La differenza è
 * sostanziale — dopo un attacco, ricreare alla cieca tutto ciò che manca
 * significa resuscitare anche i canali che lo staff aveva eliminato di
 * proposito la settimana prima.
 *
 * Si limita a canali e ruoli, che sono ciò che un nuke distrugge e ciò che
 * costa di più ricostruire a mano.
 */
export async function autoRestoreAfterNuke(
  guild: Guild,
  windowMinutes = 30,
): Promise<{ rolesRestored: string[]; channelsRestored: string[]; snapshotId: string | null }> {
  const prisma = getPrisma();
  const result = { rolesRestored: [] as string[], channelsRestored: [] as string[], snapshotId: null as string | null };

  // Lo snapshot di riferimento è il più recente *precedente* alla finestra
  // dell'attacco: quelli d'emergenza scattano a nuke iniziato e potrebbero già
  // riflettere il danno.
  const snapshot = await prisma.snapshot.findFirst({
    where: {
      guildId: guild.id,
      createdAt: { lt: new Date(Date.now() - windowMinutes * 60_000) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!snapshot) {
    log.warn({ guildId: guild.id }, 'nessuno snapshot utile per il ripristino automatico');
    return result;
  }
  result.snapshotId = snapshot.id;

  const roles = snapshot.roles as unknown as RoleSnapshot[];
  const channels = snapshot.channels as unknown as ChannelSnapshot[];

  const roleIdMap = new Map<string, string>();

  for (const role of [...roles].sort((a, b) => a.position - b.position)) {
    if (role.managed || role.id === guild.id) continue;
    // Presente per ID o per nome: se esiste ancora non va toccato.
    if (guild.roles.cache.has(role.id)) continue;
    if (guild.roles.cache.some((existing) => existing.name === role.name && !existing.managed)) {
      continue;
    }

    const created = await guild.roles
      .create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: BigInt(role.permissions),
        reason: 'Ripristino automatico dopo un tentativo di nuke',
      })
      .catch(() => null);

    if (created) {
      roleIdMap.set(role.id, created.id);
      result.rolesRestored.push(role.name);
    }
  }

  for (const channel of [...channels].sort((a, b) => {
    if (a.type === ChannelType.GuildCategory && b.type !== ChannelType.GuildCategory) return -1;
    if (b.type === ChannelType.GuildCategory && a.type !== ChannelType.GuildCategory) return 1;
    return a.position - b.position;
  })) {
    if (guild.channels.cache.has(channel.id)) continue;
    if (guild.channels.cache.some((existing) => existing.name === channel.name && existing.type === channel.type)) {
      continue;
    }

    const parentId = channel.parentId
      ? (guild.channels.cache.find(
          (existing) =>
            existing.type === ChannelType.GuildCategory &&
            existing.name === channels.find((c) => c.id === channel.parentId)?.name,
        )?.id ?? undefined)
      : undefined;

    const created = await guild.channels
      .create({
        name: channel.name,
        type: channel.type as ChannelType.GuildText,
        parent: parentId,
        topic: channel.topic ?? undefined,
        nsfw: channel.nsfw,
        rateLimitPerUser: channel.rateLimitPerUser,
        reason: 'Ripristino automatico dopo un tentativo di nuke',
      })
      .catch(() => null);

    if (!created) continue;
    result.channelsRestored.push(channel.name);

    for (const overwrite of channel.overwrites) {
      const targetId =
        roleIdMap.get(overwrite.id) ??
        (guild.roles.cache.has(overwrite.id) || overwrite.id === guild.id ? overwrite.id : null);
      if (!targetId) continue;
      await created.permissionOverwrites
        .create(targetId, {
          ...decodePermissions(overwrite.allow, true),
          ...decodePermissions(overwrite.deny, false),
        })
        .catch(() => undefined);
    }
  }

  log.info(
    {
      guildId: guild.id,
      roles: result.rolesRestored.length,
      channels: result.channelsRestored.length,
    },
    'ripristino automatico completato',
  );
  return result;
}

/** Converte un bitfield in oggetto per `permissionOverwrites.create`. */
function decodePermissions(bitfield: string, allow: boolean): Record<string, boolean> {
  const value = BigInt(bitfield);
  if (value === 0n) return {};
  const result: Record<string, boolean> = {};
  // discord.js accetta la forma { PermissionName: boolean }; si ricava dal
  // bitfield senza dover elencare i permessi a mano.
  for (const name of new PermissionsBitField(value).toArray()) {
    result[name] = allow;
  }
  return result;
}
