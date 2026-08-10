import {
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import type { Command } from './types.js';
import { parseDurationSeconds } from '../integrations/duration.js';
import { recordEvent } from '../logging/auditLogger.js';

/* ═══════════════════════════════════════════════════════════════════════
   EVENTI PROGRAMMATI

   Gli eventi sono nativi di Discord: questo comando non li reimplementa, li
   crea. Il valore aggiunto sta altrove — nei promemoria anticipati e nel ruolo
   RSVP, che Discord non offre.

   Chi può gestirli lo decide `integrations.events.managerRoleIds`; se la lista
   è vuota vale il permesso Discord di gestire gli eventi.
   ═══════════════════════════════════════════════════════════════════════ */

const event: Command = {
  data: new SlashCommandBuilder()
    .setName('evento')
    .setDescription('Crea e gestisce gli eventi programmati del server')
    .addSubcommand((sub) =>
      sub
        .setName('crea')
        .setDescription('Programma un nuovo evento')
        .addStringOption((option) =>
          option.setName('nome').setDescription("Nome dell'evento").setRequired(true).setMaxLength(100),
        )
        .addStringOption((option) =>
          option
            .setName('fra')
            .setDescription('Fra quanto inizia: es. 2h, 3d, 1d12h')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('descrizione').setDescription('Di cosa si tratta').setMaxLength(1000),
        )
        .addChannelOption((option) =>
          option
            .setName('vocale')
            .setDescription('Canale vocale in cui si svolge')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        )
        .addStringOption((option) =>
          option.setName('luogo').setDescription('Luogo esterno, se non è in vocale').setMaxLength(100),
        )
        .addStringOption((option) =>
          option.setName('durata').setDescription('Quanto dura: es. 2h. Serve per i luoghi esterni'),
        ),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Eventi in programma'))
    .addSubcommand((sub) =>
      sub
        .setName('annulla')
        .setDescription('Annulla un evento in programma')
        .addStringOption((option) =>
          option.setName('id').setDescription("ID dell'evento").setRequired(true),
        ),
    )
    .setDMPermission(false),
  async execute({ client, interaction, config }) {
    const settings = config.integrations.events;
    if (!settings.enabled) {
      await interaction.reply({
        content: 'Il modulo eventi è disattivato. Attivalo dal pannello.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guild = interaction.guild!;
    const member = interaction.member as GuildMember;
    const sub = interaction.options.getSubcommand();

    if (sub === 'lista') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const events = await guild.scheduledEvents.fetch().catch(() => null);
      const scheduled = [...(events?.values() ?? [])].filter(
        (entry) => entry.status === GuildScheduledEventStatus.Scheduled,
      );

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Eventi in programma')
            .setColor(0x5865f2)
            .setDescription(
              scheduled.length === 0
                ? 'Nessun evento in programma.'
                : scheduled
                    .map(
                      (entry) =>
                        `**${entry.name}** · \`${entry.id}\`\n` +
                        `<t:${Math.floor((entry.scheduledStartTimestamp ?? 0) / 1000)}:F> · ` +
                        `${entry.userCount ?? 0} interessati`,
                    )
                    .join('\n\n'),
            )
            .setFooter({
              text:
                settings.reminderMinutes.length > 0
                  ? `Promemoria automatici: ${settings.reminderMinutes.map((m) => (m >= 60 ? `${m / 60}h` : `${m}m`)).join(', ')} prima`
                  : 'Nessun promemoria configurato',
            }),
        ],
      });
      return;
    }

    // Il controllo dei permessi vale solo per le operazioni che modificano:
    // vedere l'elenco è innocuo.
    const canManage =
      settings.managerRoleIds.length > 0
        ? settings.managerRoleIds.some((roleId) => member.roles.cache.has(roleId))
        : member.permissions.has(PermissionFlagsBits.ManageEvents);

    if (!canManage) {
      await interaction.reply({
        content: 'Non hai i permessi per gestire gli eventi di questo server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'annulla') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const id = interaction.options.getString('id', true);
      const target = await guild.scheduledEvents.fetch(id).catch(() => null);
      if (!target) {
        await interaction.editReply('Evento non trovato.');
        return;
      }

      await target.delete();
      await interaction.editReply(`✅ Evento **${target.name}** annullato.`);
      return;
    }

    /* ── Creazione ───────────────────────────────────────────────────── */
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const startIn = parseDurationSeconds(interaction.options.getString('fra', true));
    if (!startIn) {
      await interaction.editReply('Momento di inizio non valido. Usa formati come `2h`, `3d`, `1d12h`.');
      return;
    }

    const voiceChannel = interaction.options.getChannel('vocale');
    const location = interaction.options.getString('luogo');

    if (!voiceChannel && !location) {
      await interaction.editReply(
        'Serve un canale vocale oppure un luogo esterno: Discord non accetta eventi senza una destinazione.',
      );
      return;
    }

    const startAt = new Date(Date.now() + startIn * 1000);

    // Gli eventi con luogo esterno richiedono obbligatoriamente una fine:
    // Discord rifiuta la creazione senza `scheduledEndTime`.
    let endAt: Date | undefined;
    if (!voiceChannel) {
      const duration = parseDurationSeconds(interaction.options.getString('durata') ?? '2h');
      endAt = new Date(startAt.getTime() + (duration ?? 7200) * 1000);
    }

    const created = await guild.scheduledEvents
      .create({
        name: interaction.options.getString('nome', true),
        description: interaction.options.getString('descrizione') ?? undefined,
        scheduledStartTime: startAt,
        scheduledEndTime: endAt,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: voiceChannel
          ? voiceChannel.type === ChannelType.GuildStageVoice
            ? GuildScheduledEventEntityType.StageInstance
            : GuildScheduledEventEntityType.Voice
          : GuildScheduledEventEntityType.External,
        channel: voiceChannel ? voiceChannel.id : undefined,
        entityMetadata: location ? { location } : undefined,
        reason: `Evento creato da ${interaction.user.tag}`,
      })
      .catch((error: Error) => {
        void interaction.editReply(`Creazione fallita: ${error.message}`);
        return null;
      });

    if (!created) return;

    await recordEvent(client, {
      guildId: guild.id,
      type: 'EVENT_CREATED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      summary:
        `Evento **${created.name}** programmato per ` +
        `<t:${Math.floor(startAt.getTime() / 1000)}:F>`,
      payload: { eventId: created.id, location, channelId: voiceChannel?.id },
    });

    const announceChannel = settings.announceChannelId;
    if (announceChannel) {
      const channel = await client.channels.fetch(announceChannel).catch(() => null);
      if (channel?.isTextBased() && 'send' in channel) {
        await channel
          .send({
            content: `📅 Nuovo evento: **${created.name}** — <t:${Math.floor(startAt.getTime() / 1000)}:F>\n${created.url}`,
            allowedMentions: { parse: [] },
          })
          .catch(() => undefined);
      }
    }

    await interaction.editReply(
      `✅ Evento creato: **${created.name}** · \`${created.id}\`\n` +
        (settings.reminderMinutes.length > 0
          ? `Promemoria automatici ${settings.reminderMinutes.map((m) => (m >= 60 ? `${m / 60}h` : `${m}m`)).join(', ')} prima dell'inizio.`
          : '⚠️ Nessun promemoria configurato: impostali dal pannello.') +
        (settings.rsvpRoleId
          ? `\nChi si iscrive riceverà il ruolo <@&${settings.rsvpRoleId}>.`
          : ''),
    );
  },
};

export const eventCommands: Command[] = [event];
