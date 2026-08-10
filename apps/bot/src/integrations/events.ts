import {
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventStatus,
  type Client,
  type Guild,
  type GuildScheduledEvent,
  type TextChannel,
} from 'discord.js';
import type { GuildConfig } from '@aegis/shared';
import { getRedis } from '../core/redis.js';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';

const log = childLogger('events');

/* ═══════════════════════════════════════════════════════════════════════
   EVENTI PROGRAMMATI — PROMEMORIA E RSVP

   Discord ha già gli eventi programmati e la lista degli interessati. Quello
   che non ha sono i promemoria: l'unica notifica arriva all'inizio, quando chi
   se n'è dimenticato è già altrove. Qui si aggiungono gli avvisi anticipati e
   un ruolo temporaneo per chi si è iscritto, così lo si può menzionare senza
   svegliare tutto il server.

   La deduplicazione è affidata a Redis e non alla memoria: il controllo gira
   ogni minuto, e senza un segno persistente un riavvio del bot rimanderebbe lo
   stesso promemoria una seconda volta.
   ═══════════════════════════════════════════════════════════════════════ */

/** Finestra di tolleranza: il controllo gira al minuto, non al secondo. */
const WINDOW_MS = 90_000;

export async function checkEventReminders(
  client: Client,
  guild: Guild,
  config: GuildConfig,
): Promise<number> {
  const settings = config.integrations.events;
  if (!settings.enabled || settings.reminderMinutes.length === 0) return 0;

  const channelId = settings.announceChannelId ?? config.logging.defaultChannelId;
  if (!channelId) return 0;

  const events = await guild.scheduledEvents.fetch().catch(() => null);
  if (!events) return 0;

  const redis = getRedis();
  const now = Date.now();
  let sent = 0;

  for (const event of events.values()) {
    if (event.status !== GuildScheduledEventStatus.Scheduled) continue;
    if (!event.scheduledStartTimestamp) continue;

    for (const minutes of settings.reminderMinutes) {
      const target = event.scheduledStartTimestamp - minutes * 60_000;
      if (now < target || now > target + WINDOW_MS) continue;

      // NX + scadenza: il primo processo che arriva manda il promemoria, gli
      // altri (e i riavvii) trovano la chiave già presente.
      const key = `evt:rem:${event.id}:${minutes}`;
      const claimed = await redis.set(key, '1', 'EX', 86400, 'NX');
      if (claimed === null) continue;

      await sendReminder(client, guild, event, channelId, minutes, config).catch((error) =>
        log.warn({ err: error, eventId: event.id }, 'promemoria non inviato'),
      );
      sent++;
    }
  }

  return sent;
}

async function sendReminder(
  client: Client,
  guild: Guild,
  event: GuildScheduledEvent,
  channelId: string,
  minutes: number,
  config: GuildConfig,
): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const when = Math.floor((event.scheduledStartTimestamp ?? 0) / 1000);
  const label =
    minutes >= 1440
      ? `${Math.round(minutes / 1440)} ${Math.round(minutes / 1440) === 1 ? 'giorno' : 'giorni'}`
      : minutes >= 60
        ? `${Math.round(minutes / 60)} ${Math.round(minutes / 60) === 1 ? 'ora' : 'ore'}`
        : `${minutes} minuti`;

  const embed = new EmbedBuilder()
    .setTitle(`📅 ${event.name}`)
    .setColor(0x5865f2)
    .setDescription(
      (event.description ? `${event.description.slice(0, 500)}\n\n` : '') +
        `**Inizia fra ${label}** — <t:${when}:f> (<t:${when}:R>)`,
    )
    .setURL(event.url);

  if (event.channel) {
    embed.addFields({ name: 'Dove', value: `<#${event.channelId}>`, inline: true });
  } else if (event.entityMetadata?.location) {
    embed.addFields({ name: 'Dove', value: event.entityMetadata.location, inline: true });
  }

  const interested = event.userCount ?? 0;
  if (interested > 0) {
    embed.addFields({ name: 'Interessati', value: String(interested), inline: true });
  }

  // Si menziona il ruolo RSVP se esiste: sono le persone che hanno detto di
  // voler partecipare, e sono le uniche che vogliono davvero l'avviso.
  const mention = config.integrations.events.rsvpRoleId;

  await (channel as TextChannel).send({
    content: mention ? `<@&${mention}>` : undefined,
    embeds: [embed],
    allowedMentions: mention ? { roles: [mention] } : { parse: [] },
  });

  await recordEvent(client, {
    guildId: guild.id,
    type: 'INTEGRATION_ANNOUNCEMENT',
    channelId,
    summary: `Promemoria evento «${event.name}» — ${label} all'inizio`,
    payload: { eventId: event.id, minutes, interested },
  });
}

/**
 * Ruolo temporaneo per chi si dichiara interessato.
 *
 * Serve a poter avvisare i partecipanti senza usare @everyone: chi non ha
 * intenzione di partecipare non riceve nulla, e chi partecipa non deve
 * controllare il canale ogni ora.
 */
export async function onEventInterest(
  client: Client,
  guild: Guild,
  userId: string,
  config: GuildConfig,
  interested: boolean,
): Promise<void> {
  const roleId = config.integrations.events.rsvpRoleId;
  if (!config.integrations.events.enabled || !roleId) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  if (interested) {
    await member.roles.add(roleId, 'Iscrizione a un evento programmato').catch(() => undefined);
  } else {
    // Il ruolo si toglie solo se la persona non è interessata a nessun altro
    // evento in programma: altrimenti disiscriversi da uno la escluderebbe
    // dagli avvisi di tutti.
    const events = await guild.scheduledEvents.fetch().catch(() => null);
    if (events) {
      for (const event of events.values()) {
        if (event.status !== GuildScheduledEventStatus.Scheduled) continue;
        const subscribers = await event.fetchSubscribers({ limit: 100 }).catch(() => null);
        if (subscribers?.has(userId)) return;
      }
    }
    await member.roles.remove(roleId, 'Nessun evento in programma').catch(() => undefined);
  }

  void client;
}
