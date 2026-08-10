import { Events, type Client } from 'discord.js';
import { recordEvent } from '../logging/auditLogger.js';
import { getGuildConfig } from '../core/config.js';
import { handleStarboardReaction } from '../integrations/starboard.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('events:reactions');

/**
 * Reazioni.
 *
 * Sono eventi ad altissima frequenza e per questo, nel canale Discord, finiscono
 * nel raggruppamento del logger. Nel database restano invece riga per riga:
 * servono a ricostruire chi era presente e attivo in un dato momento, cosa che
 * i soli messaggi non dicono.
 *
 * Richiede il partial `Reaction`, altrimenti le reazioni ai messaggi non in
 * cache — cioè tutti quelli precedenti l'ultimo riavvio — non arriverebbero.
 */
export function registerReactionEvents(client: Client): void {
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    if (user.bot) return;
    void (async () => {
      if (reaction.partial) await reaction.fetch().catch(() => undefined);
      const guildId = reaction.message.guildId;
      if (!guildId) return;

      const config = await getGuildConfig(guildId);
      await handleStarboardReaction(client, reaction, config).catch((error) =>
        log.debug({ err: error }, 'bacheca: aggiornamento fallito'),
      );

      await recordEvent(client, {
        guildId,
        type: 'REACTION_ADDED',
        actorId: user.id,
        actorTag: user.tag,
        channelId: reaction.message.channelId,
        messageId: reaction.message.id,
        summary: `Reazione ${reaction.emoji.toString()}`,
        payload: { emoji: reaction.emoji.name, emojiId: reaction.emoji.id },
      });
    })();
  });

  client.on(Events.MessageReactionRemove, (reaction, user) => {
    if (user.bot) return;
    void (async () => {
      const guildId = reaction.message.guildId;
      if (!guildId) return;

      // Anche la rimozione va gestita: un messaggio che scende sotto la soglia
      // esce dalla bacheca, altrimenti resterebbe lì a dire il falso.
      const config = await getGuildConfig(guildId);
      await handleStarboardReaction(client, reaction, config).catch(() => undefined);

      await recordEvent(client, {
        guildId,
        type: 'REACTION_REMOVED',
        actorId: user.id,
        actorTag: user.tag,
        channelId: reaction.message.channelId,
        messageId: reaction.message.id,
        summary: `Reazione rimossa ${reaction.emoji.toString()}`,
        payload: { emoji: reaction.emoji.name },
      });
    })();
  });

  client.on(Events.MessageReactionRemoveAll, (message) => {
    if (!message.guildId) return;
    void recordEvent(client, {
      guildId: message.guildId,
      type: 'REACTION_CLEARED',
      channelId: message.channelId,
      messageId: message.id,
      summary: 'Tutte le reazioni sono state rimosse',
    });
  });
}
