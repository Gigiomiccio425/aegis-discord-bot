import type { Job } from 'bullmq';
import { getPrisma } from '@angel/db';
import { GuildConfigSchema, type RssFeedConfig, type YouTubeChannelConfig } from '@angel/shared';
import { childLogger } from '../logger.js';
import { getRedis } from '../redis.js';
import { recordWorkerEvent, sendMessage } from '../discord.js';
import {
  fetchFeed,
  looksLive,
  resolveYouTubeChannelId,
  youtubeFeedUrl,
  type FeedItem,
} from '../feeds.js';

const log = childLogger('social');

/* ═══════════════════════════════════════════════════════════════════════
   NOTIFICHE DA FONTI ESTERNE

   YouTube e feed RSS/Atom. Entrambi funzionano leggendo un documento pubblico:
   nessuna chiave, nessuna quota, nessun rinnovo di token. È la ragione per cui
   sopravvivono ai cambi di politica delle piattaforme.

   Due protezioni che contano più della logica di pubblicazione:

   • **Nessun diluvio alla prima lettura.** Un feed appena aggiunto contiene
     quindici elementi già vecchi: la prima volta si registra soltanto il più
     recente, senza annunciare nulla. Altrimenti l'aggiunta di un canale
     riempirebbe di colpo il canale Discord.

   • **Le fonti che falliscono si mettono in pausa da sole.** Un feed morto
     interrogato ogni dieci minuti per mesi è traffico sprecato e rumore nei
     log: dopo dieci errori consecutivi si smette, e si riprova di rado.
   ═══════════════════════════════════════════════════════════════════════ */

const MAX_FAILURES = 10;

export async function socialProcessor(_job: Job): Promise<void> {
  const prisma = getPrisma();
  const guilds = await prisma.guild.findMany({
    where: { active: true },
    select: { id: true, config: true },
  });

  for (const guild of guilds) {
    const parsed = GuildConfigSchema.safeParse(guild.config);
    if (!parsed.success) continue;
    const config = parsed.data;

    if (config.integrations.youtube.enabled) {
      for (const channel of config.integrations.youtube.channels) {
        if (!channel.enabled) continue;
        if (!(await due(guild.id, 'youtube', channel.channel, config.integrations.youtube.pollMinutes))) {
          continue;
        }
        await checkYouTube(guild.id, channel).catch((error) =>
          log.warn({ err: error, channel: channel.channel }, 'controllo YouTube fallito'),
        );
      }
    }

    if (config.integrations.rss.enabled) {
      for (const feed of config.integrations.rss.feeds) {
        if (!feed.enabled) continue;
        if (!(await due(guild.id, 'rss', feed.url, config.integrations.rss.pollMinutes))) continue;
        await checkRss(guild.id, feed).catch((error) =>
          log.warn({ err: error, url: feed.url }, 'controllo RSS fallito'),
        );
      }
    }
  }
}

/**
 * Vero solo quando l'intervallo della fonte è trascorso.
 *
 * Il job gira spesso, ma ogni fonte viene interrogata al proprio ritmo: un
 * feed che pubblica una volta al giorno non ha motivo di essere letto ogni
 * cinque minuti.
 */
async function due(
  guildId: string,
  platform: string,
  identifier: string,
  minutes: number,
): Promise<boolean> {
  const key = `social:due:${guildId}:${platform}:${Buffer.from(identifier).toString('base64url').slice(0, 60)}`;
  const claimed = await getRedis().set(key, '1', 'EX', Math.max(60, minutes * 60), 'NX');
  return claimed !== null;
}

interface SourceState {
  id: string;
  lastItemId: string | null;
  failureCount: number;
  isNew: boolean;
}

async function loadSource(
  guildId: string,
  platform: string,
  identifier: string,
  displayName?: string,
): Promise<SourceState> {
  const prisma = getPrisma();
  const existing = await prisma.socialSource.findUnique({
    where: { guildId_platform_identifier: { guildId, platform, identifier } },
  });

  if (existing) {
    return {
      id: existing.id,
      lastItemId: existing.lastItemId,
      failureCount: existing.failureCount,
      isNew: false,
    };
  }

  const created = await prisma.socialSource.create({
    data: { guildId, platform, identifier, displayName: displayName ?? null },
  });
  return { id: created.id, lastItemId: null, failureCount: 0, isNew: true };
}

async function markFailure(sourceId: string, message: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.socialSource
    .update({
      where: { id: sourceId },
      data: {
        failureCount: { increment: 1 },
        lastError: message.slice(0, 300),
        lastCheckedAt: new Date(),
      },
    })
    .catch(() => undefined);
}

/**
 * Voci non ancora pubblicate.
 *
 * Il confronto è per identificativo, non per data: i feed hanno date
 * inaffidabili — fusi orari sbagliati, aggiornamenti che cambiano la data di
 * pubblicazione, elementi ripubblicati. L'ID è l'unica cosa stabile.
 */
