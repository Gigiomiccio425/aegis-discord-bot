import type { Job } from 'bullmq';
import { getPrisma } from '@angel/db';
import { GuildConfigSchema, RedisKeys } from '@angel/shared';
import { getRedis } from '../redis.js';
import { childLogger } from '../logger.js';

const log = childLogger('integrations');

/**
 * Scadenze di sondaggi e giveaway.
 *
 * Il worker non chiude nulla da solo: pubblica la richiesta e il bot la
 * esegue. Serve la connessione al gateway per aggiornare il messaggio, e una
 * seconda connessione consumerebbe una sessione senza guadagno.
 *
 * Gira ogni minuto: un giveaway che dichiara «termina fra 24 ore» e si chiude
 * con dieci minuti di ritardo è una promessa non mantenuta, per quanto piccola.
 */
export async function integrationsProcessor(_job: Job): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis();
  const now = new Date();

  const duePolls = await prisma.poll.findMany({
    where: { closedAt: null, closesAt: { not: null, lte: now } },
    select: { id: true, guildId: true },
    take: 50,
  });

  for (const poll of duePolls) {
    await redis.publish(
      RedisKeys.commandChannel,
      JSON.stringify({ action: 'poll.close', guildId: poll.guildId, pollId: poll.id }),
    );
  }

  const dueGiveaways = await prisma.giveaway.findMany({
    where: { endedAt: null, endsAt: { lte: now } },
    select: { id: true, guildId: true },
    take: 50,
  });

  for (const giveaway of dueGiveaways) {
    await redis.publish(
      RedisKeys.commandChannel,
      JSON.stringify({
        action: 'giveaway.draw',
        guildId: giveaway.guildId,
        giveawayId: giveaway.id,
      }),
    );
  }

  // I promemoria degli eventi hanno bisogno dello stesso ritmo al minuto: un
  // avviso «fra 10 minuti» che arriva con un quarto d'ora di ritardo è peggio
  // che non mandarlo. La verifica la fa il bot, che ha già gli eventi in cache.
  const guilds = await prisma.guild.findMany({
    where: { active: true },
    select: { id: true, config: true },
  });

  let reminderChecks = 0;
  for (const guild of guilds) {
    const config = GuildConfigSchema.safeParse(guild.config);
    if (!config.success) continue;
    if (!config.data.integrations.events.enabled) continue;
    if (config.data.integrations.events.reminderMinutes.length === 0) continue;

    await redis.publish(
      RedisKeys.commandChannel,
      JSON.stringify({ action: 'events.reminders', guildId: guild.id }),
    );
    reminderChecks++;
  }

  if (duePolls.length > 0 || dueGiveaways.length > 0) {
    log.info(
      { polls: duePolls.length, giveaways: dueGiveaways.length, reminderChecks },
      'scadenze inoltrate al bot',
    );
  }
}
