import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type BaseMessageOptions,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import { absoluteTimestamp, relativeTimestamp } from './duration.js';

/* ═══════════════════════════════════════════════════════════════════════
   RENDERING DEI MESSAGGI INTERATTIVI

   I messaggi vengono ricostruiti dal database a ogni aggiornamento, invece di
   modificare quello esistente a partire dal suo contenuto. Il motivo è che il
   messaggio su Discord non è la fonte di verità: se due persone votano nello
   stesso istante, leggere e riscrivere il messaggio perderebbe un voto.
   Il database è la fonte, il messaggio ne è solo la fotografia.
   ═══════════════════════════════════════════════════════════════════════ */

interface PollOption {
  index: number;
  label: string;
}

const BARS = 12;

function bar(fraction: number): string {
  const filled = Math.round(fraction * BARS);
  return '█'.repeat(filled) + '░'.repeat(BARS - filled);
}

export async function buildPollMessage(pollId: string): Promise<BaseMessageOptions> {
  const prisma = getPrisma();
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: { votes: true },
  });
  if (!poll) return { content: 'Sondaggio non trovato.' };

  const options = poll.options as unknown as PollOption[];
  const closed = poll.closedAt !== null;

  const tally = new Map<number, number>();
  for (const vote of poll.votes) {
    for (const optionIndex of vote.optionIds) {
      tally.set(optionIndex, (tally.get(optionIndex) ?? 0) + 1);
    }
  }
  const totalVoters = poll.votes.length;

  // I risultati parziali restano nascosti finché il sondaggio è aperto: vedere
  // l'opzione in testa influenza chi deve ancora votare.
  const showResults = closed;

  const embed = new EmbedBuilder()
    .setTitle(poll.question.slice(0, 256))
    .setColor(closed ? 0x95a5a6 : 0x5865f2)
    .setDescription(
      showResults
        ? options
            .map((option) => {
              const count = tally.get(option.index) ?? 0;
              const fraction = totalVoters > 0 ? count / totalVoters : 0;
              return (
                `**${option.label}**\n\`${bar(fraction)}\` ${count} ` +
                `(${Math.round(fraction * 100)}%)`
              );
            })
            .join('\n\n')
        : options.map((option) => `• ${option.label}`).join('\n'),
    )
    .setFooter({
      text:
        `${totalVoters} ${totalVoters === 1 ? 'votante' : 'votanti'}` +
        (poll.multiSelect ? ' · scelta multipla' : '') +
        (poll.anonymous ? ' · anonimo' : '') +
        (closed ? ' · CHIUSO' : ''),
    });

  if (!closed && poll.closesAt) {
    embed.addFields({
      name: 'Chiusura',
      value: `${relativeTimestamp(poll.closesAt)} · ${absoluteTimestamp(poll.closesAt)}`,
    });
  }
  if (poll.allowedRoleIds.length > 0) {
    embed.addFields({
      name: 'Possono votare',
      value: poll.allowedRoleIds.map((roleId) => `<@&${roleId}>`).join(', '),
    });
  }

  if (closed) return { embeds: [embed], components: [] };

  // Discord consente 5 pulsanti per riga e 5 righe: 25 opzioni al massimo,
  // che coincide con il limite dello schema.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < options.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      options.slice(i, i + 5).map((option) =>
        new ButtonBuilder()
          .setCustomId(`aegis:poll:${poll.id}:${option.index}`)
          .setLabel(option.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
      ),
    );
    rows.push(row);
  }

  return { embeds: [embed], components: rows.slice(0, 5) };
}

interface GiveawayRequirements {
  minAccountAgeDays: number;
  minMembershipDays: number;
  requiredRoleIds: string[];
  blockedRoleIds: string[];
}

export async function buildGiveawayMessage(giveawayId: string): Promise<BaseMessageOptions> {
  const prisma = getPrisma();
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: { _count: { select: { entries: true } } },
  });
  if (!giveaway) return { content: 'Giveaway non trovato.' };

  const requirements = giveaway.requirements as unknown as GiveawayRequirements;
  const ended = giveaway.endedAt !== null;

  const conditions: string[] = [];
  if (requirements.minAccountAgeDays > 0) {
    conditions.push(`account creato da almeno ${requirements.minAccountAgeDays} giorni`);
  }
  if (requirements.minMembershipDays > 0) {
    conditions.push(`nel server da almeno ${requirements.minMembershipDays} giorni`);
  }
  for (const roleId of requirements.requiredRoleIds ?? []) {
    conditions.push(`ruolo <@&${roleId}>`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`🎁 ${giveaway.prize.slice(0, 240)}`)
    .setColor(ended ? 0x95a5a6 : 0xf1c40f)
    .setDescription(
      ended
        ? giveaway.winnerIds.length > 0
          ? `**Vincitori:** ${giveaway.winnerIds.map((id) => `<@${id}>`).join(', ')}`
          : 'Nessun partecipante idoneo: nessun vincitore.'
        : `Premi il pulsante per partecipare.\nTermina ${relativeTimestamp(giveaway.endsAt)}`,
    )
    .setFooter({
      text:
        `${giveaway._count.entries} partecipanti · ` +
        `${giveaway.winnerCount} ${giveaway.winnerCount === 1 ? 'vincitore' : 'vincitori'}` +
        (ended ? ' · CONCLUSO' : ''),
    });

  if (conditions.length > 0 && !ended) {
    embed.addFields({ name: 'Requisiti', value: conditions.map((c) => `• ${c}`).join('\n') });
  }

  if (ended) return { embeds: [embed], components: [] };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`aegis:giveaway:${giveaway.id}`)
      .setLabel('Partecipa')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎉'),
  );

  return { embeds: [embed], components: [row] };
}

interface ReactionRoleOption {
  roleId: string;
  label: string;
  description?: string;
}

export async function buildReactionRoleMessage(setId: string): Promise<BaseMessageOptions> {
  const prisma = getPrisma();
  const set = await prisma.reactionRoleSet.findUnique({ where: { id: setId } });
  if (!set) return { content: 'Menu non trovato.' };

  const options = set.options as unknown as ReactionRoleOption[];

  const modeNote =
    set.mode === 'EXCLUSIVE'
      ? 'Puoi avere un solo ruolo alla volta: sceglierne uno sostituisce il precedente.'
      : set.mode === 'VERIFY'
        ? 'I ruoli si possono solo aggiungere.'
        : 'Puoi selezionare più voci. Deselezionandone una, il ruolo viene rimosso.';

  const embed = new EmbedBuilder()
    .setTitle(set.title.slice(0, 256))
    .setColor(0x5865f2)
    .setDescription(`${options.map((option) => `• ${option.label}`).join('\n')}\n\n_${modeNote}_`);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`aegis:rr:${set.id}`)
    .setPlaceholder('Scegli i tuoi ruoli')
    .setMinValues(0)
    .setMaxValues(set.mode === 'EXCLUSIVE' ? 1 : Math.min(options.length, 25))
    .addOptions(
      options.slice(0, 25).map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label.slice(0, 100))
          .setValue(option.roleId)
          .setDescription(option.description?.slice(0, 100) ?? ' ')
          .setDefault(false),
      ),
    );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}
