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
import { GuildConfigSchema } from '@angel/shared';
import { normalizeForLanguage, scanLanguage } from '@angel/scanner';
import type { Command } from './types.js';
import { saveGuildConfig } from '../core/config.js';
import { recordEvent } from '../logging/auditLogger.js';
import { listWatched, unwatchUser, watchUser } from '../security/watchlist.js';
import { ensureOwnerRole } from '../security/ownerRole.js';
import { provisionGuild } from '../security/provision.js';
import { isBotOwner } from '../core/permissions.js';

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

/**
 * Ripristino del ruolo del proprietario, a richiesta.
 *
 * Esiste perché il caso d'uso è un'emergenza: qualcuno ha eliminato il ruolo,
 * o te lo ha tolto, e aspettare il prossimo riavvio del bot non è una
 * risposta. Il comando è visibile solo agli amministratori, ma agisce
 * unicamente per chi è elencato in OWNER_IDS — chiunque altro lo esegua
 * ottiene un rifiuto.
 */
const master: Command = {
  data: new SlashCommandBuilder()
    .setName('angel-master')
    .setDescription('Ricrea il ruolo del proprietario del bot e lo riassegna')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.Administrator],
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isBotOwner(interaction.user.id)) {
      await interaction.editReply(
        'Questo comando è riservato ai proprietari del bot, elencati in `OWNER_IDS`.',
      );
      return;
    }

    // Se il modulo è spento lo accende questo comando, invece di rimandare al
    // pannello. Eseguirlo *è* la richiesta di attivarlo, e chi lo esegue è già
    // il solo che potrebbe accenderlo: farglielo fare due volte in due posti
    // diversi non aggiunge alcuna garanzia.
    let settings = config.general.ownerRole;
    let appenaAcceso = false;

    if (!settings.enabled) {
      const aggiornata = GuildConfigSchema.parse(structuredClone(config));
      aggiornata.general.ownerRole.enabled = true;
      await saveGuildConfig(interaction.guildId!, aggiornata, {
        id: interaction.user.id,
        source: 'command',
        paths: ['general.ownerRole.enabled'],
      });
      settings = aggiornata.general.ownerRole;
      config = aggiornata;
      appenaAcceso = true;
    }

    const esito = await ensureOwnerRole(client, interaction.guild!, config);
    if (!esito.ok) {
      await interaction.editReply(
        `Non è stato possibile: ${esito.reason}.\n` +
          '-# Le due cause tipiche sono il permesso «Gestire i ruoli» mancante, ' +
          'e il ruolo del bot che non è abbastanza in alto nella lista.',
      );
      return;
    }

    await interaction.editReply(
      `👑 Ruolo **${settings.name}** ${esito.created ? 'creato' : 'già presente'}.\n` +
        `Assegnato a ${esito.assigned} propriet${esito.assigned === 1 ? 'ario' : 'ari'} presenti nel server.\n` +
        `Permessi: ${settings.permissions.toLowerCase()}.\n` +
        (appenaAcceso
          ? '\nIl modulo era spento e l\'ho acceso: d\'ora in poi il ruolo si ricrea da solo ' +
            'a ogni avvio, anche se qualcuno lo elimina.\n'
          : '') +
        '-# Nome, colore e poteri si cambiano dal pannello: Configurazione → Generale.',
    );
  },
};

/**
 * Predisposizione a richiesta, dallo stesso posto in cui si sta guardando il
 * server. Fa esattamente ciò che fa il pulsante del pannello.
 */
const setup: Command = {
  data: new SlashCommandBuilder()
    .setName('prepara-server')
    .setDescription('Crea ruoli, canali e configurazione mancanti. Non duplica nulla')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.Administrator],
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const esito = await provisionGuild(client, interaction.guild!, config);

    const righe = [
      esito.ruoliCreati.length
        ? `**Ruoli creati:** ${esito.ruoliCreati.join(', ')}`
        : '**Ruoli:** già presenti',
      esito.canaliCreati.length
        ? `**Canali creati:** ${esito.canaliCreati.join(', ')}`
        : '**Canali:** già presenti',
      `**Campi compilati:** ${esito.campiCompilati}`,
      `**Canali isolati a chi non ha verificato:** ${esito.canaliIsolati}`,
    ];

    if (esito.errori.length > 0) {
      righe.push(
        `\n⚠️ Non riuscito: ${esito.errori.join(', ')}\n` +
          '-# Di solito manca un permesso al bot, o il suo ruolo non è abbastanza in alto.',
      );
    }

    await interaction.editReply(
      `🪶 **Predisposizione completata**\n\n${righe.join('\n')}\n\n` +
        '-# Puoi rieseguirlo quando vuoi: verifica cosa esiste già e completa solo il mancante.',
    );
  },
};

