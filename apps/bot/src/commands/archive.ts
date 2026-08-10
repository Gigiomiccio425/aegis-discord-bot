import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js';
import { buildTranscript, getPrisma } from '@aegis/db';
import type { Command } from './types.js';
import { restoreChannelMessages } from '../archive/restore.js';
import { recordEvent } from '../logging/auditLogger.js';

/* ═══════════════════════════════════════════════════════════════════════
   ARCHIVIO DEI MESSAGGI

   Discord non consente di ripristinare i messaggi eliminati: non esiste alcun
   endpoint per farlo, e nessun bot può aggirarlo. Ciò che si può fare è quello
   che fa Aegis — tenere una copia mentre i messaggi passano, e poi:

     • esportarla come trascrizione HTML consultabile (prova, indagine, archivio)
     • ripubblicarla in un canale come *ricostruzione*, dichiarata come tale

   La ricostruzione non è l'originale e non finge di esserlo: i messaggi
   ricompaiono tramite webhook, con la data originale nel testo e un avviso in
   testa al canale. Chiunque legga deve poter distinguere una ricostruzione da
   una cronologia autentica.
   ═══════════════════════════════════════════════════════════════════════ */

const archive: Command = {
  data: new SlashCommandBuilder()
    .setName('archivio')
    .setDescription('Trascrizioni e ricostruzione dei messaggi archiviati')
    .addSubcommand((sub) =>
      sub
        .setName('esporta')
        .setDescription('Genera una trascrizione HTML di un canale')
        .addChannelOption((option) =>
          option
            .setName('canale')
            .setDescription('Canale da esportare (default: quello corrente)')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addIntegerOption((option) =>
          option
            .setName('giorni')
            .setDescription('Quanti giorni indietro (default: tutto)')
            .setMinValue(1)
            .setMaxValue(3650),
        )
        .addIntegerOption((option) =>
          option
            .setName('limite')
            .setDescription('Numero massimo di messaggi (default 5000)')
            .setMinValue(1)
            .setMaxValue(20000),
        )
        .addBooleanOption((option) =>
          option
            .setName('solo-eliminati')
            .setDescription('Esporta soltanto i messaggi eliminati'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stato')
        .setDescription("Quanto è stato archiviato, canale per canale"),
    )
    .addSubcommand((sub) =>
      sub
        .setName('ricostruisci')
        .setDescription('Ripubblica i messaggi archiviati di un canale (ricostruzione)')
        .addChannelOption((option) =>
          option
            .setName('origine')
            .setDescription('Canale di cui ripubblicare i messaggi')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName('destinazione')
            .setDescription('Dove ripubblicarli')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('limite')
            .setDescription('Quanti messaggi al massimo (default 200)')
            .setMinValue(1)
            .setMaxValue(1000),
        )
        .addIntegerOption((option) =>
          option.setName('giorni').setDescription('Solo gli ultimi N giorni').setMinValue(1),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageMessages],
  async execute({ client, interaction, config }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild!;
    const prisma = getPrisma();

    /* ── Stato dell'archivio ────────────────────────────────────────── */
    if (sub === 'stato') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const [byChannel, total, deleted, attachments] = await Promise.all([
        prisma.messageArchive.groupBy({
          by: ['channelId'],
          where: { guildId: guild.id },
          _count: true,
          orderBy: { _count: { channelId: 'desc' } },
          take: 15,
        }),
        prisma.messageArchive.count({ where: { guildId: guild.id } }),
        prisma.messageArchive.count({ where: { guildId: guild.id, deletedAt: { not: null } } }),
        prisma.attachmentArchive.count({ where: { guildId: guild.id } }),
      ]);

      const embed = new EmbedBuilder()
        .setTitle('Stato dell\'archivio')
        .setColor(0x5865f2)
        .setDescription(
          byChannel.length > 0
            ? byChannel
                .map((entry) => `<#${entry.channelId}> — ${entry._count.toLocaleString('it-IT')}`)
                .join('\n')
            : 'Nessun messaggio archiviato. Verifica che il registro sia attivo e che la modalità ' +
              'di conservazione del contenuto non sia impostata su «nessuna registrazione».',
        )
        .addFields(
          { name: 'Messaggi totali', value: total.toLocaleString('it-IT'), inline: true },
          { name: 'Di cui eliminati', value: deleted.toLocaleString('it-IT'), inline: true },
          { name: 'Allegati salvati', value: attachments.toLocaleString('it-IT'), inline: true },
          {
            name: 'Modalità di conservazione',
            value: `\`${config.logging.messageContent}\``,
          },
          {
            name: 'Conservazione messaggi',
            value:
              (config.logging.retentionDays.MESSAGE ?? 90) === 0
                ? 'illimitata'
                : `${config.logging.retentionDays.MESSAGE} giorni`,
            inline: true,
          },
        );

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    /* ── Esportazione ───────────────────────────────────────────────── */
    if (sub === 'esporta') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const channel = (interaction.options.getChannel('canale') ?? interaction.channel) as TextChannel;
      const days = interaction.options.getInteger('giorni');
      const limit = interaction.options.getInteger('limite') ?? 5000;
      const onlyDeleted = interaction.options.getBoolean('solo-eliminati') ?? false;

      const result = await buildTranscript({
        guildId: guild.id,
        channelId: channel.id,
        channelName: channel.name,
        guildName: guild.name,
        limit,
        since: days ? new Date(Date.now() - days * 86_400_000) : undefined,
        includeDeleted: true,
      });

      if (result.messageCount === 0) {
        await interaction.editReply(
          'Nessun messaggio archiviato per questo canale nel periodo richiesto.\n' +
            'L\'archivio contiene solo ciò che il bot ha visto passare: i messaggi precedenti ' +
            'alla sua installazione non ci sono.',
        );
        return;
      }

      const file = new AttachmentBuilder(Buffer.from(result.html, 'utf8'), {
        name: `trascrizione-${channel.name}-${new Date().toISOString().slice(0, 10)}.html`,
      });

      await recordEvent(client, {
        guildId: guild.id,
        type: 'ARCHIVE_EXPORTED',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        channelId: channel.id,
        severity: 20,
        summary:
          `Trascrizione esportata di <#${channel.id}>: ${result.messageCount} messaggi ` +
          `(${result.deletedCount} eliminati)`,
        payload: {
          messageCount: result.messageCount,
          deletedCount: result.deletedCount,
          onlyDeleted,
        },
      });

      await interaction.editReply({
        content:
          `✅ ${result.messageCount} messaggi · ${result.deletedCount} eliminati · ` +
          `${result.attachmentCount} allegati\n` +
          (result.oldest
            ? `Dal <t:${Math.floor(result.oldest.getTime() / 1000)}:d> al <t:${Math.floor((result.newest ?? result.oldest).getTime() / 1000)}:d>`
            : ''),
        files: [file],
      });
      return;
    }

    /* ── Ricostruzione ──────────────────────────────────────────────── */
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const source = interaction.options.getChannel('origine', true) as TextChannel;
    const target = interaction.options.getChannel('destinazione', true) as TextChannel;
    const limit = interaction.options.getInteger('limite') ?? 200;
    const days = interaction.options.getInteger('giorni');

    const report = await restoreChannelMessages(client, {
      guildId: guild.id,
      sourceChannelId: source.id,
      sourceChannelName: source.name,
      targetChannel: target,
      limit,
      since: days ? new Date(Date.now() - days * 86_400_000) : undefined,
      actorId: interaction.user.id,
    });

    await interaction.editReply(
      report.published === 0
        ? 'Nessun messaggio archiviato da ricostruire per quel canale e periodo.'
        : `✅ Ricostruiti ${report.published} messaggi in <#${target.id}>` +
            (report.skipped > 0 ? ` · ${report.skipped} saltati` : '') +
            '\n\n⚠️ Sono **ricostruzioni**, non i messaggi originali: gli allegati non vengono ' +
            'ripubblicati e le date compaiono nel testo. Il canale riporta un avviso in testa.',
    );
  },
};

export const archiveCommands: Command[] = [archive];
