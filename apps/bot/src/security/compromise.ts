import type { Client, Message } from 'discord.js';
import { getPrisma } from '@angel/db';
import {
  contentFingerprint,
  normalize,
  noDecision,
  RedisKeys,
  type Decision,
  type GuildConfig,
  type Reason,
} from '@angel/shared';
import { getRedis } from '../core/redis.js';
import { isExempt } from '../core/permissions.js';
import { recordEvent } from '../logging/auditLogger.js';
import { purgeRecent, quarantineMember } from '../core/enforcer.js';
import { t } from '../core/i18n.js';

/* ═══════════════════════════════════════════════════════════════════════
   RILEVAMENTO ACCOUNT COMPROMESSI

   L'ondata "MrBeast" non arriva da account nuovi: arriva da account veri, con
   anni di storia nel server, il cui token è stato rubato da un infostealer.
   RaidProtect ha contato decine di migliaia di account colpiti nel 2026, con il
   numero raddoppiato in un mese e oltre 2,3 milioni di immagini rimosse.

   Nessun controllo sull'ingresso può fermarli, perché sono già dentro e sono
   legittimi. L'unico segnale disponibile è il *cambio di comportamento*: chi
   taceva da settimane pubblica di colpo lo stesso messaggio con link e
   immagine in cinque canali diversi.

   Da qui la scelta di tenere una baseline per utente e di reagire alla
   discontinuità, non al contenuto in sé.
   ═══════════════════════════════════════════════════════════════════════ */

export interface CompromiseContext {
  hasUrl: boolean;
  hasImage: boolean;
  hasQrCode: boolean;
  /** Numero di canali diversi in cui è comparso lo stesso testo di recente. */
  crossChannelCount: number;
}

