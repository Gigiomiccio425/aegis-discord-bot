/* ═══════════════════════════════════════════════════════════════════════
   ANNUNCI CONFIGURABILI DA DISCORD

   Le integrazioni che pubblicano un messaggio — dirette Twitch, giveaway,
   nuovi video — erano configurabili solo dal pannello. Funziona, ma impone di
   uscire da Discord, aprire un browser e trovare il campo giusto per cambiare
   una riga di testo o il ruolo da menzionare.

   Questi comandi fanno le stesse modifiche restando dov'è la conversazione.
   Scrivono nella medesima configurazione che il pannello mostra: non esiste un
   secondo posto dove le impostazioni vivono, e le due strade non possono
   divergere.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { GuildConfigSchema } from '@angel/shared';
import type { Command } from './types.js';
import { getGuildConfig, saveGuildConfig } from '../core/config.js';
import { recordEvent } from '../logging/auditLogger.js';

const twitch: Command = {
  data: new SlashCommandBuilder()
    .setName('twitch')
    .setDescription('Avvisi di diretta: streamer, canale, ruolo da menzionare e testo')
    .addSubcommand((sub) =>
      sub
        .setName('aggiungi')
        .setDescription('Segue uno streamer e annuncia le sue dirette')
        .addStringOption((option) =>
          option
            .setName('streamer')
            .setDescription('Nome del canale Twitch, senza l\'indirizzo')
            .setRequired(true)
            .setMaxLength(64),
        )
        .addChannelOption((option) =>
          option
            .setName('canale')
            .setDescription('Dove annunciare')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addRoleOption((option) =>
          option.setName('menziona').setDescription('Ruolo da avvisare a ogni diretta'),
        )
        .addRoleOption((option) =>
          option.setName('ruolo-live').setDescription('Ruolo assegnato mentre è in diretta'),
        )
        .addUserOption((option) =>
          option
            .setName('utente-live')
            .setDescription('Chi è lo streamer su Discord: senza, il ruolo non va a nessuno'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('messaggio')
        .setDescription('Cambia il testo dell\'annuncio di uno streamer')
        .addStringOption((option) =>
          option.setName('streamer').setDescription('Quale streamer').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('testo')
            .setDescription('Variabili: {streamer} {title} {game} {url} {viewers}')
            .setRequired(true)
            .setMaxLength(1900),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rimuovi')
        .setDescription('Smette di seguire uno streamer')
        .addStringOption((option) =>
          option.setName('streamer').setDescription('Quale streamer').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Streamer seguiti e loro impostazioni'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ client, interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();

    // Si rilegge dal database invece di usare la copia passata al comando:
    // quella ha già l'interruttore generale applicato, e salvarla scriverebbe
    // «tutto spento» in modo permanente.
    const config = GuildConfigSchema.parse(structuredClone(await getGuildConfig(guildId)));
    const settings = config.integrations.twitch;

    if (sub === 'lista') {
      if (settings.streamers.length === 0) {
        await interaction.editReply(
          'Nessuno streamer seguito.\nAggiungine uno con `/twitch aggiungi`.',
        );
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('Streamer seguiti')
        .setColor(0x9146ff)
        .setDescription(
          settings.streamers
            .map((streamer) =>
              [
                `**${streamer.login}**`,
                streamer.announceChannelId ? `Canale: <#${streamer.announceChannelId}>` : 'Canale: non impostato',
                streamer.mentionRoleId ? `Menziona: <@&${streamer.mentionRoleId}>` : 'Menziona: nessuno',
                streamer.liveRoleId ? `Ruolo in diretta: <@&${streamer.liveRoleId}>` : null,
                `Testo: ${streamer.template.slice(0, 120).replace(/\n/g, ' ⏎ ')}`,
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n')
            .slice(0, 4000),
        )
        .setFooter({
          text: settings.enabled
            ? 'Modulo attivo'
            : 'Modulo SPENTO: nessun annuncio parte finché non lo accendi dal pannello',
        });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const login = interaction.options.getString('streamer', true).trim().toLowerCase();

    if (sub === 'rimuovi') {
      const before = settings.streamers.length;
      settings.streamers = settings.streamers.filter(
        (streamer) => streamer.login.toLowerCase() !== login,
      );
      if (settings.streamers.length === before) {
        await interaction.editReply(`**${login}** non era fra quelli seguiti.`);
        return;
      }
      await persist(guildId, config, interaction.user.id, ['integrations.twitch.streamers']);
      await interaction.editReply(`✅ **${login}** rimosso.`);
      return;
    }

    if (sub === 'messaggio') {
      const streamer = settings.streamers.find((entry) => entry.login.toLowerCase() === login);
      if (!streamer) {
        await interaction.editReply(
          `**${login}** non è fra quelli seguiti. Aggiungilo prima con \`/twitch aggiungi\`.`,
        );
        return;
      }
      streamer.template = interaction.options.getString('testo', true).replace(/\\n/g, '\n');
      await persist(guildId, config, interaction.user.id, ['integrations.twitch.streamers']);
      await interaction.editReply(
        `✅ Testo aggiornato per **${login}**.\n\nAnteprima:\n${preview(streamer.template, login)}`,
      );
      return;
    }

    /* aggiungi */
    const channel = interaction.options.getChannel('canale', true);
    const mention = interaction.options.getRole('menziona');
    const liveRole = interaction.options.getRole('ruolo-live');
    const liveUser = interaction.options.getUser('utente-live');

    const existing = settings.streamers.find((entry) => entry.login.toLowerCase() === login);
    if (existing) {
      existing.announceChannelId = channel.id;
      existing.mentionRoleId = mention?.id ?? existing.mentionRoleId;
      existing.liveRoleId = liveRole?.id ?? existing.liveRoleId;
      existing.discordUserId = liveUser?.id ?? existing.discordUserId;
    } else {
      settings.streamers.push({
        enabled: true,
        login,
        announceChannelId: channel.id,
        mentionRoleId: mention?.id ?? null,
        liveRoleId: liveRole?.id ?? null,
        discordUserId: liveUser?.id ?? null,
        clipChannelId: null,
        template: '🔴 **{streamer}** è in diretta!\n**{title}**\n{game}\n{url}',
        cooldownMinutes: 60,
        clipMinViews: 0,
      });
    }

    await persist(guildId, config, interaction.user.id, ['integrations.twitch.streamers']);

    await interaction.editReply(
      `✅ **${login}** ${existing ? 'aggiornato' : 'aggiunto'}.\n` +
        `Annunci in <#${channel.id}>${mention ? `, menzionando <@&${mention.id}>` : ''}.\n` +
        (settings.enabled
          ? '\nPer cambiare il testo: `/twitch messaggio`'
          : '\n⚠️ Il modulo Twitch è **spento**: accendilo dal pannello, sezione Integrazioni → Twitch.'),
    );

    await recordEvent(client, {
      guildId,
      type: 'INTEGRATION_CREATED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      channelId: channel.id,
      summary: `Twitch: **${login}** ${existing ? 'aggiornato' : 'aggiunto'} da <@${interaction.user.id}>`,
    });
  },
};

