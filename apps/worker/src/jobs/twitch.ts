import type { Job } from 'bullmq';
import { getPrisma } from '@angel/db';
import { GuildConfigSchema } from '@angel/shared';
import { childLogger } from '../logger.js';
import { getRedis } from '../redis.js';
import { recordWorkerEvent, sendMessage, setMemberRole } from '../discord.js';
import { getClips, getStream, getUserByLogin, subscribeEventSub } from '../twitchApi.js';

const log = childLogger('twitch');

/**
 * Manutenzione delle integrazioni Twitch.
 *
 * Tre compiti:
 *   • risolvere i login in ID numerici e creare le sottoscrizioni EventSub
 *     mancanti (gli avvisi live veri e propri arrivano poi all'API, non qui)
 *   • recuperare gli annunci persi mentre l'API era irraggiungibile
 *   • cercare i clip nuovi, che EventSub non copre
 */
export async function twitchProcessor(job: Job): Promise<void> {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return;

  // Gli avvisi live arrivano all'API via EventSub, che li accoda qui: l'API
  // deve rispondere a Twitch entro pochi secondi e non può fermarsi a comporre
  // e inviare l'annuncio.
  await drainAnnouncements();

  const prisma = getPrisma();
  const guilds = await prisma.guild.findMany({ where: { active: true } });

  for (const guild of guilds) {
    const parsed = GuildConfigSchema.safeParse(guild.config);
    if (!parsed.success) continue;
    const twitch = parsed.data.integrations.twitch;
    if (!twitch.enabled || twitch.streamers.length === 0) continue;

    for (const streamer of twitch.streamers) {
      // Voce sospesa: resta configurata ma non produce annunci.
      if (!streamer.enabled) continue;

      await syncStreamer(guild.id, streamer).catch((error) =>
        log.warn({ err: error, login: streamer.login }, 'sincronizzazione streamer fallita'),
      );

      // L'intervallo dei clip è configurabile per server: il job gira ogni 15
      // minuti, ma chi ha impostato un'ora viene servito ogni ora. Senza questo
      // controllo l'opzione sarebbe decorativa.
      if (job.name === 'clips' && streamer.clipMinViews > 0) {
        const due = await clipCheckDue(guild.id, streamer.login, twitch.clipPollMinutes);
        if (due) await checkClips(guild.id, streamer).catch(() => undefined);
      }
    }
  }
}

type StreamerConfig = ReturnType<typeof GuildConfigSchema.parse>['integrations']['twitch']['streamers'][number];

/**
 * Svuota la coda degli annunci lasciata dall'API.
 *
 * Lo stato della diretta viene riletto da Twitch invece di fidarsi del solo
 * evento: titolo, gioco e spettatori servono per l'embed e nell'evento
 * `stream.online` non ci sono.
 */
async function drainAnnouncements(): Promise<void> {
  const redis = getRedis();
  const prisma = getPrisma();

  for (let i = 0; i < 25; i++) {
    const raw = await redis.rpop('twitch:announce');
    if (!raw) break;

    // `fine` distingue la fine della diretta dall'inizio: passano dalla stessa
    // coda perché sono lo stesso streamer nello stesso ordine, e due code
    // separate potrebbero consegnare il «finita» prima del «cominciata».
    let payload: { guildId: string; login: string; userId: string; fine?: boolean };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      continue;
    }

    const guild = await prisma.guild.findUnique({ where: { id: payload.guildId } });
    if (!guild) continue;

    const parsed = GuildConfigSchema.safeParse(guild.config);
    if (!parsed.success) continue;

    const streamer = parsed.data.integrations.twitch.streamers.find(
      (entry) => entry.login.toLowerCase() === payload.login.toLowerCase(),
    );
    if (!streamer || !streamer.enabled) continue;

    if (payload.fine) {
      await segnaFineDiretta(payload.guildId, streamer);
      continue;
    }

    const stream = await getStream(payload.userId);
    await announceLive(payload.guildId, streamer, {
      title: stream?.title ?? 'In diretta',
      game: stream?.game_name ?? '',
      viewers: stream?.viewer_count ?? 0,
      thumbnail:
        stream?.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') ??
        `https://static-cdn.jtvnw.net/previews-ttv/live_user_${payload.login}-1280x720.jpg`,
    });
  }
}

