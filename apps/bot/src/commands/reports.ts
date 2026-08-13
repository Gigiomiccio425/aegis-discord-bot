/* ═══════════════════════════════════════════════════════════════════════
   SEGNALAZIONI

   Chi vede qualcosa di sbagliato ha due strade oggi: scrivere in chat — e
   allora ne parla mezzo server, spesso litigando — o mandare un messaggio
   privato a un moderatore, che è privato per davvero e quindi invisibile agli
   altri moderatori.

   Qui la segnalazione arriva in un canale riservato, con le prove congelate al
   momento dell'invio: se chi ha scritto il messaggio lo cancella subito dopo,
   la copia resta. E accanto ci sono i pulsanti, perché il tempo fra «ho letto
   la segnalazione» e «ho agito» è quello in cui il danno continua.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js';
import type { Command } from './types.js';
import { recordEvent } from '../logging/auditLogger.js';

/**
 * I pulsanti che accompagnano ogni segnalazione.
 *
 * Esportata perché serve anche a chi ripubblica una segnalazione da altrove —
 * e perché avere due elenchi di pulsanti che devono restare uguali è il modo
 * più semplice per ritrovarsi con due comportamenti diversi.
 */
export function pulsantiSegnalazione(targetId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`aegis:mod:mute10:${targetId}`)
        .setLabel('Silenzia 10 min')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`aegis:mod:mute60:${targetId}`)
        .setLabel('Silenzia 1 ora')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`aegis:mod:quarantena:${targetId}`)
        .setLabel('Quarantena')
        .setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`aegis:mod:kick:${targetId}`)
        .setLabel('Espelli')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`aegis:mod:ban:${targetId}`)
        .setLabel('Bandisci')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`aegis:mod:archivia:${targetId}`)
        .setLabel('Archivia')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const segnala: Command = {
  data: new SlashCommandBuilder()
    .setName('segnala')
    .setDescription('Segnala una persona o un messaggio allo staff, in privato')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Chi stai segnalando').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('motivo')
        .setDescription('Cosa è successo')
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addStringOption((option) =>
      option
        .setName('messaggio')
        .setDescription('Link al messaggio, se ce n\'è uno')
        .setMaxLength(200),
    )
    .setDMPermission(false),
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const bersaglio = interaction.options.getUser('utente', true);
    const motivo = interaction.options.getString('motivo', true);
    const collegamento = interaction.options.getString('messaggio');

    if (bersaglio.id === interaction.user.id) {
      await interaction.editReply('Non puoi segnalare te stesso.');
      return;
    }
    if (bersaglio.bot) {
      await interaction.editReply(
        'Per un bot conviene avvisare direttamente un amministratore: le segnalazioni servono per le persone.',
      );
      return;
    }

    const canaleId =
      config.security.safety.reportChannelId ?? config.general.alertChannelId ?? null;

    if (!canaleId) {
      await interaction.editReply(
        'Le segnalazioni non hanno un canale dove arrivare. Chiedi a un amministratore di eseguire ' +
          '`/prepara-server`, oppure di impostare il canale delle segnalazioni dal pannello.',
      );
      return;
    }

    const canale = await client.channels.fetch(canaleId).catch(() => null);
    if (!canale || canale.type !== ChannelType.GuildText) {
      await interaction.editReply('Il canale delle segnalazioni non è raggiungibile.');
      return;
    }

    const membro = await interaction.guild?.members.fetch(bersaglio.id).catch(() => null);
    const entrato = membro?.joinedTimestamp
      ? `<t:${Math.floor(membro.joinedTimestamp / 1000)}:R>`
      : 'sconosciuto';

    const embed = new EmbedBuilder()
      .setTitle('🚩 Segnalazione')
      .setColor(0xd8b45f)
      .setDescription(motivo.slice(0, 2000))
      .addFields(
        { name: 'Segnalato', value: `<@${bersaglio.id}>\n\`${bersaglio.tag}\``, inline: true },
        { name: 'Da', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Nel canale', value: `<#${interaction.channelId}>`, inline: true },
        {
          name: 'Account',
          value:
            `Creato <t:${Math.floor(bersaglio.createdTimestamp / 1000)}:R>\n` +
            `Entrato ${entrato}`,
          inline: true,
        },
      )
      .setThumbnail(bersaglio.displayAvatarURL())
      .setFooter({ text: `ID: ${bersaglio.id}` })
      .setTimestamp();

    if (collegamento) {
      embed.addFields({ name: 'Messaggio', value: collegamento.slice(0, 300), inline: false });
    }

    await (canale as TextChannel).send({
      embeds: [embed],
      components: pulsantiSegnalazione(bersaglio.id),
      // Nessuna menzione parte da qui: la segnalazione è già nel canale dello
      // staff, e svegliare tutti per ogni riga sarebbe il modo di far
      // silenziare il canale.
      allowedMentions: { parse: [] },
    });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'SECURITY_REPORT_FILED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: bersaglio.id,
      targetTag: bersaglio.tag,
      channelId: interaction.channelId,
      severity: 30,
      summary: `Segnalazione di <@${interaction.user.id}> su <@${bersaglio.id}>: ${motivo.slice(0, 200)}`,
      payload: { motivo, collegamento },
    });

    await interaction.editReply(
      '✅ Segnalazione inviata allo staff. Il tuo nome è visibile solo a loro.',
    );
  },
};

/**
 * Lo stesso pannello di pulsanti, su una persona qualsiasi.
 *
 * Serve al moderatore che ha visto la cosa con i propri occhi e non vuole
 * ricordarsi cinque comandi con i loro argomenti: apre il pannello sulla
 * persona e sceglie.
 */
const azioni: Command = {
  data: new SlashCommandBuilder()
    .setName('azioni')
    .setDescription('Apre i pulsanti rapidi di moderazione su una persona')
    .addUserOption((option) =>
      option.setName('utente').setDescription('Su chi').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ interaction }) {
    const bersaglio = interaction.options.getUser('utente', true);

    const embed = new EmbedBuilder()
      .setTitle('Azioni rapide')
      .setColor(0x6f8a95)
      .setDescription(`Su <@${bersaglio.id}> (\`${bersaglio.tag}\`)`)
      .setFooter({ text: `ID: ${bersaglio.id}` });

    await interaction.reply({
      embeds: [embed],
      components: pulsantiSegnalazione(bersaglio.id),
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const reportCommands: Command[] = [segnala, azioni];
