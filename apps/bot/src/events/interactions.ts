import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import { getGuildConfig } from '../core/config.js';
import { childLogger } from '../core/logger.js';
import { handleCommand } from '../commands/index.js';
import { recordEvent } from '../logging/auditLogger.js';
import { t } from '../core/i18n.js';
import {
  checkGiveawayEligibility,
  refreshGiveawayMessage,
  refreshPollMessage,
  voterKey,
  type GiveawayRequirements,
} from '../integrations/actions.js';
import { claimTicket, closeTicket, openTicket } from '../integrations/tickets.js';

const log = childLogger('events:interactions');

export function registerInteractionEvents(client: Client): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      try {
        if (interaction.isChatInputCommand()) {
          await handleCommand(client, interaction);
          return;
        }
        if (interaction.isButton()) {
          await handleButton(client, interaction);
          return;
        }
        if (interaction.isStringSelectMenu()) {
          await handleSelectMenu(client, interaction);
          return;
        }
        if (interaction.isModalSubmit()) {
          await handleModal(client, interaction);
          return;
        }
      } catch (error) {
        log.error({ err: error, customId: 'customId' in interaction ? interaction.customId : null },
          'gestione interazione fallita');
      }
    })();
  });
}

/**
 * Pulsanti persistenti.
 *
 * L'identificativo porta con sé i dati necessari (`aegis:azione:…`) perché dopo
 * un riavvio non esiste alcuno stato in memoria: un collector tradizionale
 * smetterebbe di funzionare e il messaggio resterebbe inerte nel canale.
 */