const announceDefaults: Command = {
  data: new SlashCommandBuilder()
    .setName('annunci')
    .setDescription('Impostazioni comuni degli annunci automatici')
    .addSubcommand((sub) =>
      sub
        .setName('giveaway')
        .setDescription('Ruolo da menzionare e testo di apertura dei giveaway')
        .addRoleOption((option) =>
          option.setName('menziona').setDescription('Ruolo avvisato a ogni nuovo giveaway'),
        )
        .addStringOption((option) =>
          option
            .setName('testo')
            .setDescription('Testo sopra il riquadro. Variabili: {premio} {vincitori} {fine}')
            .setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('eventi')
        .setDescription('Canale degli annunci per gli eventi programmati')
        .addChannelOption((option) =>
          option
            .setName('canale')
            .setDescription('Dove annunciare')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) => sub.setName('stato').setDescription('Riepilogo di come sono configurati'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();
    const config = GuildConfigSchema.parse(structuredClone(await getGuildConfig(guildId)));

    if (sub === 'stato') {
      const giveaways = config.integrations.giveaways;
      const events = config.integrations.events;
      await interaction.editReply(
        '**Giveaway**\n' +
          `Menziona: ${giveaways.mentionRoleId ? `<@&${giveaways.mentionRoleId}>` : 'nessuno'}\n` +
          `Testo: ${giveaways.announceTemplate || '(nessuno)'}\n\n` +
          '**Eventi**\n' +
          `Canale: ${events.announceChannelId ? `<#${events.announceChannelId}>` : 'non impostato'}\n` +
          `Promemoria: ${events.reminderMinutes.join(', ')} minuti prima`,
      );
      return;
    }

    if (sub === 'giveaway') {
      const mention = interaction.options.getRole('menziona');
      const text = interaction.options.getString('testo');
      if (!mention && text === null) {
        await interaction.editReply('Indica almeno il ruolo o il testo.');
        return;
      }
      if (mention) config.integrations.giveaways.mentionRoleId = mention.id;
      if (text !== null) config.integrations.giveaways.announceTemplate = text.replace(/\\n/g, '\n');

      await persist(guildId, config, interaction.user.id, ['integrations.giveaways']);
      await interaction.editReply('✅ Impostazioni dei giveaway aggiornate.');
      return;
    }

    /* eventi */
    const channel = interaction.options.getChannel('canale');
    config.integrations.events.announceChannelId = channel?.id ?? null;
    await persist(guildId, config, interaction.user.id, ['integrations.events.announceChannelId']);
    await interaction.editReply(
      channel ? `✅ Gli eventi verranno annunciati in <#${channel.id}>.` : '✅ Annunci degli eventi disattivati.',
    );
  },
};

/**
 * Salva e propaga.
 *
 * `saveGuildConfig` scrive nel database, registra la modifica nello storico e
 * pubblica l'invalidazione: il bot e il pannello vedono il valore nuovo senza
 * riavviare nulla. È la stessa strada che percorre una modifica dal pannello,
 * e per questo le due non possono divergere.
 */
async function persist(
  guildId: string,
  config: Parameters<typeof saveGuildConfig>[1],
  actorId: string,
  paths: string[],
): Promise<void> {
  await saveGuildConfig(guildId, config, { id: actorId, source: 'command', paths });
}

/** Anteprima del testo con le variabili riempite di esempio. */
function preview(template: string, login: string): string {
  return template
    .replace(/\{streamer\}/g, login)
    .replace(/\{title\}/g, 'Titolo della diretta')
    .replace(/\{game\}/g, 'Just Chatting')
    .replace(/\{url\}/g, `https://twitch.tv/${login}`)
    .replace(/\{viewers\}/g, '128')
    .slice(0, 1500);
}

export const announceCommands: Command[] = [twitch, announceDefaults];
