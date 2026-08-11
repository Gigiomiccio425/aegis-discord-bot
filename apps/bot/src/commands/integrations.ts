import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import type { Command } from './types.js';
import { recordEvent } from '../logging/auditLogger.js';
import {
  buildGiveawayMessage,
  buildPollMessage,
  buildReactionRoleMessage,
} from '../integrations/render.js';
import { parseDurationSeconds } from '../integrations/duration.js';
import { closePoll, drawGiveaway } from '../integrations/actions.js';
import { closeTicket, publishTicketPanel } from '../integrations/tickets.js';

/* ═══════════════════════════════════════════════════════════════════════
   SONDAGGI, GIVEAWAY, RUOLI CON REAZIONE

   Tutti e tre usano componenti (pulsanti e menu) e non le reazioni. Le
   reazioni sembrano più semplici ma hanno tre difetti concreti: si perdono se
   il messaggio non è in cache, chiunque può aggiungerne di proprie creando
   confusione, e non permettono di rispondere in privato a chi interagisce.
   Con i componenti l'identificativo porta con sé tutto il necessario, quindi
   funzionano anche dopo un riavvio.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Sondaggi ─────────────────────────────────────────────────────────── */

const poll: Command = {
  data: new SlashCommandBuilder()
    .setName('sondaggio')
    .setDescription('Crea e gestisce sondaggi persistenti')
    .addSubcommand((sub) =>
      sub
        .setName('crea')
        .setDescription('Crea un nuovo sondaggio')
        .addStringOption((option) =>
          option.setName('domanda').setDescription('La domanda').setRequired(true).setMaxLength(300),
        )
        .addStringOption((option) =>
          option
            .setName('opzioni')
            .setDescription('Opzioni separate da | — es: Rosso | Verde | Blu')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('durata').setDescription('Es. 2h, 3d. Vuoto = senza scadenza'),
        )
        .addBooleanOption((option) =>
          option.setName('multiplo').setDescription('Consente di votare più opzioni'),
        )
        .addBooleanOption((option) =>
          option
            .setName('anonimo')
            .setDescription('I voti non sono attribuibili a nessuno, nemmeno nel pannello'),
        )
        .addRoleOption((option) =>
          option.setName('ruolo-ammesso').setDescription('Solo chi ha questo ruolo può votare'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('chiudi')
        .setDescription('Chiude un sondaggio e pubblica i risultati')
        .addStringOption((option) =>
          option.setName('id').setDescription('ID del sondaggio').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Sondaggi aperti'))
    .setDMPermission(false),
  async execute({ client, interaction, config }) {
    const settings = config.integrations.polls;
    const member = interaction.member as GuildMember;
    const sub = interaction.options.getSubcommand();
    const prisma = getPrisma();

    if (!settings.enabled) {
      await interaction.reply({
        content: 'Il modulo sondaggi è disattivato. Attivalo dal pannello.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Chi può creare: i ruoli indicati, oppure — se la lista è vuota — chi ha
    // il permesso di gestire i messaggi.
    const canCreate =
      settings.creatorRoleIds.length > 0
        ? settings.creatorRoleIds.some((roleId) => member.roles.cache.has(roleId))
        : member.permissions.has(PermissionFlagsBits.ManageMessages);

    if (sub === 'lista') {
      const open = await prisma.poll.findMany({
        where: { guildId: interaction.guildId!, closedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { _count: { select: { votes: true } } },
      });
      await interaction.reply({
        content:
          open.length === 0
            ? 'Nessun sondaggio aperto.'
            : open
                .map(
                  (entry) =>
                    `**${entry.question.slice(0, 60)}** · \`${entry.id.slice(0, 8)}\` · ` +
                    `${entry._count.votes} voti` +
                    (entry.closesAt
                      ? ` · chiude <t:${Math.floor(entry.closesAt.getTime() / 1000)}:R>`
                      : ''),
                )
                .join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!canCreate) {
      await interaction.reply({
        content: 'Non hai i permessi per gestire i sondaggi.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'chiudi') {
      const id = interaction.options.getString('id', true);
      const record = await prisma.poll.findFirst({
        where: { guildId: interaction.guildId!, id: { startsWith: id } },
      });
      if (!record || record.closedAt) {
        await interaction.reply({
          content: 'Sondaggio non trovato o già chiuso.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await closePoll(client, record.id);
      await interaction.reply({ content: '✅ Sondaggio chiuso.', flags: MessageFlags.Ephemeral });
      return;
    }

    /* ── Creazione ───────────────────────────────────────────────────── */
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const question = interaction.options.getString('domanda', true);
    const options = interaction.options
      .getString('opzioni', true)
      .split('|')
      .map((option) => option.trim())
      .filter(Boolean)
      .slice(0, settings.maxOptions);

    if (options.length < 2) {
      await interaction.editReply('Servono almeno due opzioni, separate da `|`.');
      return;
    }

    const durationInput = interaction.options.getString('durata');
    let closesAt: Date | null = null;
    if (durationInput) {
      const seconds = parseDurationSeconds(durationInput);
      if (!seconds) {
        await interaction.editReply('Durata non valida. Usa formati come `2h`, `3d`, `30m`.');
        return;
      }
      if (seconds > settings.maxDurationHours * 3600) {
        await interaction.editReply(
          `La durata massima consentita è ${settings.maxDurationHours} ore.`,
        );
        return;
      }
      closesAt = new Date(Date.now() + seconds * 1000);
    }

    const anonymous = interaction.options.getBoolean('anonimo') ?? false;
    if (anonymous && !settings.allowAnonymous) {
      await interaction.editReply('I sondaggi anonimi non sono consentiti in questo server.');
      return;
    }

    const allowedRole = interaction.options.getRole('ruolo-ammesso');

    const record = await prisma.poll.create({
      data: {
        guildId: interaction.guildId!,
        channelId: interaction.channelId,
        question,
        options: options.map((label, index) => ({ index, label })) as unknown as object,
        multiSelect: interaction.options.getBoolean('multiplo') ?? false,
        anonymous,
        allowedRoleIds: allowedRole ? [allowedRole.id] : [],
        createdBy: interaction.user.id,
        closesAt,
      },
    });

    const channel = interaction.channel as TextChannel;
    const message = await channel.send(await buildPollMessage(record.id));
    await prisma.poll.update({ where: { id: record.id }, data: { messageId: message.id } });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'POLL_CREATED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      channelId: interaction.channelId,
      messageId: message.id,
      summary: `Sondaggio creato: ${question.slice(0, 100)}`,
      payload: { pollId: record.id, options: options.length, anonymous },
    });

    await interaction.editReply(
      `✅ Sondaggio pubblicato · ID \`${record.id.slice(0, 8)}\`` +
        (anonymous
          ? '\n\nÈ anonimo: i voti sono salvati con un identificativo derivato e non riconducibile alla persona.'
          : ''),
    );
  },
};

/* ── Giveaway ─────────────────────────────────────────────────────────── */

const giveaway: Command = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Crea ed estrae giveaway')
    .addSubcommand((sub) =>
      sub
        .setName('crea')
        .setDescription('Crea un giveaway')
        .addStringOption((option) =>
          option.setName('premio').setDescription('Cosa si vince').setRequired(true).setMaxLength(200),
        )
        .addStringOption((option) =>
          option.setName('durata').setDescription('Es. 24h, 7d').setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName('vincitori').setDescription('Quanti vincitori').setMinValue(1),
        )
        .addIntegerOption((option) =>
          option
            .setName('eta-account')
            .setDescription('Giorni minimi di età dell\'account')
            .setMinValue(0),
        )
        .addRoleOption((option) =>
          option.setName('ruolo-richiesto').setDescription('Ruolo necessario per partecipare'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('estrai')
        .setDescription('Chiude ed estrae subito')
        .addStringOption((option) =>
          option.setName('id').setDescription('ID del giveaway').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('riestrai')
        .setDescription('Estrae nuovi vincitori da un giveaway già concluso')
        .addStringOption((option) =>
          option.setName('id').setDescription('ID del giveaway').setRequired(true),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),
  async execute({ client, interaction, config }) {
    const settings = config.integrations.giveaways;
    if (!settings.enabled) {
      await interaction.reply({
        content: 'Il modulo giveaway è disattivato. Attivalo dal pannello.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = interaction.member as GuildMember;
    if (
      settings.hostRoleIds.length > 0 &&
      !settings.hostRoleIds.some((roleId) => member.roles.cache.has(roleId))
    ) {
      await interaction.reply({
        content: 'Non hai i permessi per gestire i giveaway.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const prisma = getPrisma();
    const sub = interaction.options.getSubcommand();

    if (sub === 'estrai' || sub === 'riestrai') {
      const id = interaction.options.getString('id', true);
      const record = await prisma.giveaway.findFirst({
        where: { guildId: interaction.guildId!, id: { startsWith: id } },
      });
      if (!record) {
        await interaction.reply({ content: 'Giveaway non trovato.', flags: MessageFlags.Ephemeral });
        return;
      }

      const winners = await drawGiveaway(client, record.id, sub === 'riestrai');
      await interaction.reply({
        content:
          winners.length > 0
            ? `✅ Estratti ${winners.length} vincitori.`
            : '⚠️ Nessun partecipante idoneo: nessun vincitore estratto.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const seconds = parseDurationSeconds(interaction.options.getString('durata', true));
    if (!seconds) {
      await interaction.editReply('Durata non valida. Usa formati come `24h` o `7d`.');
      return;
    }
    if (seconds > settings.maxDurationDays * 86400) {
      await interaction.editReply(`La durata massima consentita è ${settings.maxDurationDays} giorni.`);
      return;
    }

    const winnerCount = interaction.options.getInteger('vincitori') ?? 1;
    if (winnerCount > settings.maxWinners) {
      await interaction.editReply(`Il massimo consentito è ${settings.maxWinners} vincitori.`);
      return;
    }

    const requiredRole = interaction.options.getRole('ruolo-richiesto');

    // I requisiti d'ingresso non sono un vezzo: senza, ogni giveaway attira
    // account creati per l'occasione, che è esattamente ciò che rende inutile
    // il giveaway per i membri veri.
    const requirements = {
      minAccountAgeDays:
        interaction.options.getInteger('eta-account') ??
        settings.defaultRequirements.minAccountAgeDays,
      minMembershipDays: settings.defaultRequirements.minMembershipDays,
      requiredRoleIds: requiredRole
        ? [requiredRole.id, ...settings.defaultRequirements.requiredRoleIds]
        : settings.defaultRequirements.requiredRoleIds,
      blockedRoleIds: settings.defaultRequirements.blockedRoleIds,
    };

    const record = await prisma.giveaway.create({
      data: {
        guildId: interaction.guildId!,
        channelId: interaction.channelId,
        prize: interaction.options.getString('premio', true),
        winnerCount,
        requirements: requirements as unknown as object,
        hostId: interaction.user.id,
        endsAt: new Date(Date.now() + seconds * 1000),
      },
    });

    const channel = interaction.channel as TextChannel;

    // Ruolo e testo di accompagnamento sono una scelta del server, non della
    // singola estrazione: si configurano una volta con `/annunci giveaway` o
    // dal pannello, e valgono per tutti i giveaway successivi.
    const intro = [
      settings.mentionRoleId ? `<@&${settings.mentionRoleId}>` : '',
      settings.announceTemplate
        .replace(/\{premio\}/g, record.prize)
        .replace(/\{vincitori\}/g, String(winnerCount))
        .replace(/\{fine\}/g, `<t:${Math.floor(record.endsAt.getTime() / 1000)}:R>`),
    ]
      .filter(Boolean)
      .join('\n');

    const message = await channel.send({
      ...(await buildGiveawayMessage(record.id)),
      ...(intro
        ? {
            content: intro,
            allowedMentions: settings.mentionRoleId ? { roles: [settings.mentionRoleId] } : { parse: [] },
          }
        : {}),
    });
    await prisma.giveaway.update({ where: { id: record.id }, data: { messageId: message.id } });

    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'GIVEAWAY_CREATED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      channelId: interaction.channelId,
      messageId: message.id,
      summary: `Giveaway creato: ${record.prize}`,
      payload: { giveawayId: record.id, requirements },
    });

    await interaction.editReply(`✅ Giveaway pubblicato · ID \`${record.id.slice(0, 8)}\``);
  },
};

/* ── Ruoli con reazione ───────────────────────────────────────────────── */

const reactionRoles: Command = {
  data: new SlashCommandBuilder()
    .setName('ruoli-menu')
    .setDescription('Pubblica un menu per l\'auto-assegnazione dei ruoli')
    .addStringOption((option) =>
      option.setName('titolo').setDescription('Titolo del menu').setRequired(true).setMaxLength(200),
    )
    .addStringOption((option) =>
      option
        .setName('voci')
        .setDescription('Formato: ID_RUOLO:Etichetta | ID_RUOLO:Etichetta')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('modalita')
        .setDescription('Come si comportano le scelte')
        .addChoices(
          { name: 'Multipla — più ruoli insieme', value: 'MULTI' },
          { name: 'Esclusiva — un solo ruolo alla volta', value: 'EXCLUSIVE' },
          { name: 'Solo aggiunta — non si può togliere', value: 'VERIFY' },
        ),
    )
    .addChannelOption((option) =>
      option
        .setName('canale')
        .setDescription('Dove pubblicarlo')
        .addChannelTypes(ChannelType.GuildText),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageRoles],
  async execute({ interaction, config }) {
    const settings = config.integrations.reactionRoles;
    if (!settings.enabled) {
      await interaction.reply({
        content: 'Il modulo ruoli con reazione è disattivato. Attivalo dal pannello.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild!;
    const me = await guild.members.fetchMe();
    const dangerous = config.security.antiNuke.dangerousPermissions;

    const parsed: { roleId: string; label: string }[] = [];
    const rejected: string[] = [];

    for (const raw of interaction.options.getString('voci', true).split('|')) {
      const [roleRaw, ...labelParts] = raw.split(':');
      const roleId = (roleRaw ?? '').replace(/[<@&>]/g, '').trim();
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        rejected.push(`\`${roleId}\` — ruolo inesistente`);
        continue;
      }
      if (role.position >= me.roles.highest.position) {
        rejected.push(`**${role.name}** — è più in alto del ruolo del bot`);
        continue;
      }
      if (role.managed) {
        rejected.push(`**${role.name}** — gestito da un'integrazione`);
        continue;
      }

      // Un menu di auto-assegnazione che distribuisce permessi è una scalata di
      // privilegi aperta a chiunque veda il messaggio.
      const privileged =
        settings.blockPrivilegedRoles &&
        dangerous.some((name) => {
          const flag = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
          return typeof flag === 'bigint' && role.permissions.has(flag);
        });
      if (privileged) {
        rejected.push(`**${role.name}** — concede permessi amministrativi`);
        continue;
      }

      parsed.push({
        roleId: role.id,
        label: (labelParts.join(':').trim() || role.name).slice(0, 80),
      });
    }

    if (parsed.length === 0) {
      await interaction.editReply(
        `Nessuna voce valida.\n${rejected.map((line) => `• ${line}`).join('\n')}`,
      );
      return;
    }

    const prisma = getPrisma();
    const channel = (interaction.options.getChannel('canale') ?? interaction.channel) as TextChannel;

    const record = await prisma.reactionRoleSet.create({
      data: {
        guildId: guild.id,
        channelId: channel.id,
        title: interaction.options.getString('titolo', true),
        options: parsed as unknown as object,
        mode: interaction.options.getString('modalita') ?? 'MULTI',
        createdBy: interaction.user.id,
      },
    });

    const message = await channel.send(await buildReactionRoleMessage(record.id));
    await prisma.reactionRoleSet.update({
      where: { id: record.id },
      data: { messageId: message.id },
    });

    await interaction.editReply(
      `✅ Menu pubblicato in <#${channel.id}> con ${parsed.length} voci.` +
        (rejected.length > 0
          ? `\n\n⚠️ Voci scartate:\n${rejected.map((line) => `• ${line}`).join('\n')}`
          : ''),
    );
  },
};

/* ── Ticket ───────────────────────────────────────────────────────────── */

const ticket: Command = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Sistema di assistenza privata')
    .addSubcommand((sub) =>
      sub
        .setName('pannello')
        .setDescription('Pubblica il pulsante di apertura ticket')
        .addChannelOption((option) =>
          option
            .setName('canale')
            .setDescription('Dove pubblicarlo')
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('chiudi')
        .setDescription('Chiude il ticket di questo canale')
        .addStringOption((option) =>
          option.setName('motivo').setDescription('Motivo della chiusura').setMaxLength(500),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('aggiungi')
        .setDescription('Aggiunge una persona a questo ticket')
        .addUserOption((option) =>
          option.setName('utente').setDescription('Chi aggiungere').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Ticket aperti nel server'))
    .setDMPermission(false),
  async execute({ client, interaction, config }) {
    const settings = config.integrations.tickets;
    if (!settings.enabled) {
      await interaction.reply({
        content: 'Il modulo ticket è disattivato. Attivalo dal pannello.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guild = interaction.guild!;
    const member = interaction.member as GuildMember;
    const prisma = getPrisma();
    const sub = interaction.options.getSubcommand();

    const isSupport =
      settings.supportRoleIds.some((roleId) => member.roles.cache.has(roleId)) ||
      member.permissions.has(PermissionFlagsBits.ManageChannels);

    if (sub === 'pannello') {
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: 'Serve il permesso di gestire il server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const channel = (interaction.options.getChannel('canale') ??
        (settings.panelChannelId
          ? await guild.channels.fetch(settings.panelChannelId).catch(() => null)
          : null) ??
        interaction.channel) as TextChannel;

      const messageId = await publishTicketPanel(guild, channel, config);
      await interaction.editReply(
        messageId
          ? `✅ Pannello pubblicato in <#${channel.id}>.` +
              (settings.supportRoleIds.length === 0
                ? '\n\n⚠️ Nessun ruolo di supporto configurato: i ticket saranno visibili solo a chi ha ManageChannels.'
                : '')
          : '❌ Pubblicazione fallita: verifica i permessi del bot nel canale.',
      );
      return;
    }

    if (sub === 'lista') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const open = await prisma.ticket.findMany({
        where: { guildId: guild.id, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });

      await interaction.editReply(
        open.length === 0
          ? 'Nessun ticket aperto.'
          : open
              .map(
                (entry) =>
                  `**#${entry.number}** <#${entry.channelId}> · <@${entry.openerId}> · ` +
                  `<t:${Math.floor(entry.createdAt.getTime() / 1000)}:R>` +
                  (entry.claimedBy ? ` · in carico a <@${entry.claimedBy}>` : ' · **non preso in carico**'),
              )
              .join('\n'),
      );
      return;
    }

    // I comandi rimanenti agiscono sul ticket del canale corrente.
    const current = await prisma.ticket.findFirst({
      where: { guildId: guild.id, channelId: interaction.channelId, status: 'OPEN' },
    });
    if (!current) {
      await interaction.reply({
        content: 'Questo canale non è un ticket aperto.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'aggiungi') {
      if (!isSupport) {
        await interaction.reply({
          content: 'Solo lo staff può aggiungere persone a un ticket.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const target = interaction.options.getUser('utente', true);
      const channel = interaction.channel as TextChannel;

      await channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });

      await interaction.reply(`✅ <@${target.id}> aggiunto al ticket **#${current.number}**.`);
      return;
    }

    // Chiusura: la può fare lo staff o chi ha aperto il ticket.
    if (!isSupport && current.openerId !== member.id) {
      await interaction.reply({
        content: 'Non puoi chiudere questo ticket.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply('🔒 Chiusura in corso…');
    await closeTicket(
      client,
      guild,
      current.number,
      member.id,
      interaction.options.getString('motivo') ?? 'Nessun motivo indicato',
      config,
    );
  },
};

export const integrationCommands: Command[] = [poll, giveaway, reactionRoles, ticket];
