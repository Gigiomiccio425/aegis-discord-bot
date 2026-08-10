import { createHash } from 'node:crypto';
import { ChannelType, type Client, type TextChannel } from 'discord.js';
import { getPrisma } from '@aegis/db';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';
import { buildGiveawayMessage, buildPollMessage } from './render.js';

const log = childLogger('integrations');

/* ═══════════════════════════════════════════════════════════════════════
   AZIONI SU SONDAGGI E GIVEAWAY

   Stanno qui e non nei comandi perché servono a tre chiamanti diversi: il
   comando manuale, l'handler del pulsante e il job periodico del worker che
   chiude ciò che è scaduto.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Identificativo del votante nei sondaggi anonimi.
 *
 * Non si salva l'ID Discord: si salva un hash con sale legato al sondaggio.
 * Così resta possibile impedire il doppio voto, ma non risalire a chi ha
 * votato cosa — nemmeno con accesso diretto al database. Un sondaggio
 * "anonimo" che conserva gli ID non è anonimo.
 */
export function voterKey(pollId: string, userId: string, anonymous: boolean): string {
  if (!anonymous) return userId;
  return createHash('sha256').update(`${pollId}:${userId}`).digest('hex').slice(0, 32);
}

/** Aggiorna il messaggio di un sondaggio a partire dallo stato nel database. */
export async function refreshPollMessage(client: Client, pollId: string): Promise<void> {
  const prisma = getPrisma();
  const poll = await prisma.poll.findUnique({ where: { id: pollId } });
  if (!poll?.messageId) return;

  const channel = await client.channels.fetch(poll.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const message = await (channel as TextChannel).messages.fetch(poll.messageId).catch(() => null);
  if (!message) return;

  await message.edit(await buildPollMessage(pollId)).catch(() => undefined);
}

export async function closePoll(client: Client, pollId: string): Promise<void> {
  const prisma = getPrisma();
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: { votes: true },
  });
  if (!poll || poll.closedAt) return;

  await prisma.poll.update({ where: { id: pollId }, data: { closedAt: new Date() } });
  await refreshPollMessage(client, pollId);

  const options = poll.options as unknown as { index: number; label: string }[];
  const tally = new Map<number, number>();
  for (const vote of poll.votes) {
    for (const optionIndex of vote.optionIds) {
      tally.set(optionIndex, (tally.get(optionIndex) ?? 0) + 1);
    }
  }

  const ranking = [...options]
    .map((option) => ({ label: option.label, count: tally.get(option.index) ?? 0 }))
    .sort((a, b) => b.count - a.count);

  await recordEvent(client, {
    guildId: poll.guildId,
    type: 'POLL_CLOSED',
    channelId: poll.channelId,
    messageId: poll.messageId,
    summary:
      `Sondaggio chiuso: ${poll.question.slice(0, 100)}\n` +
      ranking.map((entry) => `• ${entry.label}: ${entry.count}`).join('\n'),
    payload: { pollId, voters: poll.votes.length, ranking },
  });

  log.info({ pollId, voters: poll.votes.length }, 'sondaggio chiuso');
}

export interface GiveawayRequirements {
  minAccountAgeDays: number;
  minMembershipDays: number;
  requiredRoleIds: string[];
  blockedRoleIds: string[];
}

/**
 * Verifica i requisiti di partecipazione.
 *
 * Restituisce il motivo dell'esclusione invece di un semplice booleano: dire
 * «non puoi partecipare» senza spiegare perché genera solo ticket allo staff.
 */
