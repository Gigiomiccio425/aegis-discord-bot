import {
  ChannelType,
  EmbedBuilder,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type TextChannel,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import type { GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';

const log = childLogger('starboard');

/* ═══════════════════════════════════════════════════════════════════════
   BACHECA

   Il collegamento fra messaggio originale e copia in bacheca vive nel
   database, non in memoria: senza, un riavvio del bot produrrebbe un doppione
   alla prima nuova reazione su un messaggio già promosso.

   Il conteggio viene riletto da Discord a ogni variazione invece di essere
   incrementato: le reazioni si tolgono, i messaggi si cancellano, e un
   contatore incrementale diverge dalla realtà nel giro di poche ore.
   ═══════════════════════════════════════════════════════════════════════ */

function matchesEmoji(reaction: MessageReaction | PartialMessageReaction, configured: string): boolean {
  const custom = /^<a?:(\w+):(\d+)>$/.exec(configured);
  if (custom) return reaction.emoji.id === custom[2];
  return reaction.emoji.name === configured;
}

export async function handleStarboardReaction(
  client: Client,
  reaction: MessageReaction | PartialMessageReaction,
  config: GuildConfig,
): Promise<void> {
  const settings = config.integrations.starboard;
  if (!settings.enabled || !settings.channelId) return;
  if (!matchesEmoji(reaction, settings.emoji)) return;

  const message = reaction.message;
  const guildId = message.guildId;
  if (!guildId) return;
  if (settings.ignoredChannelIds.includes(message.channelId)) return;
  if (message.channelId === settings.channelId) return; // niente ricorsione

  const full = message.partial ? await message.fetch().catch(() => null) : message;
  if (!full) return;
  if (settings.ignoreBots && full.author?.bot) return;

  const sourceChannel = full.channel;
  if (settings.ignoreNsfw && sourceChannel.type === ChannelType.GuildText && sourceChannel.nsfw) {
    return;
  }

  // Il conteggio si rilegge dalla reazione aggiornata, e si esclude l'autore se
  // l'autovoto non è consentito.
  const fresh = full.reactions.cache.find((entry) => matchesEmoji(entry, settings.emoji));
  let count = fresh?.count ?? 0;

  if (!settings.allowSelfStar && fresh && full.author) {
    const users = await fresh.users.fetch().catch(() => null);
    if (users?.has(full.author.id)) count -= 1;
  }

  const prisma = getPrisma();
  const existing = await prisma.starboardEntry.findUnique({
    where: { guildId_sourceMessageId: { guildId, sourceMessageId: full.id } },
  });

  const board = (await client.channels.fetch(settings.channelId).catch(() => null)) as
    | TextChannel
    | null;
  if (!board || board.type !== ChannelType.GuildText) return;

  /* ── Sotto soglia ───────────────────────────────────────────────────── */
  if (count < settings.threshold) {
    if (!existing?.starboardMessageId || !settings.removeBelowThreshold) return;

    await board.messages
      .fetch(existing.starboardMessageId)
      .then((entry) => entry.delete())
      .catch(() => undefined);

    await prisma.starboardEntry
      .delete({ where: { id: existing.id } })
      .catch(() => undefined);

    await recordEvent(client, {
      guildId,
      type: 'STARBOARD_REMOVED',
      actorId: full.author?.id ?? null,
      channelId: full.channelId,
      messageId: full.id,
      summary: `Messaggio rimosso dalla bacheca: sceso a ${count} ${settings.emoji}`,
      payload: { count },
    });
    return;
  }

  /* ── Sopra soglia ───────────────────────────────────────────────────── */
  const payload = buildStarboardMessage(full, count, settings);

  if (existing?.starboardMessageId) {
    const posted = await board.messages.fetch(existing.starboardMessageId).catch(() => null);
    if (posted) {
      await posted.edit(payload).catch(() => undefined);
      await prisma.starboardEntry.update({ where: { id: existing.id }, data: { count } });
      return;
    }
    // Il messaggio in bacheca è stato eliminato a mano: si ricrea.
  }

  const posted = await board.send(payload).catch((error: Error) => {
    log.warn({ err: error, guildId }, 'pubblicazione in bacheca fallita');
    return null;
  });
  if (!posted) return;

  await prisma.starboardEntry.upsert({
    where: { guildId_sourceMessageId: { guildId, sourceMessageId: full.id } },
    create: {
      guildId,
      sourceMessageId: full.id,
      sourceChannelId: full.channelId,
      authorId: full.author?.id ?? 'sconosciuto',
      starboardMessageId: posted.id,
      count,
    },
    update: { starboardMessageId: posted.id, count },
  });

  await recordEvent(client, {
    guildId,
    type: 'STARBOARD_ADDED',
    actorId: full.author?.id ?? null,
    channelId: full.channelId,
    messageId: full.id,
    summary: `Messaggio promosso in bacheca con ${count} ${settings.emoji}`,
    payload: { count, starboardMessageId: posted.id },
  });
}

function buildStarboardMessage(
  message: Message,
  count: number,
  settings: GuildConfig['integrations']['starboard'],
) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setAuthor({
      name: message.author?.tag ?? 'Sconosciuto',
      iconURL: message.author?.displayAvatarURL(),
    })
    .setDescription(message.content?.slice(0, 3000) || '*(nessun testo)*')
    .addFields({
      name: 'Origine',
      value: `[vai al messaggio](${message.url}) in <#${message.channelId}>`,
    })
    .setTimestamp(message.createdAt);

  // La prima immagine allegata viene mostrata: senza, metà bacheca sarebbe
  // fatta di riquadri vuoti che rimandano altrove.
  const image = message.attachments.find((attachment) =>
    attachment.contentType?.startsWith('image/'),
  );
  if (image) embed.setImage(image.url);

  return {
    content: `${settings.emoji} **${count}** · <#${message.channelId}>`,
    embeds: [embed],
    allowedMentions: { parse: [] as never[] },
  };
}