function newItems(items: FeedItem[], lastItemId: string | null): FeedItem[] {
  if (!lastItemId) return [];
  const index = items.findIndex((item) => item.id === lastItemId);
  // Se l'ultimo elemento noto non c'è più nel feed, si prende solo il più
  // recente: pubblicare tutti e quindici sarebbe peggio che perderne qualcuno.
  if (index === -1) return items.slice(0, 1);
  return items.slice(0, index);
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/* ── YouTube ──────────────────────────────────────────────────────────── */

async function checkYouTube(guildId: string, channel: YouTubeChannelConfig): Promise<void> {
  const prisma = getPrisma();

  const channelId = channel.channelId ?? (await resolveYouTubeChannelId(channel.channel));
  if (!channelId) {
    log.warn({ channel: channel.channel }, 'ID del canale YouTube non risolto');
    return;
  }

  const source = await loadSource(guildId, 'youtube', channelId, channel.displayName);
  if (source.failureCount >= MAX_FAILURES) return;

  const feed = await fetchFeed(youtubeFeedUrl(channelId));
  if (!feed) {
    await markFailure(source.id, 'feed non raggiungibile');
    return;
  }
  if (feed.items.length === 0) return;

  const latest = feed.items[0]!;

  // Prima lettura: si memorizza soltanto, senza annunciare nulla.
  if (source.isNew || !source.lastItemId) {
    await prisma.socialSource.update({
      where: { id: source.id },
      data: {
        lastItemId: latest.id,
        lastItemAt: latest.publishedAt ?? new Date(),
        lastCheckedAt: new Date(),
        displayName: feed.title,
        failureCount: 0,
        lastError: null,
      },
    });
    log.info({ guildId, channelId, title: feed.title }, 'canale YouTube registrato');
    return;
  }

  const fresh = newItems(feed.items, source.lastItemId);

  // Dal più vecchio al più recente: l'ordine di pubblicazione deve rispecchiare
  // quello reale, altrimenti in chat i video compaiono al contrario.
  for (const item of fresh.reverse()) {
    if (!channel.announceChannelId) continue;

    const live = channel.announceLive && looksLive(item);
    const content = applyTemplate(
      live ? '🔴 **{autore}** è in diretta!\n**{titolo}**\n{url}' : channel.template,
      {
        autore: item.author ?? feed.title,
        titolo: item.title,
        url: item.link,
        tipo: live ? 'diretta' : 'video',
      },
    );

    await sendMessage(channel.announceChannelId, {
      content: channel.mentionRoleId ? `<@&${channel.mentionRoleId}> ${content}` : content,
      allowed_mentions: channel.mentionRoleId ? { roles: [channel.mentionRoleId] } : { parse: [] },
    });

    await recordWorkerEvent({
      guildId,
      type: 'INTEGRATION_ANNOUNCEMENT',
      channelId: channel.announceChannelId,
      summary: `${live ? 'Diretta' : 'Video'} YouTube di **${feed.title}**: ${item.title}`,
      payload: { platform: 'youtube', channelId, videoId: item.id, live },
    });
  }

  await prisma.socialSource.update({
    where: { id: source.id },
    data: {
      lastItemId: latest.id,
      lastItemAt: latest.publishedAt ?? new Date(),
      lastCheckedAt: new Date(),
      displayName: feed.title,
      failureCount: 0,
      lastError: null,
    },
  });
}

/* ── RSS generico ─────────────────────────────────────────────────────── */

async function checkRss(guildId: string, feedConfig: RssFeedConfig): Promise<void> {
  const prisma = getPrisma();
  const source = await loadSource(guildId, 'rss', feedConfig.url, feedConfig.label);
  if (source.failureCount >= MAX_FAILURES) return;

  const feed = await fetchFeed(feedConfig.url);
  if (!feed) {
    await markFailure(source.id, 'feed non raggiungibile');
    return;
  }
  if (feed.items.length === 0) return;

  const latest = feed.items[0]!;
  const label = feedConfig.label || feed.title;

  if (source.isNew || !source.lastItemId) {
    await prisma.socialSource.update({
      where: { id: source.id },
      data: {
        lastItemId: latest.id,
        lastItemAt: latest.publishedAt ?? new Date(),
        lastCheckedAt: new Date(),
        displayName: feed.title,
        failureCount: 0,
        lastError: null,
      },
    });
    log.info({ guildId, url: feedConfig.url, title: feed.title }, 'feed RSS registrato');
    return;
  }

  let fresh = newItems(feed.items, source.lastItemId);

  // I filtri si applicano al titolo: è l'unico campo presente in tutti i feed
  // e l'unico che l'autore compila sempre con cura.
  if (feedConfig.includeKeywords.length > 0) {
    fresh = fresh.filter((item) =>
      feedConfig.includeKeywords.some((word) =>
        item.title.toLowerCase().includes(word.toLowerCase()),
      ),
    );
  }
  if (feedConfig.excludeKeywords.length > 0) {
    fresh = fresh.filter(
      (item) =>
        !feedConfig.excludeKeywords.some((word) =>
          item.title.toLowerCase().includes(word.toLowerCase()),
        ),
    );
  }

  for (const item of fresh.slice(0, feedConfig.maxPerCheck).reverse()) {
    if (!feedConfig.announceChannelId) continue;

    const content = applyTemplate(feedConfig.template, {
      titolo: item.title,
      url: item.link,
      autore: item.author ?? label,
      fonte: label,
      descrizione: item.description ?? '',
    });

    await sendMessage(feedConfig.announceChannelId, {
      content: feedConfig.mentionRoleId ? `<@&${feedConfig.mentionRoleId}> ${content}` : content,
      allowed_mentions: feedConfig.mentionRoleId
        ? { roles: [feedConfig.mentionRoleId] }
        : { parse: [] },
    });

    await recordWorkerEvent({
      guildId,
      type: 'INTEGRATION_ANNOUNCEMENT',
      channelId: feedConfig.announceChannelId,
      summary: `Nuovo articolo da **${label}**: ${item.title}`,
      payload: { platform: 'rss', url: feedConfig.url, itemId: item.id },
    });
  }

  await prisma.socialSource.update({
    where: { id: source.id },
    data: {
      lastItemId: latest.id,
      lastItemAt: latest.publishedAt ?? new Date(),
      lastCheckedAt: new Date(),
      displayName: feed.title,
      failureCount: 0,
      lastError: null,
    },
  });
}