export async function checkGiveawayEligibility(
  client: Client,
  guildId: string,
  userId: string,
  requirements: GiveawayRequirements,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { ok: false, reason: 'Server non raggiungibile.' };

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, reason: 'Non risulti membro del server.' };

  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  if (accountAgeDays < requirements.minAccountAgeDays) {
    return {
      ok: false,
      reason: `Il tuo account deve avere almeno ${requirements.minAccountAgeDays} giorni (ne ha ${Math.floor(accountAgeDays)}).`,
    };
  }

  const membershipDays = member.joinedTimestamp
    ? (Date.now() - member.joinedTimestamp) / 86_400_000
    : 0;
  if (membershipDays < requirements.minMembershipDays) {
    return {
      ok: false,
      reason: `Devi essere nel server da almeno ${requirements.minMembershipDays} giorni.`,
    };
  }

  for (const roleId of requirements.requiredRoleIds ?? []) {
    if (!member.roles.cache.has(roleId)) {
      return { ok: false, reason: `Ti manca il ruolo <@&${roleId}>.` };
    }
  }
  for (const roleId of requirements.blockedRoleIds ?? []) {
    if (member.roles.cache.has(roleId)) {
      return { ok: false, reason: 'Un tuo ruolo ti esclude da questo giveaway.' };
    }
  }

  return { ok: true };
}

/** Aggiorna il messaggio di un giveaway. */
export async function refreshGiveawayMessage(client: Client, giveawayId: string): Promise<void> {
  const prisma = getPrisma();
  const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
  if (!giveaway?.messageId) return;

  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const message = await (channel as TextChannel).messages
    .fetch(giveaway.messageId)
    .catch(() => null);
  if (!message) return;

  await message.edit(await buildGiveawayMessage(giveawayId)).catch(() => undefined);
}

/**
 * Estrazione.
 *
 * I requisiti vengono ricontrollati al momento dell'estrazione, non solo
 * all'iscrizione: fra i due momenti possono passare giorni, e chi ha perso il
 * ruolo richiesto o è stato bandito non deve poter vincere.
 */
export async function drawGiveaway(
  client: Client,
  giveawayId: string,
  redraw = false,
): Promise<string[]> {
  const prisma = getPrisma();
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: { entries: true },
  });
  if (!giveaway) return [];
  if (giveaway.endedAt && !redraw) return giveaway.winnerIds;

  const requirements = giveaway.requirements as unknown as GiveawayRequirements;
  const previousWinners = redraw ? new Set(giveaway.winnerIds) : new Set<string>();

  const eligible: string[] = [];
  for (const entry of giveaway.entries) {
    if (entry.rejected) continue;
    if (previousWinners.has(entry.userId)) continue;
    const check = await checkGiveawayEligibility(
      client,
      giveaway.guildId,
      entry.userId,
      requirements,
    );
    if (check.ok) eligible.push(entry.userId);
  }

  // Mescolamento Fisher-Yates: un `sort(() => Math.random() - 0.5)` produce una
  // distribuzione tutt'altro che uniforme, e in un'estrazione conta.
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
  }

  const winners = eligible.slice(0, giveaway.winnerCount);

  await prisma.giveaway.update({
    where: { id: giveawayId },
    data: {
      endedAt: new Date(),
      winnerIds: redraw ? [...giveaway.winnerIds, ...winners] : winners,
    },
  });

  await refreshGiveawayMessage(client, giveawayId);

  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (channel?.type === ChannelType.GuildText) {
    await (channel as TextChannel)
      .send({
        content:
          winners.length > 0
            ? `🎉 ${winners.map((id) => `<@${id}>`).join(', ')} — hai vinto **${giveaway.prize}**!`
            : `Nessun partecipante idoneo per **${giveaway.prize}**: nessun vincitore.`,
        reply: giveaway.messageId ? { messageReference: giveaway.messageId } : undefined,
        allowedMentions: { users: winners },
      })
      .catch(() => undefined);
  }

  await recordEvent(client, {
    guildId: giveaway.guildId,
    type: 'GIVEAWAY_ENDED',
    channelId: giveaway.channelId,
    messageId: giveaway.messageId,
    summary:
      `Giveaway concluso: ${giveaway.prize}\n` +
      `Partecipanti idonei: ${eligible.length} · vincitori: ${winners.length}`,
    payload: { giveawayId, winners, eligible: eligible.length, redraw },
  });

  log.info({ giveawayId, winners: winners.length, eligible: eligible.length }, 'giveaway estratto');
  return winners;
}
