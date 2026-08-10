import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import type { Command } from './types.js';
import { createCase } from '../core/cases.js';
import { canActOn } from '../core/permissions.js';
import { liftQuarantine, quarantineMember } from '../core/enforcer.js';
import { recordEvent } from '../logging/auditLogger.js';
import { humanDuration, t } from '../core/i18n.js';

/** Converte "10m", "2h", "7d" in secondi. */
function parseDuration(input: string): number | null {
  const match = /^(\d+)\s*(s|m|h|d|g)$/i.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
    case 'g':
      return value * 86400;
    default:
      return null;
  }
}

const warn: Command = {
  data: new SlashCommandBuilder()
    .setName('avverti')
    .setDescription('Registra un avvertimento per un membro')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Chi avvertire').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo').setRequired(true).setMaxLength(500),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ client, interaction, config }) {
    const target = interaction.options.getMember('utente') as GuildMember | null;
    const reason = interaction.options.getString('motivo', true);
    if (!target) {
      await interaction.reply({ content: 'Utente non presente nel server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const record = await createCase({
      guildId: interaction.guildId!,
      type: 'WARN',
      targetId: target.id,
      targetTag: target.user.tag,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      reason,
    });

    await target.send(t(config.general.locale, 'mod.warned', { guild: interaction.guild!.name, reason }))
      .catch(() => undefined);

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_WARN',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: target.id,
      targetTag: target.user.tag,
      caseId: record.id,
      summary: `Caso #${record.number} · ${reason}`,
    });

    await interaction.reply({
      content: `✅ Avvertimento registrato · caso **#${record.number}**`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const mute: Command = {
  data: new SlashCommandBuilder()
    .setName('silenzia')
    .setDescription('Silenzia un membro per un periodo (timeout Discord)')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Chi silenziare').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('durata')
        .setDescription('Es. 10m, 2h, 7d — massimo 28 giorni')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo').setMaxLength(500),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ client, interaction, config }) {
    const target = interaction.options.getMember('utente') as GuildMember | null;
    const durationInput = interaction.options.getString('durata', true);
    const reason = interaction.options.getString('motivo') ?? 'Nessun motivo indicato';

    const seconds = parseDuration(durationInput);
    if (!seconds) {
      await interaction.reply({
        content: 'Durata non valida. Usa un formato come `10m`, `2h`, `7d`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Il limite di Discord per il timeout nativo è 28 giorni.
    if (seconds > 2_419_200) {
      await interaction.reply({
        content: 'Il timeout di Discord non può superare i 28 giorni.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!target) {
      await interaction.reply({ content: 'Utente non presente nel server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const me = await interaction.guild!.members.fetchMe();
    if (!canActOn(me, target)) {
      await interaction.reply({
        content: 'Non posso agire su questo membro: ha un ruolo più alto del mio.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await target.timeout(seconds * 1000, reason);

    const record = await createCase({
      guildId: interaction.guildId!,
      type: 'MUTE',
      targetId: target.id,
      targetTag: target.user.tag,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      reason,
      expiresAt: new Date(Date.now() + seconds * 1000),
    });

    await target
      .send(
        t(config.general.locale, 'mod.muted', {
          guild: interaction.guild!.name,
          reason,
          duration: humanDuration(seconds, config.general.locale),
        }),
      )
      .catch(() => undefined);

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_MUTE',
      actorId: interaction.user.id,
      targetId: target.id,
      targetTag: target.user.tag,
      caseId: record.id,
      summary: `Caso #${record.number} · ${humanDuration(seconds)} · ${reason}`,
    });

    await interaction.reply({
      content: `✅ ${target.user.tag} silenziato per ${humanDuration(seconds)} · caso **#${record.number}**`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const purge: Command = {
  data: new SlashCommandBuilder()
    .setName('pulisci')
    .setDescription('Elimina messaggi recenti in questo canale')
    .addIntegerOption((option) =>
      option
        .setName('quantità')
        .setDescription('Quanti messaggi esaminare (1-100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .addUserOption((option) =>
      option.setName('utente').setDescription('Elimina solo i messaggi di questa persona'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageMessages],
  async execute({ client, interaction }) {
    const amount = interaction.options.getInteger('quantità', true);
    const user = interaction.options.getUser('utente');
    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: 'Comando utilizzabile solo nei canali testuali.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const messages = await channel.messages.fetch({ limit: amount });
    const targets = user ? messages.filter((message) => message.author.id === user.id) : messages;

    // bulkDelete ignora i messaggi più vecchi di 14 giorni: è un limite di
    // Discord, non aggirabile.
    const deleted = await channel.bulkDelete(targets, true);

    const record = await createCase({
      guildId: interaction.guildId!,
      type: 'PURGE',
      targetId: user?.id ?? interaction.channelId,
      targetTag: user?.tag ?? channel.name,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      reason: `Pulizia di ${deleted.size} messaggi in #${channel.name}`,
      evidence: { channelId: channel.id, count: deleted.size },
    });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_PURGE',
      actorId: interaction.user.id,
      channelId: channel.id,
      caseId: record.id,
      summary:
        `${deleted.size} messaggi eliminati` +
        (user ? ` di <@${user.id}>` : '') +
        (deleted.size < targets.size
          ? `\n⚠️ ${targets.size - deleted.size} messaggi erano più vecchi di 14 giorni e non sono eliminabili in blocco.`
          : ''),
    });

    await interaction.editReply(
      `✅ Eliminati ${deleted.size} messaggi · caso **#${record.number}**` +
        (deleted.size < targets.size
          ? `\n⚠️ ${targets.size - deleted.size} erano più vecchi di 14 giorni: Discord non consente di eliminarli in blocco.`
          : ''),
    );
  },
};

const quarantine: Command = {
  data: new SlashCommandBuilder()
    .setName('quarantena')
    .setDescription('Isola un membro conservandone i ruoli, oppure revoca la quarantena')
    .addSubcommand((sub) =>
      sub
        .setName('applica')
        .setDescription('Isola il membro')
        .addUserOption((option) =>
          option.setName('utente').setDescription('Chi isolare').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('motivo').setDescription('Motivo').setRequired(true).setMaxLength(500),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoca')
        .setDescription('Restituisce i ruoli precedenti')
        .addUserOption((option) =>
          option.setName('utente').setDescription('Chi liberare').setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    if (sub === 'applica') {
      const target = interaction.options.getMember('utente') as GuildMember | null;
      const reason = interaction.options.getString('motivo', true);
      if (!target) {
        await interaction.editReply('Utente non presente nel server.');
        return;
      }

      const done = await quarantineMember(
        { client, guild: interaction.guild!, config, member: target, module: 'comando manuale' },
        reason,
      );
      await interaction.editReply(
        done
          ? `✅ ${target.user.tag} è in quarantena. I ruoli precedenti sono conservati e verranno restituiti con \`/quarantena revoca\`.`
          : '❌ Quarantena non applicata: verifica che il ruolo di quarantena sia configurato e che il bot possa agire su questo membro.',
      );
      return;
    }

    const user = interaction.options.getUser('utente', true);
    const done = await liftQuarantine(client, interaction.guild!, user.id, interaction.user.id);
    await interaction.editReply(
      done ? `✅ Quarantena revocata, ruoli ripristinati per ${user.tag}` : '❌ Questo utente non risulta in quarantena.',
    );
  },
};

/** Scheda utente: rischio, storico e provvedimenti in un colpo solo. */
const userInfo: Command = {
  data: new SlashCommandBuilder()
    .setName('utente')
    .setDescription('Scheda completa di un membro: rischio, storico, provvedimenti')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Di chi vuoi la scheda').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('utente', true);
    const prisma = getPrisma();

    const [profile, cases, recentEvents] = await Promise.all([
      prisma.userProfile.findUnique({
        where: { guildId_userId: { guildId: interaction.guildId!, userId: user.id } },
      }),
      prisma.case.findMany({
        where: { guildId: interaction.guildId!, targetId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.auditEvent.count({
        where: {
          guildId: interaction.guildId!,
          actorId: user.id,
          createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
      }),
    ]);

    const accountAgeDays = Math.floor((Date.now() - user.createdTimestamp) / 86_400_000);

    const embed = new EmbedBuilder()
      .setTitle(`Scheda di ${user.tag}`)
      .setThumbnail(user.displayAvatarURL())
      .setColor(
        (profile?.riskScore ?? 0) >= 70 ? 0xff0000 : (profile?.riskScore ?? 0) >= 40 ? 0xff9900 : 0x2ecc71,
      )
      .addFields(
        { name: 'ID', value: `\`${user.id}\``, inline: true },
        { name: 'Account creato', value: `${accountAgeDays} giorni fa`, inline: true },
        { name: 'Punteggio di rischio', value: `${profile?.riskScore ?? 0}/100`, inline: true },
        {
          name: 'Segnali',
          value: profile?.riskFlags.length ? profile.riskFlags.join(', ') : 'nessuno',
        },
        { name: 'Provvedimenti totali', value: String(profile?.caseCount ?? 0), inline: true },
        { name: 'Avvertimenti', value: String(profile?.warnCount ?? 0), inline: true },
        { name: 'Eventi negli ultimi 30 giorni', value: String(recentEvents), inline: true },
      );

    if (profile?.quarantinedAt) {
      embed.addFields({
        name: '🚧 In quarantena',
        value: `Dal <t:${Math.floor(profile.quarantinedAt.getTime() / 1000)}:R>\n${profile.quarantineReason ?? ''}`,
      });
    }

    if (profile?.inviteCode) {
      embed.addFields({
        name: 'Entrato con',
        value: `Invito \`${profile.inviteCode}\`` + (profile.invitedBy ? ` di <@${profile.invitedBy}>` : ''),
      });
    }

    if (cases.length > 0) {
      embed.addFields({
        name: 'Ultimi provvedimenti',
        value: cases
          .map(
            (record) =>
              `**#${record.number}** ${record.type} · <t:${Math.floor(record.createdAt.getTime() / 1000)}:d> · ${record.reason.slice(0, 80)}`,
          )
          .join('\n'),
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

/**
 * Annotazione senza sanzione.
 *
 * Serve per il caso più comune della moderazione: qualcosa da ricordare su una
 * persona che non merita un provvedimento. Senza, quelle informazioni restano
 * nella memoria di un moderatore e spariscono quando lascia lo staff.
 */
const note: Command = {
  data: new SlashCommandBuilder()
    .setName('nota')
    .setDescription('Annota qualcosa su un membro, senza sanzionarlo')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Chi annotare').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('testo').setDescription('La nota').setRequired(true).setMaxLength(1000),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ client, interaction }) {
    const user = interaction.options.getUser('utente', true);
    const text = interaction.options.getString('testo', true);

    const record = await createCase({
      guildId: interaction.guildId!,
      type: 'NOTE',
      targetId: user.id,
      targetTag: user.tag,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      reason: text,
    });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_NOTE',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: user.id,
      targetTag: user.tag,
      caseId: record.id,
      summary: `Nota #${record.number} su <@${user.id}>: ${text.slice(0, 200)}`,
    });

    await interaction.reply({
      content:
        `✅ Nota registrata · caso **#${record.number}**\n` +
        'Comparirà nella scheda dell\'utente. Non è una sanzione e non viene comunicata all\'interessato.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

const unmute: Command = {
  data: new SlashCommandBuilder()
    .setName('rimuovi-silenzio')
    .setDescription('Rimuove il silenziamento da un membro')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Chi liberare').setRequired(true),
    )
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo').setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ client, interaction }) {
    const target = interaction.options.getMember('utente') as GuildMember | null;
    const reason = interaction.options.getString('motivo') ?? 'Nessun motivo indicato';
    if (!target) {
      await interaction.reply({ content: 'Utente non presente nel server.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!target.isCommunicationDisabled()) {
      await interaction.reply({
        content: 'Questo membro non è silenziato.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await target.timeout(null, reason);

    // Il caso di silenziamento ancora aperto va chiuso: altrimenti la scheda
    // utente continuerebbe a mostrare una sanzione che non è più in vigore.
    const prisma = getPrisma();
    await prisma.case
      .updateMany({
        where: {
          guildId: interaction.guildId!,
          targetId: target.id,
          type: 'MUTE',
          status: 'ACTIVE',
        },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: interaction.user.id },
      })
      .catch(() => undefined);

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_UNMUTE',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: target.id,
      targetTag: target.user.tag,
      summary: reason,
    });

    await interaction.reply({
      content: `✅ Silenziamento rimosso a ${target.user.tag}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const kick: Command = {
  data: new SlashCommandBuilder()
    .setName('espelli')
    .setDescription('Espelle un membro dal server')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Chi espellere').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo').setRequired(true).setMaxLength(500),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.KickMembers],
  async execute({ client, interaction, config }) {
    const target = interaction.options.getMember('utente') as GuildMember | null;
    const reason = interaction.options.getString('motivo', true);
    if (!target) {
      await interaction.reply({ content: 'Utente non presente nel server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const me = await interaction.guild!.members.fetchMe();
    if (!canActOn(me, target)) {
      await interaction.reply({
        content:
          'Non posso espellere questo membro: ha un ruolo più alto del mio, oppure è il proprietario del server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // L'avviso va mandato *prima* dell'espulsione: dopo, il bot non condivide
    // più alcun server con la persona e non può più scriverle.
    await target
      .send(t(config.general.locale, 'mod.kicked', { guild: interaction.guild!.name, reason }))
      .catch(() => undefined);

    await target.kick(reason);

    const record = await createCase({
      guildId: interaction.guildId!,
      type: 'KICK',
      targetId: target.id,
      targetTag: target.user.tag,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      reason,
    });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_KICK',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: target.id,
      targetTag: target.user.tag,
      caseId: record.id,
      severity: 50,
      summary: `Caso #${record.number} · ${reason}`,
    });

    await interaction.reply({
      content: `✅ ${target.user.tag} espulso · caso **#${record.number}**`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const ban: Command = {
  data: new SlashCommandBuilder()
    .setName('bandisci')
    .setDescription('Bandisce un utente, anche se non è nel server')
    .addStringOption((option) =>
      option
        .setName('utente')
        .setDescription('Menzione o ID dell\'utente')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Motivo').setRequired(true).setMaxLength(500),
    )
    .addIntegerOption((option) =>
      option
        .setName('elimina-giorni')
        .setDescription('Giorni di messaggi da eliminare (0-7)')
        .setMinValue(0)
        .setMaxValue(7),
    )
    .addStringOption((option) =>
      option
        .setName('durata')
        .setDescription('Ban temporaneo: es. 7d, 30d. Vuoto = permanente'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.BanMembers],
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const raw = interaction.options.getString('utente', true);
    const reason = interaction.options.getString('motivo', true);
    const deleteDays = interaction.options.getInteger('elimina-giorni') ?? 0;
    const durationInput = interaction.options.getString('durata');

    // Accetta sia una menzione sia un ID grezzo: bandire chi ha già lasciato il
    // server è il caso normale, e in quel caso non c'è nessuno da menzionare.
    const targetId = raw.replace(/[<@!>]/g, '').trim();
    if (!/^\d{17,20}$/.test(targetId)) {
      await interaction.editReply('ID utente non valido. Usa una menzione oppure l\'ID numerico.');
      return;
    }

    let expiresAt: Date | null = null;
    if (durationInput) {
      const seconds = parseDuration(durationInput);
      if (!seconds) {
        await interaction.editReply('Durata non valida. Usa un formato come `7d` o `30d`.');
        return;
      }
      expiresAt = new Date(Date.now() + seconds * 1000);
    }

    const existing = await interaction.guild!.bans.fetch(targetId).catch(() => null);
    if (existing) {
      await interaction.editReply('Questo utente è già bandito.');
      return;
    }

    const member = await interaction.guild!.members.fetch(targetId).catch(() => null);
    if (member) {
      const me = await interaction.guild!.members.fetchMe();
      if (!canActOn(me, member)) {
        await interaction.editReply(
          'Non posso bandire questo membro: ha un ruolo più alto del mio, oppure è il proprietario del server.',
        );
        return;
      }
      await member
        .send(t(config.general.locale, 'mod.banned', { guild: interaction.guild!.name, reason }))
        .catch(() => undefined);
    }

    await interaction.guild!.bans.create(targetId, {
      reason,
      deleteMessageSeconds: deleteDays * 86400,
    });

    const record = await createCase({
      guildId: interaction.guildId!,
      type: 'BAN',
      targetId,
      targetTag: member?.user.tag ?? null,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      reason,
      expiresAt,
    });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_BAN',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId,
      targetTag: member?.user.tag ?? null,
      caseId: record.id,
      severity: 70,
      summary:
        `Caso #${record.number} · ${reason}` +
        (expiresAt ? `\nBan temporaneo fino a <t:${Math.floor(expiresAt.getTime() / 1000)}:f>` : ''),
    });

    await interaction.editReply(
      `✅ Utente bandito · caso **#${record.number}**` +
        (expiresAt
          ? `\nIl ban verrà revocato automaticamente <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.`
          : ''),
    );
  },
};

const unban: Command = {
  data: new SlashCommandBuilder()
    .setName('revoca-ban')
    .setDescription('Revoca il ban di un utente')
    .addStringOption((option) =>
      option.setName('id').setDescription('ID dell\'utente bandito').setRequired(true),
    )
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo').setMaxLength(500))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.BanMembers],
  async execute({ client, interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetId = interaction.options.getString('id', true).replace(/[<@!>]/g, '').trim();
    const reason = interaction.options.getString('motivo') ?? 'Ban revocato';

    const existing = await interaction.guild!.bans.fetch(targetId).catch(() => null);
    if (!existing) {
      await interaction.editReply('Questo utente non risulta bandito.');
      return;
    }

    await interaction.guild!.bans.remove(targetId, reason);

    const prisma = getPrisma();
    await prisma.case
      .updateMany({
        where: { guildId: interaction.guildId!, targetId, type: 'BAN', status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: interaction.user.id },
      })
      .catch(() => undefined);

    const record = await createCase({
      guildId: interaction.guildId!,
      type: 'UNBAN',
      targetId,
      targetTag: existing.user.tag,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      reason,
    });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'MOD_UNBAN',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId,
      targetTag: existing.user.tag,
      caseId: record.id,
      summary: `Caso #${record.number} · ${reason}`,
    });

    await interaction.editReply(`✅ Ban revocato per ${existing.user.tag} · caso **#${record.number}**`);
  },
};

export const moderationCommands: Command[] = [
  note,
  warn,
  mute,
  unmute,
  kick,
  ban,
  unban,
  purge,
  quarantine,
  userInfo,
];