async function syncStreamer(guildId: string, streamer: StreamerConfig): Promise<void> {
  const prisma = getPrisma();

  const existing = await prisma.twitchSubscription.findFirst({
    where: { guildId, twitchLogin: streamer.login.toLowerCase(), eventsubType: 'stream.online' },
  });

  let userId = existing?.twitchUserId ?? streamer.userId;
  if (!userId) {
    const user = await getUserByLogin(streamer.login);
    if (!user) return;
    userId = user.id;
  }

  const publicUrl = process.env.PUBLIC_URL;
  const callbackUrl = publicUrl ? `${publicUrl}/api/webhooks/twitch` : null;

  if (!existing) {
    // La sottoscrizione EventSub si crea solo se il pannello è raggiungibile
    // dall'esterno: Twitch deve poter chiamare il callback. In locale, senza
    // dominio pubblico, resta attivo il solo polling dei clip.
    const eventsubId =
      callbackUrl && callbackUrl.startsWith('https://')
        ? await subscribeEventSub('stream.online', userId, callbackUrl)
        : null;

    await prisma.twitchSubscription.create({
      data: {
        guildId,
        twitchUserId: userId,
        twitchLogin: streamer.login.toLowerCase(),
        eventsubId,
        announceChannelId: streamer.announceChannelId,
        liveRoleId: streamer.liveRoleId,
      },
    });

    if (!eventsubId) {
      log.info(
        { login: streamer.login },
        'EventSub non attivabile (serve un URL pubblico HTTPS): si userà il controllo periodico',
      );
    }

    await sottoscriviFineDiretta(guildId, streamer, userId, callbackUrl);
    return;
  }

  // Anche per una sottoscrizione già esistente: il ruolo «in diretta» può
  // essere stato configurato dopo, e in quel caso la fine della diretta non
  // arriverebbe mai — il ruolo resterebbe addosso per sempre.
  await sottoscriviFineDiretta(guildId, streamer, userId, callbackUrl);

  // Senza EventSub attivo si verifica lo stato con il polling: meno tempestivo,
  // ma meglio di nessun avviso.
  if (!existing.eventsubId) {
    const stream = await getStream(userId);

    if (!stream) {
      // Transizione a offline: senza EventSub nessuno la annuncia, e il ruolo
      // «in diretta» resterebbe addosso finché qualcuno non lo toglie a mano.
      if (existing.lastLiveAt) {
        await segnaFineDiretta(guildId, streamer);
        await prisma.twitchSubscription.update({
          where: { id: existing.id },
          data: { lastLiveAt: null },
        });
      }
      return;
    }

    const recentlyAnnounced =
      existing.lastAnnouncedAt &&
      Date.now() - existing.lastAnnouncedAt.getTime() < streamer.cooldownMinutes * 60_000;
    if (recentlyAnnounced) return;

    await announceLive(guildId, streamer, {
      title: stream.title,
      game: stream.game_name,
      viewers: stream.viewer_count,
      thumbnail: stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720'),
    });

    await prisma.twitchSubscription.update({
      where: { id: existing.id },
      data: { lastLiveAt: new Date(), lastAnnouncedAt: new Date() },
    });
  }
}

/**
 * Sottoscrive `stream.offline`, ma solo per chi ha un ruolo da restituire.
 *
 * Twitch limita il numero di sottoscrizioni: chiederne una per ogni streamer
 * seguito, quando alla fine della diretta non deve succedere nulla, consumerebbe
 * quota per un evento che verrebbe scartato all'arrivo.
 */
async function sottoscriviFineDiretta(
  guildId: string,
  streamer: StreamerConfig,
  userId: string,
  callbackUrl: string | null,
): Promise<void> {
  if (!streamer.liveRoleId || !streamer.discordUserId) return;
  if (!callbackUrl?.startsWith('https://')) return;

  const prisma = getPrisma();
  const gia = await prisma.twitchSubscription.findFirst({
    where: { guildId, twitchUserId: userId, eventsubType: 'stream.offline' },
  });
  if (gia) return;

  const eventsubId = await subscribeEventSub('stream.offline', userId, callbackUrl);
  await prisma.twitchSubscription.create({
    data: {
      guildId,
      twitchUserId: userId,
      twitchLogin: streamer.login.toLowerCase(),
      eventsubId,
      eventsubType: 'stream.offline',
      liveRoleId: streamer.liveRoleId,
    },
  });
}

/**
 * Dà o toglie allo streamer il ruolo «in diretta».
 *
 * Il collegamento fra il canale Twitch e la persona su Discord lo fa la
 * configurazione: senza `discordUserId` il bot non ha modo di sapere chi sia
 * quello streamer nel server, e il ruolo resterebbe una decorazione.
 *
 * Il ruolo si dà comunque, anche quando l'annuncio non parte perché manca il
 * canale o perché è scattato il cooldown: sono due cose diverse, e chi ha
 * impostato il ruolo lo vuole addosso finché la diretta è accesa.
 */
