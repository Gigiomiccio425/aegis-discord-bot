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
import { t } from '../core/i18n.js';
import { recordEvent } from '../logging/auditLogger.js';

/* ═══════════════════════════════════════════════════════════════════════
   VERIFICA D'INGRESSO

   Un pulsante, non un CAPTCHA. Il ragionamento: i bot che entrano in massa
   durante un raid non premono pulsanti, perché farlo richiede di gestire le
   interazioni di Discord — molto più lavoro che limitarsi a entrare e
   spammare. Un CAPTCHA fermerebbe qualcosa in più, ma allontana anche una
   parte degli utenti veri, e il guadagno non vale il costo.

   Il messaggio è persistente e sopravvive ai riavvii: l'identificativo del
   pulsante (`aegis:verify`) porta con sé tutto ciò che serve, quindi non
   dipende da alcuno stato in memoria.
   ═══════════════════════════════════════════════════════════════════════ */

const verification: Command = {
  data: new SlashCommandBuilder()
    .setName('verifica')
    .setDescription("Gestisce il gate di verifica all'ingresso")
    .addSubcommand((sub) =>
      sub
        .setName('pubblica')
        .setDescription('Pubblica il messaggio con il pulsante di verifica')
        .addChannelOption((option) =>
          option
            .setName('canale')
            .setDescription('Dove pubblicarlo (default: il canale corrente)')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((option) =>
          option.setName('titolo').setDescription('Titolo del messaggio').setMaxLength(200),
        )
        .addStringOption((option) =>
          option.setName('testo').setDescription('Testo del messaggio').setMaxLength(2000),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('stato').setDescription('Verifica che la configurazione sia completa'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ client, interaction, config }) {
    const settings = config.security.verification;
    const guild = interaction.guild!;
    const sub = interaction.options.getSubcommand();

    /* ── Diagnosi della configurazione ──────────────────────────────── */
    const problems: string[] = [];
    if (!settings.enabled) {
      problems.push('Il modulo di verifica è disattivato: attivalo dal pannello.');
    }
    if (!settings.verifiedRoleId) {
      problems.push(
        'Manca il **ruolo verificato**: è quello che viene assegnato a chi supera la verifica.',
      );
    }
    if (!settings.quarantineRoleId && !config.general.quarantineRoleId) {
      problems.push(
        'Manca il **ruolo di quarantena**: senza, chi entra non è isolato e la verifica non serve a nulla.',
      );
    }

    if (sub === 'stato') {
      await interaction.reply({
        content:
          problems.length === 0
            ? '✅ Configurazione completa. Pubblica il messaggio con `/verifica pubblica`.'
            : `⚠️ Da sistemare:\n${problems.map((line) => `• ${line}`).join('\n')}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (problems.length > 0) {
      await interaction.reply({
        content:
          `⚠️ Non posso pubblicare la verifica finché la configurazione non è completa:\n` +
          problems.map((line) => `• ${line}`).join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Ordine di precedenza: il canale indicato nel comando, poi quello
    // configurato per la verifica, e solo come ultima risorsa quello corrente.
    // Chi ha configurato un canale dedicato non deve doverlo ripetere ogni volta.
    const configuredChannel = settings.verifyChannelId
      ? ((await guild.channels.fetch(settings.verifyChannelId).catch(() => null)) as TextChannel | null)
      : null;

    const channel = (interaction.options.getChannel('canale') ??
      configuredChannel ??
      interaction.channel) as TextChannel;

    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply('Serve un canale testuale.');
      return;
    }

    const me = await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
      await interaction.editReply(`Non posso scrivere in <#${channel.id}>.`);
      return;
    }

    // Il ruolo verificato deve stare sotto quello del bot, altrimenti
    // l'assegnazione fallirà a ogni singola verifica.
    const verifiedRole = guild.roles.cache.get(settings.verifiedRoleId!);
    if (verifiedRole && verifiedRole.position >= me.roles.highest.position) {
      await interaction.editReply(
        `⚠️ Il ruolo <@&${verifiedRole.id}> è più in alto del ruolo del bot: non potrei assegnarlo. ` +
          'Sposta il ruolo di Aegis più in alto nella lista dei ruoli.',
      );
      return;
    }

    const title = interaction.options.getString('titolo') ?? `Benvenuto in ${guild.name}`;
    const body =
      interaction.options.getString('testo') ??
      t(config.general.locale, 'verify.prompt', { guild: guild.name });

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(body)
      .setColor(0x5865f2)
      .setFooter({
        text:
          settings.minDelaySec > 0
            ? `Il pulsante è attivo dopo ${settings.minDelaySec} secondi dal tuo ingresso.`
            : 'Premi il pulsante per accedere.',
      });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('aegis:verify')
        .setLabel(t(config.general.locale, 'verify.button'))
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
    );

    const message = await channel.send({ embeds: [embed], components: [row] });

    await recordEvent(client, {
      guildId: guild.id,
      type: 'PANEL_ACTION',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      channelId: channel.id,
      messageId: message.id,
      summary: `Messaggio di verifica pubblicato in <#${channel.id}>`,
    });

    await interaction.editReply(
      `✅ Verifica pubblicata in <#${channel.id}>.\n\n` +
        'Ricorda: il ruolo di quarantena deve negare l\'invio di messaggi in tutti i canali tranne ' +
        'quello della verifica, altrimenti chi non ha ancora verificato può scrivere lo stesso.',
    );
  },
};

export const verificationCommands: Command[] = [verification];
