import type { Message } from 'discord.js';
import {
  capsRatio,
  contentFingerprint,
  decide,
  noDecision,
  RedisKeys,
  zalgoRatio,
  type Decision,
  type GuildConfig,
  type Reason,
} from '@angel/shared';
import { getRedis, slidingWindowCount } from '../core/redis.js';
import { isExempt } from '../core/permissions.js';

const INVITE_PATTERN = /(?:discord\.(?:gg|com\/invite)|discordapp\.com\/invite)\/([a-z0-9-]+)/gi;
const EMOJI_PATTERN = /<a?:\w+:\d+>|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/**
 * Anti-spam a punteggio.
 *
 * Nessun singolo segnale fa scattare una sanzione da solo: un messaggio tutto
 * maiuscolo è maleducazione, non spam. È la somma — ritmo elevato, contenuto
 * ripetuto, menzioni, link — che distingue lo spam dalla conversazione vivace.
 *
 * Chi è entrato da poco viene valutato con un moltiplicatore: la quasi totalità
 * dello spam arriva nella prima ora di permanenza, e alzare l'asticella lì
 * costa pochissimo agli utenti veri.
 */
export async function evaluateSpam(
  message: Message,
  config: GuildConfig,
): Promise<Decision> {
  const settings = config.security.antiSpam;
  if (!settings.enabled || !message.guild || message.author.bot) return noDecision('antiSpam');
  if (isExempt(message.member, settings.exemptions, message.channelId)) return noDecision('antiSpam');

  const reasons: Reason[] = [];
  const guildId = message.guild.id;
  const userId = message.author.id;
  const redis = getRedis();

  const joinedAt = message.member?.joinedTimestamp ?? 0;
  const isNewMember =
    settings.newMemberMinutes > 0 &&
    joinedAt > 0 &&
    Date.now() - joinedAt < settings.newMemberMinutes * 60_000;
  const multiplier = isNewMember ? settings.newMemberMultiplier : 1;

  /* ── Ritmo dei messaggi ─────────────────────────────────────────────── */
  const messageCount = await slidingWindowCount(
    RedisKeys.spamMessages(guildId, userId),
    settings.messageRate.windowSec * 1000,
    `${message.id}`,
  );
  if (messageCount > settings.messageRate.count) {
    reasons.push({
      code: 'SPAM_RATE',
      detail: `${messageCount} messaggi in ${settings.messageRate.windowSec}s`,
      score: Math.min(60, (messageCount - settings.messageRate.count) * 12) * multiplier,
      meta: { messageCount },
    });
  }

  /* ── Contenuto ripetuto ─────────────────────────────────────────────── */
  const content = message.content ?? '';
  if (content.trim().length >= 8) {
    const fingerprint = contentFingerprint(content);
    const key = RedisKeys.spamFingerprints(guildId, userId);
    const duplicates = await slidingWindowCount(
      `${key}:${fingerprint}`,
      settings.duplicateMessages.windowSec * 1000,
      message.id,
    );
    if (duplicates > settings.duplicateMessages.count) {
      reasons.push({
        code: 'SPAM_DUPLICATE',
        detail: `Stesso messaggio ripetuto ${duplicates} volte`,
        score: Math.min(55, duplicates * 15) * multiplier,
      });
    }

    // Stesso testo in canali diversi: firma inconfondibile dello scam bot,
    // che spara il link ovunque abbia accesso.
    const channelKey = `${key}:${fingerprint}:ch`;
    await redis.sadd(channelKey, message.channelId);
    await redis.expire(channelKey, settings.crossChannelSpam.windowSec);
    const channelCount = await redis.scard(channelKey);
    if (channelCount >= settings.crossChannelSpam.count) {
      reasons.push({
        code: 'SPAM_CROSS_CHANNEL',
        detail: `Stesso messaggio inviato in ${channelCount} canali diversi`,
        score: 60 * multiplier,
        meta: { channelCount },
      });
    }
  }

  /* ── Menzioni ───────────────────────────────────────────────────────── */
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount > settings.mentionsPerMessage) {
    reasons.push({
      code: 'SPAM_MENTIONS',
      detail: `${mentionCount} menzioni in un solo messaggio`,
      score: Math.min(70, (mentionCount - settings.mentionsPerMessage) * 15) * multiplier,
    });
  }
  if (mentionCount > 0) {
    const total = await slidingWindowCount(
      RedisKeys.spamMentions(guildId, userId),
      settings.mentionRate.windowSec * 1000,
      `${message.id}:${mentionCount}`,
    );
    if (total > settings.mentionRate.count) {
      reasons.push({
        code: 'SPAM_MENTION_RATE',
        detail: `Menzioni ripetute: ${total} messaggi con menzioni in ${settings.mentionRate.windowSec}s`,
        score: 40 * multiplier,
      });
    }
  }

  if (settings.blockEveryoneAbuse && message.mentions.everyone) {
    reasons.push({
      code: 'SPAM_EVERYONE',
      detail: 'Uso di @everyone/@here senza autorizzazione',
      score: 50 * multiplier,
    });
  }

  /* ── Forma del messaggio ────────────────────────────────────────────── */
  const emojiCount = (content.match(EMOJI_PATTERN) ?? []).length;
  if (emojiCount > settings.maxEmojisPerMessage) {
    reasons.push({
      code: 'SPAM_EMOJI_WALL',
      detail: `${emojiCount} emoji in un messaggio`,
      score: 25 * multiplier,
    });
  }

  const lineCount = content.split('\n').length;
  if (lineCount > settings.maxLinesPerMessage) {
    reasons.push({
      code: 'SPAM_WALL',
      detail: `Messaggio di ${lineCount} righe`,
      score: 20 * multiplier,
    });
  }

  if (content.length >= settings.capsMinLength) {
    const caps = capsRatio(content) * 100;
    if (caps >= settings.capsPercent) {
      reasons.push({
        code: 'SPAM_CAPS',
        detail: `${Math.round(caps)}% di maiuscole`,
        score: 15 * multiplier,
      });
    }
  }

  if (settings.blockZalgo && zalgoRatio(content) > 0.25) {
    reasons.push({
      code: 'SPAM_ZALGO',
      detail: 'Testo zalgo (caratteri combinanti accumulati)',
      score: 30 * multiplier,
    });
  }

  /* ── Inviti ─────────────────────────────────────────────────────────── */
  if (settings.blockInvites) {
    INVITE_PATTERN.lastIndex = 0;
    const invites = [...content.matchAll(INVITE_PATTERN)];
    if (invites.length > 0) {
      reasons.push({
        code: 'SPAM_INVITE',
        detail: `Invito Discord nel messaggio: ${invites.map((m) => m[1]).join(', ')}`,
        score: 35 * multiplier,
        meta: { codes: invites.map((m) => m[1]) },
      });
    }
  }

  if (reasons.length === 0) return noDecision('antiSpam');
  return decide('antiSpam', reasons, settings.ladder, 'SECURITY_SCAM_BLOCKED');
}