async function ruoloDiretta(
  guildId: string,
  streamer: StreamerConfig,
  inDiretta: boolean,
): Promise<void> {
  if (!streamer.liveRoleId || !streamer.discordUserId) return;

  await setMemberRole(
    guildId,
    streamer.discordUserId,
    streamer.liveRoleId,
    inDiretta,
    inDiretta ? `Diretta Twitch di ${streamer.login}` : `Fine diretta Twitch di ${streamer.login}`,
  );
}

/** Fine della diretta: il ruolo va tolto, e resta traccia nel registro. */
export async function segnaFineDiretta(
  guildId: string,
  streamer: StreamerConfig,
): Promise<void> {
  if (!streamer.liveRoleId || !streamer.discordUserId) return;

  await ruoloDiretta(guildId, streamer, false);
  await recordWorkerEvent({
    guildId,
    type: 'INTEGRATION_ANNOUNCEMENT',
    targetId: streamer.discordUserId,
    summary: `Fine diretta di **${streamer.login}**: ruolo <@&${streamer.liveRoleId}> rimosso`,
    payload: { platform: 'twitch', login: streamer.login, live: false },
  });
}

export async function announceLive(
  guildId: string,
  streamer: StreamerConfig,
  info: { title: string; game: string; viewers: number; thumbnail: string },
): Promise<void> {
  await ruoloDiretta(guildId, streamer, true);

  const channelId = streamer.announceChannelId;
  if (!channelId) return;

  const url = `https://twitch.tv/${streamer.login}`;
  const content = streamer.template
    .replaceAll('{streamer}', streamer.login)
    .replaceAll('{title}', info.title)
    .replaceAll('{game}', info.game)
    .replaceAll('{url}', url)
    .replaceAll('{viewers}', String(info.viewers));

  await sendMessage(channelId, {
    content: streamer.mentionRoleId ? `<@&${streamer.mentionRoleId}> ${content}` : content,
    embeds: [
      {
        title: info.title.slice(0, 256),
        url,
        description: info.game ? `🎮 ${info.game}` : undefined,
        color: 0x9146ff,
        image: { url: `${info.thumbnail}?t=${Date.now()}` },
        footer: { text: `twitch.tv/${streamer.login}` },
      },
    ],
    allowed_mentions: streamer.mentionRoleId ? { roles: [streamer.mentionRoleId] } : { parse: [] },
  });

  await recordWorkerEvent({
    guildId,
    type: 'INTEGRATION_ANNOUNCEMENT',
    channelId,
    summary: `Annuncio live Twitch di **${streamer.login}**`,
    payload: { platform: 'twitch', login: streamer.login, game: info.game },
  });
}

/**
 * Vero solo quando l'intervallo configurato è trascorso.
 *
 * La chiave con scadenza fa da promemoria: finché esiste, il controllo non è
 * dovuto. Nessuna colonna aggiuntiva nel database per un dato che si può
 * perdere senza conseguenze.
 */
async function clipCheckDue(
  guildId: string,
  login: string,
  intervalMinutes: number,
): Promise<boolean> {
  const key = `twitch:clips:${guildId}:${login.toLowerCase()}`;
  const claimed = await getRedis().set(key, '1', 'EX', Math.max(60, intervalMinutes * 60), 'NX');
  return claimed !== null;
}

async function checkClips(guildId: string, streamer: StreamerConfig): Promise<void> {
  const prisma = getPrisma();
  const subscription = await prisma.twitchSubscription.findFirst({
    where: { guildId, twitchLogin: streamer.login.toLowerCase() },
  });
  if (!subscription) return;

  const channelId = streamer.clipChannelId ?? streamer.announceChannelId;
  if (!channelId) return;

  const since = subscription.lastClipCheckAt ?? new Date(Date.now() - 86_400_000);
  const clips = await getClips(subscription.twitchUserId, since);

  const worthy = clips
    .filter((clip) => clip.view_count >= streamer.clipMinViews)
    .filter((clip) => new Date(clip.created_at) > since);

  for (const clip of worthy.slice(0, 3)) {
    await sendMessage(channelId, {
      content: `🎬 Nuovo clip di **${streamer.login}**: ${clip.url}`,
      allowed_mentions: { parse: [] },
    });
  }

  await prisma.twitchSubscription.update({
    where: { id: subscription.id },
    data: { lastClipCheckAt: new Date() },
  });

  if (worthy.length > 0) {
    log.info({ login: streamer.login, clips: worthy.length }, 'clip pubblicati');
  }
}