/**
 * Prova il filtro su un testo, senza pubblicarlo e senza sanzionare nessuno.
 *
 * Esiste per una ragione precisa: **chi amministra non può provare il filtro
 * scrivendo in chat**, perché gli amministratori sono esenti e i proprietari
 * del bot lo sono sempre, per costruzione. Il risultato è che la persona più
 * probabile a volerlo verificare è anche l'unica che non può, e conclude che
 * sia rotto.
 *
 * Qui le esenzioni non si applicano: si vede cosa il filtro riconosce e cosa
 * farebbe, che è l'unica domanda a cui serve rispondere.
 */
const provaFiltro: Command = {
  data: new SlashCommandBuilder()
    .setName('prova-filtro')
    .setDescription('Mostra cosa riconoscerebbe il filtro in un testo, senza sanzionare nessuno')
    .addStringOption((option) =>
      option
        .setName('testo')
        .setDescription('Il testo da esaminare')
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addBooleanOption((option) =>
      option
        .setName('rivolto')
        .setDescription('Simula un messaggio rivolto a una persona (menzione o risposta)'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageMessages],
  async execute({ interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const settings = config.security.language;
    const testo = interaction.options.getString('testo', true);
    const rivolto = interaction.options.getBoolean('rivolto') ?? false;

    const esito = scanLanguage(
      testo,
      {
        terms: settings.terms,
        categories: settings.categories,
        allowlist: settings.allowlist,
        weights: settings.weights,
        targetedBonus: settings.targetedBonus,
      },
      { targeted: rivolto },
    );

    if (esito.matches.length === 0) {
      await interaction.editReply(
        '✅ **Nessuna corrispondenza.**\n' +
          `Normalizzato in: \`${normalizeForLanguage(testo).slice(0, 200)}\`\n` +
          '-# Se ti aspettavi una corrispondenza: la parola potrebbe non essere in elenco, ' +
          'la sua categoria potrebbe essere spenta, oppure è fra le eccezioni.',
      );
      return;
    }

    const gravita = esito.matches.some((match) => match.severity === 'GRAVE')
      ? 'GRAVE'
      : esito.matches.some((match) => match.severity === 'MEDIA')
        ? 'MEDIA'
        : 'LIEVE';

    const progressione = [1, 2, 3, 5, 8].map((volta) => {
      const passo = [...settings.recidiva.scala]
        .filter((gradino) => volta >= gradino.infrazioni)
        .sort((a, b) => b.infrazioni - a.infrazioni)[0];
      if (!passo || passo.action === 'NONE') return `${volta}ª volta — solo rimozione`;
      const secondi = Math.round(
        passo.durationSec * settings.recidiva.moltiplicatori[gravita],
      );
      const durata =
        secondi === 0 ? '' : secondi >= 3600 ? ` ${secondi / 3600}h` : ` ${secondi / 60}min`;
      return `${volta}ª volta — rimozione + ${passo.action.toLowerCase()}${durata}`;
    });

    await interaction.editReply(
      `🔍 **${esito.matches.length} corrispondenz${esito.matches.length === 1 ? 'a' : 'e'}** · punteggio ${esito.score}/100\n\n` +
        esito.matches
          .slice(0, 12)
          .map((match) => `• \`${match.term}\` — ${match.category.toLowerCase()}, ${match.severity.toLowerCase()}`)
          .join('\n') +
        (rivolto ? '\n\nConteggiato come rivolto a una persona.' : '') +
        `\n\n**Cosa succederebbe** (gravità ${gravita.toLowerCase()}):\n` +
        progressione.map((riga) => `-# ${riga}`).join('\n') +
        '\n\n-# Nessun messaggio è stato pubblicato e nessuno è stato sanzionato. ' +
        'Le esenzioni non valgono qui: in chat, amministratori e proprietari del bot non vengono filtrati.',
    );
  },
};

export const voiceCommands: Command[] = [say, watch, master, setup, provaFiltro];
