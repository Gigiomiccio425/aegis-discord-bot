/* ═══════════════════════════════════════════════════════════════════════
   LA VOCE DEL BOT E LO SGUARDO SUGLI ATTENZIONATI

   Due comandi che sembrano lontani ma rispondono alla stessa esigenza: dare
   allo staff strumenti che non passano da una sanzione.

   `/dì` fa scrivere il bot in un canale — annunci, regole, avvisi — senza che
   il messaggio porti il nome di una persona. Un annuncio firmato da un
   moderatore diventa il suo annuncio, e chi non è d'accordo scrive a lui.

   `/attenziona` copre il caso a metà: un sospetto senza prove. Sanzionare
   sarebbe ingiusto, ignorare significa accorgersene tardi. Attenzionare non
   limita nessuno e non è visibile all'interessato: cambia solo quanto risalta
   ciò che fa.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js';
import type { Command } from './types.js';
import { recordEvent } from '../logging/auditLogger.js';
import { listWatched, unwatchUser, watchUser } from '../security/watchlist.js';

/**
 * Estensioni accettate come immagine o animazione.
 *
 * L'elenco è chiuso di proposito. Il bot pubblica ciò che gli viene passato, e
 * un allegato pubblicato dal bot ha l'aria di venire dallo staff: consentire
 * qualunque file significherebbe offrire un modo comodo di far scaricare un
 * eseguibile con l'autorevolezza del server addosso.
 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'avif'];

function looksLikeImage(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const path = parsed.pathname.toLowerCase();
    return IMAGE_EXTENSIONS.some((extension) => path.endsWith(`.${extension}`));
  } catch {
    return false;
  }
}

const say: Command = {
  data: new SlashCommandBuilder()
    .setName('dì')
    .setDescription('Fa scrivere un messaggio al bot nel canale che scegli')
    .addStringOption((option) =>
      option
        .setName('testo')
        .setDescription('Cosa deve scrivere. Usa \\n per andare a capo')
        .setMaxLength(1900),
    )
    .addChannelOption((option) =>
      option
        .setName('canale')
        .setDescription('Dove scriverlo. Vuoto = qui')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addAttachmentOption((option) =>
      option.setName('immagine').setDescription('Immagine o GIF da allegare'),
    )
    .addStringOption((option) =>
      option
        .setName('link-immagine')
        .setDescription('Indirizzo https di un\'immagine o GIF, in alternativa all\'allegato'),
    )
    .addBooleanOption((option) =>
      option
        .setName('riquadro')
        .setDescription('Mostra il testo dentro un riquadro colorato invece che come messaggio semplice'),
    )
    .addStringOption((option) =>
      option.setName('titolo').setDescription('Titolo del riquadro').setMaxLength(200),
    )
    .addStringOption((option) =>
      option
        .setName('modifica')
        .setDescription('ID di un messaggio del bot da riscrivere invece di pubblicarne uno nuovo'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageMessages],
  async execute({ client, interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const text = interaction.options.getString('testo')?.replace(/\\n/g, '\n') ?? '';
    const attachment = interaction.options.getAttachment('immagine');
    const imageUrl = interaction.options.getString('link-immagine');
    const asEmbed = interaction.options.getBoolean('riquadro') ?? false;
    const title = interaction.options.getString('titolo');
    const editId = interaction.options.getString('modifica');
    const target = (interaction.options.getChannel('canale') ??
      interaction.channel) as TextChannel | null;

    if (!target?.isTextBased()) {
      await interaction.editReply('Canale non valido.');
      return;
    }

    if (!text && !attachment && !imageUrl) {
      await interaction.editReply('Serve almeno un testo o un\'immagine.');
      return;
    }

    if (attachment && !attachment.contentType?.startsWith('image/')) {
      await interaction.editReply(
        'L\'allegato non è un\'immagine. Il bot pubblica solo immagini e GIF: ' +
          'un file pubblicato da lui sembra venire dallo staff, e non è il caso di prestare quella credibilità a un eseguibile.',
      );
      return;
    }

    if (imageUrl && !looksLikeImage(imageUrl)) {
      await interaction.editReply(
        'Il link non sembra un\'immagine. Serve un indirizzo `https` che finisce con ' +
          IMAGE_EXTENSIONS.map((extension) => `.${extension}`).join(', ') +
          '.',
      );
      return;
    }

    const picture = attachment?.url ?? imageUrl ?? null;

    const payload = asEmbed
      ? {
          embeds: [
            (() => {
              const embed = new EmbedBuilder().setColor(0xe8d8a0);
              if (title) embed.setTitle(title);
              if (text) embed.setDescription(text);
              if (picture) embed.setImage(picture);
              return embed;
            })(),
          ],
          // Le menzioni non partono mai da qui: un messaggio scritto dal bot
          // con dentro @everyone sarebbe uno strumento di spam con il volto
          // dello staff. Chi vuole menzionare lo fa a nome proprio.
          allowedMentions: { parse: [] as never[] },
        }
      : {
          content: [text, picture].filter(Boolean).join('\n'),
          allowedMentions: { parse: [] as never[] },
        };

    if (editId) {
      const existing = await target.messages.fetch(editId).catch(() => null);
      if (!existing) {
        await interaction.editReply('Messaggio non trovato in questo canale.');
        return;
      }
      if (existing.author.id !== client.user?.id) {
        await interaction.editReply('Il bot può riscrivere solo i propri messaggi.');
        return;
      }
      await existing.edit(payload);
      await recordEvent(client, {
        guildId: interaction.guildId!,
        type: 'BOT_MESSAGE_EDITED',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        channelId: target.id,
        messageId: existing.id,
        summary: `Messaggio del bot riscritto da <@${interaction.user.id}>`,
        payload: { text: text.slice(0, 500), hasImage: Boolean(picture) },
      });
      await interaction.editReply(`✅ Messaggio aggiornato: ${existing.url}`);
      return;
    }

    const sent = await target.send(payload);

    // Tracciato sempre: un messaggio anonimo dello staff resta anonimo per chi
    // legge il canale, ma non per il registro. Senza, il comando sarebbe il
    // modo più semplice di scrivere qualcosa senza risponderne.
    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'BOT_MESSAGE_SENT',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      channelId: target.id,
      messageId: sent.id,
      summary: `Messaggio pubblicato dal bot per conto di <@${interaction.user.id}>`,
      payload: { text: text.slice(0, 500), hasImage: Boolean(picture), embed: asEmbed },
    });

    await interaction.editReply(
      `✅ Pubblicato: ${sent.url}\n-# Per modificarlo: \`/dì modifica:${sent.id}\``,
    );
  },
};

const watch: Command = {
  data: new SlashCommandBuilder()
    .setName('attenziona')
    .setDescription('Sorveglia un utente senza sanzionarlo')
    .addSubcommand((sub) =>
      sub
        .setName('aggiungi')
        .setDescription('Mette in evidenza ogni azione di questa persona nel registro')
        .addUserOption((option) =>
          option.setName('utente').setDescription('Chi sorvegliare').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('motivo')
            .setDescription('Perché lo stai sorvegliando')
            .setRequired(true)
            .setMaxLength(500),
        )
        .addIntegerOption((option) =>
          option
            .setName('ore')
            .setDescription('Per quante ore (0 = finché non lo togli)')
            .setMinValue(0)
            .setMaxValue(8760),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('togli')
        .setDescription('Smette di sorvegliare')
        .addUserOption((option) =>
          option.setName('utente').setDescription('Chi').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Chi è sotto sorveglianza'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ModerateMembers],
  async execute({ client, interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();

    if (sub === 'lista') {
      const watched = await listWatched(guildId);
      if (watched.length === 0) {
        await interaction.editReply('Nessun utente sotto sorveglianza.');
        return;
      }
      await interaction.editReply(
        `👁️ **${watched.length} sotto sorveglianza**\n\n` +
          watched
            .slice(0, 20)
            .map(
              (entry) =>
                `<@${entry.userId}> — ${entry.reason ?? 'senza motivo'}\n` +
                `-# dal <t:${Math.floor(entry.since.getTime() / 1000)}:d>` +
                (entry.expiresAt
                  ? ` · fino al <t:${Math.floor(entry.expiresAt.getTime() / 1000)}:d>`
                  : ''),
            )
            .join('\n'),
      );
      return;
    }

    const user = interaction.options.getUser('utente', true);

    if (sub === 'togli') {
      const removed = await unwatchUser(guildId, user.id);
      if (removed) {
        await recordEvent(client, {
          guildId,
          type: 'MOD_WATCH_REMOVED',
          actorId: interaction.user.id,
          actorTag: interaction.user.tag,
          targetId: user.id,
          targetTag: user.tag,
          summary: `Sorveglianza rimossa da <@${interaction.user.id}>`,
        });
      }
      await interaction.editReply(
        removed ? `✅ ${user.tag} non è più sorvegliato.` : 'Non era sotto sorveglianza.',
      );
      return;
    }

    const reason = interaction.options.getString('motivo', true);
    const hours = interaction.options.getInteger('ore') ?? 0;
    await watchUser(guildId, user.id, interaction.user.id, reason, hours);

    await recordEvent(client, {
      guildId,
      type: 'MOD_WATCH_ADDED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: user.id,
      targetTag: user.tag,
      severity: 40,
      summary: `👁️ <@${user.id}> messo sotto sorveglianza da <@${interaction.user.id}>\n${reason}`,
      payload: { reason, hours },
    });

    await interaction.editReply(
      `👁️ **${user.tag}** è ora sotto sorveglianza${hours > 0 ? ` per ${hours} ore` : ''}.\n` +
        'Ogni sua azione viene messa in evidenza nel registro. Non se ne accorgerà: ' +
        'non perde permessi e non riceve alcuna notifica.',
    );
  },
};

export const voiceCommands: Command[] = [say, watch];