export async function evaluateCompromise(
  client: Client,
  message: Message,
  config: GuildConfig,
  context: CompromiseContext,
): Promise<Decision> {
  const settings = config.security.compromise;
  if (!settings.enabled || !message.guild || message.author.bot) {
    return noDecision('compromise');
  }
  if (isExempt(message.member, settings.exemptions, message.channelId)) {
    return noDecision('compromise');
  }
  // Nessun contenuto sospetto: non c'è nulla su cui indagare.
  if (!context.hasUrl && !context.hasImage && !context.hasQrCode) {
    return noDecision('compromise');
  }

  const reasons: Reason[] = [];
  const prisma = getPrisma();
  const guildId = message.guild.id;
  const userId = message.author.id;

  const profile = await prisma.userProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });

  /* ── Silenzio prolungato seguito da link ───────────────────────────── */
  if (profile?.lastMessageAt) {
    const dormantDays = (Date.now() - profile.lastMessageAt.getTime()) / 86_400_000;
    if (dormantDays >= settings.dormantDays && context.hasUrl) {
      reasons.push({
        code: 'CMP_DORMANT_LINK',
        detail:
          `Utente inattivo da ${Math.round(dormantDays)} giorni che riprende a scrivere ` +
          'pubblicando un link',
        score: settings.signals.dormantThenLink,
        meta: { dormantDays: Math.round(dormantDays) },
      });
    }
  } else if (context.hasUrl && (profile?.messageCount ?? 0) === 0) {
    reasons.push({
      code: 'CMP_FIRST_MESSAGE_LINK',
      detail: 'Il primo messaggio in assoluto dell\'utente contiene un link',
      score: settings.signals.firstMessageIsLink,
    });
  }

  /* ── Stesso messaggio in molti canali ──────────────────────────────── */
  if (context.crossChannelCount >= 3) {
    reasons.push({
      code: 'CMP_BROADCAST',
      detail: `Stesso messaggio pubblicato in ${context.crossChannelCount} canali`,
      score: settings.signals.sameMessageManyChannels,
      meta: { channels: context.crossChannelCount },
    });
  }

  /* ── Immagine con link ─────────────────────────────────────────────── */
  if (context.hasImage && context.hasUrl) {
    reasons.push({
      code: 'CMP_IMAGE_LINK',
      detail: 'Immagine accompagnata da un link: schema tipico delle campagne giveaway fasulle',
      score: settings.signals.imageWithUrl,
    });
  }

  if (context.hasQrCode) {
    reasons.push({
      code: 'CMP_QR',
      detail: 'Il messaggio contiene un codice QR',
      score: settings.signals.containsQrCode,
    });
  }

  /* ── Parole chiave delle campagne ──────────────────────────────────── */
  const haystack = normalize(message.content ?? '');
  const matched = settings.scamKeywords.filter((word) => haystack.includes(normalize(word)));
  if (matched.length > 0) {
    reasons.push({
      code: 'CMP_KEYWORDS',
      detail: `Parole chiave delle campagne in corso: ${matched.join(', ')}`,
      score: settings.signals.knownScamKeywords,
      meta: { keywords: matched },
    });
  }

  if (message.mentions.everyone && context.hasUrl) {
    reasons.push({
      code: 'CMP_EVERYONE_LINK',
      detail: '@everyone insieme a un link',
      score: settings.signals.mentionsEveryoneWithLink,
    });
  }

  if (reasons.length === 0) return noDecision('compromise');

  const score = Math.min(
    100,
    reasons.reduce((total, reason) => total + reason.score, 0),
  );

  if (score < settings.quarantineAtScore) {
    return {
      module: 'compromise',
      triggered: true,
      score,
      reasons,
      actions: [{ kind: 'DELETE_MESSAGE', reason: 'Contenuto sospetto da account forse compromesso' }],
      logEvent: 'SECURITY_COMPROMISE_SUSPECTED',
    };
  }

  /* ── Sopra soglia: quarantena, pulizia, avviso ─────────────────────── */

  await recordEvent(client, {
    guildId,
    type: 'SECURITY_COMPROMISE_SUSPECTED',
    actorId: userId,
    actorTag: message.author.tag,
    channelId: message.channelId,
    messageId: message.id,
    severity: score,
    automated: true,
    summary:
      `🕵️ **Sospetto account compromesso**: <@${userId}>\n` +
      reasons.map((reason) => `• ${reason.detail}`).join('\n') +
      '\n\nL\'account viene isolato e i messaggi recenti rimossi. ' +
      'Se è un falso positivo, la quarantena si revoca dal pannello con un clic.',
    payload: { score, reasons },
  });

  if (!config.general.dryRun && message.member) {
    await quarantineMember(
      {
        client,
        guild: message.guild,
        config,
        member: message.member,
        message,
        module: 'compromise',
      },
      'Sospetto furto dell\'account: attività anomala con link o immagini',
    ).catch(() => undefined);

    if (settings.purgeHours > 0) {
      purgeRecent(message.guild, userId, settings.purgeHours);
    }

    if (settings.notifyUser) {
      // L'avviso serve alla persona, non al server: chi ha subito il furto
      // spesso non se ne accorge finché qualcuno non glielo dice.
      await message.author
        .send(
          t(config.general.locale, 'security.compromiseWarning', { guild: message.guild.name }),
        )
        .catch(() => undefined);
    }
  }

  return {
    module: 'compromise',
    triggered: true,
    score,
    reasons,
    actions: [{ kind: 'DELETE_MESSAGE', reason: 'Account probabilmente compromesso' }],
    logEvent: 'SECURITY_COMPROMISE_SUSPECTED',
  };
}

/**
 * Aggiorna la baseline dell'utente e conta in quanti canali diversi è comparso
 * lo stesso testo. Va chiamata per ogni messaggio: è ciò che rende possibile il
 * confronto con il comportamento abituale.
 */
export async function trackActivity(
  message: Message,
): Promise<{ crossChannelCount: number }> {
  if (!message.guild || message.author.bot) return { crossChannelCount: 0 };

  const guildId = message.guild.id;
  const userId = message.author.id;
  const redis = getRedis();

  // Scrittura leggera su Redis a ogni messaggio; il consolidamento su Postgres
  // avviene nel worker, così il percorso critico resta veloce.
  await redis.set(RedisKeys.lastSeen(guildId, userId), Date.now().toString(), 'EX', 86400 * 60);

  let crossChannelCount = 0;
  const content = message.content ?? '';
  if (content.trim().length >= 12) {
    const key = `cmp:fp:${guildId}:${userId}:${contentFingerprint(content)}`;
    await redis.sadd(key, message.channelId);
    await redis.expire(key, 300);
    crossChannelCount = await redis.scard(key);
  }

  return { crossChannelCount };
}