async function handleButton(client: Client, interaction: ButtonInteraction): Promise<void> {
  if (!interaction.customId.startsWith('aegis:')) return;
  const [, action, ...rest] = interaction.customId.split(':');
  if (!interaction.guildId || !interaction.guild) return;

  const config = await getGuildConfig(interaction.guildId);
  const locale = config.general.locale;

  switch (action) {
    case 'verify':
      await handleVerify(client, interaction, config);
      return;

    case 'poll':
      await handlePollVote(client, interaction, rest[0]!, Number(rest[1]));
      return;

    case 'giveaway':
      await handleGiveawayEntry(client, interaction, rest[0]!);
      return;

    case 'ticket':
      await handleTicketButton(client, interaction, rest, config);
      return;

    case 'lift-quarantine': {
      const targetId = rest[0];
      if (!targetId) return;
      const member = interaction.member as GuildMember | null;
      if (!member?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.reply({
          content: t(locale, 'common.noPermission'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const { liftQuarantine } = await import('../core/enforcer.js');
      const done = await liftQuarantine(client, interaction.guild, targetId, interaction.user.id);
      await interaction.reply({
        content: done ? '✅ Quarantena revocata e ruoli ripristinati.' : 'Utente non in quarantena.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    default:
      return;
  }
}

async function handleVerify(
  client: Client,
  interaction: ButtonInteraction,
  config: Awaited<ReturnType<typeof getGuildConfig>>,
): Promise<void> {
  const settings = config.security.verification;
  const locale = config.general.locale;
  const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return;

  // Il ritardo minimo scarta chi preme nell'istante in cui il pulsante appare:
  // una persona impiega comunque qualche secondo a leggere il messaggio.
  const joinedMsAgo = Date.now() - (member.joinedTimestamp ?? 0);
  if (joinedMsAgo < settings.minDelaySec * 1000) {
    await interaction.reply({ content: t(locale, 'verify.tooFast'), flags: MessageFlags.Ephemeral });
    return;
  }

  if (settings.verifiedRoleId) {
    await member.roles.add(settings.verifiedRoleId, 'Verifica completata').catch(() => undefined);
  }
  const quarantineRoleId = settings.quarantineRoleId ?? config.general.quarantineRoleId;
  if (quarantineRoleId) {
    await member.roles.remove(quarantineRoleId, 'Verifica completata').catch(() => undefined);
  }

  await getPrisma()
    .userProfile.updateMany({
      where: { guildId: interaction.guildId!, userId: member.id },
      data: { verifiedAt: new Date() },
    })
    .catch(() => undefined);

  await interaction.reply({ content: t(locale, 'verify.success'), flags: MessageFlags.Ephemeral });
  await recordEvent(client, {
    guildId: interaction.guildId!,
    type: 'PANEL_ACTION',
    actorId: member.id,
    actorTag: member.user.tag,
    summary: "Verifica d'ingresso completata",
  });
}

/**
 * Voto in un sondaggio.
 *
 * Premere di nuovo la stessa opzione toglie il voto: è il comportamento che la
 * gente si aspetta da un pulsante, e permette di correggere un errore senza
 * chiedere aiuto allo staff.
 */
async function handlePollVote(
  client: Client,
  interaction: ButtonInteraction,
  pollId: string,
  optionIndex: number,
): Promise<void> {
  const prisma = getPrisma();
  const poll = await prisma.poll.findUnique({ where: { id: pollId } });

  if (!poll || poll.closedAt) {
    await interaction.reply({
      content: 'Questo sondaggio è chiuso.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember;
  if (
    poll.allowedRoleIds.length > 0 &&
    !poll.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId))
  ) {
    await interaction.reply({
      content: 'Non hai un ruolo abilitato a votare in questo sondaggio.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const key = voterKey(pollId, interaction.user.id, poll.anonymous);
  const existing = await prisma.pollVote.findUnique({
    where: { pollId_voterKey: { pollId, voterKey: key } },
  });

  let selection: number[];
  if (!existing) {
    selection = [optionIndex];
  } else if (poll.multiSelect) {
    selection = existing.optionIds.includes(optionIndex)
      ? existing.optionIds.filter((index) => index !== optionIndex)
      : [...existing.optionIds, optionIndex];
  } else {
    selection = existing.optionIds.includes(optionIndex) ? [] : [optionIndex];
  }

  if (selection.length === 0) {
    await prisma.pollVote.delete({ where: { id: existing!.id } }).catch(() => undefined);
  } else {
    await prisma.pollVote.upsert({
      where: { pollId_voterKey: { pollId, voterKey: key } },
      create: { pollId, voterKey: key, optionIds: selection },
      update: { optionIds: selection, votedAt: new Date() },
    });
  }

  const options = poll.options as unknown as { index: number; label: string }[];
  const chosen = options
    .filter((option) => selection.includes(option.index))
    .map((option) => option.label);

  await interaction.reply({
    content:
      selection.length === 0
        ? '🗳️ Voto ritirato.'
        : `🗳️ Voto registrato: **${chosen.join('**, **')}**` +
          (poll.anonymous ? '\n_Il sondaggio è anonimo: il tuo voto non è riconducibile a te._' : ''),
    flags: MessageFlags.Ephemeral,
  });

  await refreshPollMessage(client, pollId);

  // Il singolo voto si registra solo se il server lo ha chiesto e il sondaggio
  // non è anonimo: altrimenti il registro vanificherebbe l'anonimato.
  const config = await getGuildConfig(interaction.guildId!);
  if (config.integrations.polls.logVotes && !poll.anonymous) {
    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'POLL_VOTED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      channelId: poll.channelId,
      summary: `Voto in «${poll.question.slice(0, 60)}»: ${chosen.join(', ') || 'ritirato'}`,
      payload: { pollId, selection },
    });
  }
}

/**
 * Pulsanti dei ticket: apertura, presa in carico, chiusura.
 *
 * L'apertura passa da una finestra modale invece che da un comando: chiedere
 * l'oggetto della richiesta *prima* di creare il canale evita la fila di ticket
 * vuoti intitolati «aiuto» che nessuno sa come smistare.
 */
async function handleTicketButton(
  client: Client,
  interaction: ButtonInteraction,
  rest: string[],
  config: Awaited<ReturnType<typeof getGuildConfig>>,
): Promise<void> {
  const [action, rawNumber] = rest;
  const guild = interaction.guild!;
  const member = interaction.member as GuildMember;

  if (action === 'open') {
    const modal = new ModalBuilder()
      .setCustomId('aegis:ticket-modal')
      .setTitle('Apri un ticket')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('subject')
            .setLabel('Di cosa hai bisogno?')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(10)
            .setMaxLength(500)
            .setPlaceholder('Descrivi brevemente la tua richiesta')
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  const number = Number(rawNumber);
  if (!Number.isInteger(number)) return;

  const isSupport =
    config.integrations.tickets.supportRoleIds.some((roleId) => member.roles.cache.has(roleId)) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels);

  if (action === 'claim') {
    if (!isSupport) {
      await interaction.reply({
        content: 'Solo lo staff può prendere in carico un ticket.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const done = await claimTicket(client, guild, number, member);
    await interaction.reply({
      content: done
        ? `✅ Ticket **#${number}** preso in carico.`
        : 'Il ticket è già in carico a qualcuno, oppure è chiuso.',
      flags: done ? undefined : MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'close') {
    const prisma = getPrisma();
    const ticket = await prisma.ticket.findUnique({
      where: { guildId_number: { guildId: guild.id, number } },
    });
    // Anche chi ha aperto il ticket può chiuderlo: è la sua richiesta.
    if (!ticket || (!isSupport && ticket.openerId !== member.id)) {
      await interaction.reply({
        content: 'Non puoi chiudere questo ticket.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({ content: '🔒 Chiusura in corso…' });
    await closeTicket(
      client,
      guild,
      number,
      member.id,
      isSupport ? 'Chiuso dallo staff' : "Chiuso dall'autore",
      config,
    );
    return;
  }
}

async function handleGiveawayEntry(
  client: Client,
  interaction: ButtonInteraction,
  giveawayId: string,
): Promise<void> {
  const prisma = getPrisma();
  const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId } });

  if (!giveaway || giveaway.endedAt) {
    await interaction.reply({
      content: 'Questo giveaway è concluso.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = await prisma.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId, userId: interaction.user.id } },
  });

  // Premere di nuovo annulla la partecipazione: stesso principio del voto.
  if (existing) {
    await prisma.giveawayEntry.delete({ where: { id: existing.id } });
    await interaction.reply({
      content: 'Partecipazione annullata.',
      flags: MessageFlags.Ephemeral,
    });
    await refreshGiveawayMessage(client, giveawayId);
    return;
  }

  const requirements = giveaway.requirements as unknown as GiveawayRequirements;
  const check = await checkGiveawayEligibility(
    client,
    giveaway.guildId,
    interaction.user.id,
    requirements,
  );

  if (!check.ok) {
    await interaction.reply({
      content: `❌ Non puoi partecipare: ${check.reason}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await prisma.giveawayEntry.create({ data: { giveawayId, userId: interaction.user.id } });

  await interaction.reply({
    content: `🎉 Partecipazione registrata per **${giveaway.prize}**. In bocca al lupo!`,
    flags: MessageFlags.Ephemeral,
  });

  await recordEvent(client, {
    guildId: giveaway.guildId,
    type: 'GIVEAWAY_ENTERED',
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    channelId: giveaway.channelId,
    summary: `<@${interaction.user.id}> partecipa a **${giveaway.prize}**`,
    payload: { giveawayId },
  });

  await refreshGiveawayMessage(client, giveawayId);
}

/** Invio della finestra modale: al momento solo l'apertura dei ticket. */
async function handleModal(
  client: Client,
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId !== 'aegis:ticket-modal') return;
  if (!interaction.guild) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const config = await getGuildConfig(interaction.guildId!);
  const subject = interaction.fields.getTextInputValue('subject');

  const result = await openTicket(
    client,
    interaction.guild,
    interaction.member as GuildMember,
    subject,
    config,
  );

  await interaction.editReply(
    result.ok
      ? `✅ Ticket **#${result.number}** aperto in <#${result.channelId}>`
      : `❌ ${result.reason ?? 'Apertura fallita.'}`,
  );
}

/**
 * Menu di auto-assegnazione dei ruoli.
 *
 * Il menu restituisce la selezione *completa*, non la differenza: si calcola
 * qui cosa aggiungere e cosa togliere confrontando con i ruoli posseduti.
 */
async function handleSelectMenu(
  client: Client,
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('aegis:rr:')) return;
  if (!interaction.guild) return;

  const setId = interaction.customId.slice('aegis:rr:'.length);
  const prisma = getPrisma();
  const set = await prisma.reactionRoleSet.findUnique({ where: { id: setId } });
  if (!set) {
    await interaction.reply({ content: 'Menu non più valido.', flags: MessageFlags.Ephemeral });
    return;
  }

  const config = await getGuildConfig(interaction.guildId!);
  const options = set.options as unknown as { roleId: string; label: string }[];
  const managedRoleIds = options.map((option) => option.roleId);
  const member = interaction.member as GuildMember;
  const me = await interaction.guild.members.fetchMe();

  const selected = new Set(interaction.values);
  const toAdd: string[] = [];
  const toRemove: string[] = [];

  for (const roleId of managedRoleIds) {
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role || role.position >= me.roles.highest.position) continue;

    // Il controllo sui permessi si rifà qui e non solo alla creazione: un ruolo
    // innocuo al momento della pubblicazione può aver ricevuto permessi dopo.
    if (config.integrations.reactionRoles.blockPrivilegedRoles) {
      const privileged = config.security.antiNuke.dangerousPermissions.some((name) => {
        const flag = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
        return typeof flag === 'bigint' && role.permissions.has(flag);
      });
      if (privileged) continue;
    }

    const has = member.roles.cache.has(roleId);
    if (selected.has(roleId) && !has) toAdd.push(roleId);
    if (!selected.has(roleId) && has && set.mode !== 'VERIFY') toRemove.push(roleId);
  }

  if (toAdd.length > 0) {
    await member.roles.add(toAdd, `Menu ruoli «${set.title}»`).catch(() => undefined);
  }
  if (toRemove.length > 0) {
    await member.roles.remove(toRemove, `Menu ruoli «${set.title}»`).catch(() => undefined);
  }

  const describe = (ids: string[]) =>
    ids
      .map((id) => options.find((option) => option.roleId === id)?.label ?? id)
      .join(', ');

  await interaction.reply({
    content:
      toAdd.length === 0 && toRemove.length === 0
        ? 'Nessuna modifica ai tuoi ruoli.'
        : [
            toAdd.length > 0 ? `✅ Aggiunti: ${describe(toAdd)}` : null,
            toRemove.length > 0 ? `➖ Rimossi: ${describe(toRemove)}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
    flags: MessageFlags.Ephemeral,
  });

  for (const roleId of toAdd) {
    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'REACTION_ROLE_ASSIGNED',
      actorId: member.id,
      actorTag: member.user.tag,
      roleId,
      summary: `Ruolo auto-assegnato dal menu «${set.title}»`,
    });
  }
  for (const roleId of toRemove) {
    await recordEvent(client, {
      guildId: interaction.guildId!,
      type: 'REACTION_ROLE_REMOVED',
      actorId: member.id,
      actorTag: member.user.tag,
      roleId,
      summary: `Ruolo rimosso dal menu «${set.title}»`,
    });
  }
}
