import type { Client, Guild, Message } from 'discord.js';
import { getPrisma } from '@angel/db';
import { noDecision, type Decision, type GuildConfig, type Reason } from '@angel/shared';
import { isExempt } from '../core/permissions.js';
import { recordEvent } from '../logging/auditLogger.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('inviteGuard');

/* ═══════════════════════════════════════════════════════════════════════
   PROTEZIONE INVITI

   Discord permette di rivendicare come vanity un codice invito *scaduto o
   eliminato*, e normalizza i codici in minuscolo. Un attaccante può quindi
   registrare in anticipo codici noti e prendersi il traffico nel momento in cui
   il link originale smette di funzionare — oppure quando un server perde il
   livello di boost e libera il proprio vanity.

   Non è teoria: la campagna documentata nel 2025 ha usato esattamente questo
   meccanismo per consegnare AsyncRAT e Skuld Stealer ad almeno 1300 persone fra
   Stati Uniti, Regno Unito, Francia, Paesi Bassi e Germania. Chi cliccava
   seguiva un link pubblicato mesi prima su un forum, in perfetta buona fede.

   Due difese:
     • ogni invito pubblicato in chat viene risolto e mostrato per quello che è
     • i propri codici vengono sorvegliati, e se uno si libera si viene avvisati
   ═══════════════════════════════════════════════════════════════════════ */

const INVITE_PATTERN = /(?:discord\.(?:gg|com\/invite)|discordapp\.com\/invite)\/([a-zA-Z0-9-]+)/gi;

export async function evaluateInvites(
  client: Client,
  message: Message,
  config: GuildConfig,
): Promise<Decision> {
  const settings = config.security.inviteGuard;
  if (!settings.enabled || !message.guild || message.author.bot) return noDecision('inviteGuard');
  if (isExempt(message.member, settings.exemptions, message.channelId)) {
    return noDecision('inviteGuard');
  }

  INVITE_PATTERN.lastIndex = 0;
  const codes = [...(message.content ?? '').matchAll(INVITE_PATTERN)].map((match) => match[1]!);
  if (codes.length === 0) return noDecision('inviteGuard');

  const reasons: Reason[] = [];
  let shouldBlock = false;

  for (const code of codes) {
    const invite = settings.resolvePostedInvites
      ? await client.fetchInvite(code).catch(() => null)
      : null;

    if (!invite) {
      // Un codice che non si risolve è appena stato eliminato o non è mai
      // esistito: vale la pena segnalarlo, non punirlo.
      reasons.push({
        code: 'INV_UNRESOLVED',
        detail: `Invito non risolvibile: \`${code}\` (scaduto, eliminato o mai esistito)`,
        score: 10,
        meta: { code },
      });
      continue;
    }

    const targetGuildId = invite.guild?.id;
    const isOwnGuild = targetGuildId === message.guild.id;

    if (isOwnGuild && settings.allowOwnGuild) continue;
    if (targetGuildId && settings.allowedGuildIds.includes(targetGuildId)) continue;

    const guildAgeDays = invite.guild?.createdTimestamp
      ? Math.round((Date.now() - invite.guild.createdTimestamp) / 86_400_000)
      : null;

    const detail =
      `Invito verso **${invite.guild?.name ?? 'server sconosciuto'}**` +
      (guildAgeDays !== null ? ` (creato ${guildAgeDays} giorni fa` : '') +
      (invite.memberCount ? `, ${invite.memberCount} membri)` : guildAgeDays !== null ? ')' : '');

    if (settings.blockUnknownInvites) {
      shouldBlock = true;
      reasons.push({
        code: 'INV_UNKNOWN_GUILD',
        detail: `${detail} — non presente in allowlist`,
        // Un server creato da pochissimo e con un invito che circola è il
        // profilo tipico del server-esca.
        score: guildAgeDays !== null && guildAgeDays < 7 ? 60 : 35,
        meta: { code, targetGuildId, guildAgeDays, memberCount: invite.memberCount },
      });
    } else {
      reasons.push({
        code: 'INV_POSTED',
        detail,
        score: 5,
        meta: { code, targetGuildId },
      });
    }
  }

  if (reasons.length === 0) return noDecision('inviteGuard');

  const score = Math.min(
    100,
    reasons.reduce((total, reason) => total + reason.score, 0),
  );

  return {
    module: 'inviteGuard',
    triggered: true,
    score,
    reasons,
    actions: shouldBlock
      ? [{ kind: settings.action, reason: 'Invito verso un server non autorizzato' }]
      : [{ kind: 'LOG_ONLY', reason: 'Invito pubblicato' }],
    logEvent: shouldBlock ? 'INVITE_BLOCKED' : 'INVITE_POSTED',
  };
}

/**
 * Sincronizza l'elenco degli inviti del server.
 *
 * Serve a due cose: attribuire ogni ingresso all'invito usato (confrontando i
 * contatori prima e dopo) e accorgersi quando un codice sorvegliato sparisce.
 */
export async function syncInvites(guild: Guild): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return counts;

  const prisma = getPrisma();
  for (const invite of invites.values()) {
    counts.set(invite.code, invite.uses ?? 0);
    await prisma.inviteRecord
      .upsert({
        where: { code: invite.code },
        create: {
          code: invite.code,
          guildId: guild.id,
          channelId: invite.channelId ?? null,
          inviterId: invite.inviterId ?? null,
          uses: invite.uses ?? 0,
          maxUses: invite.maxUses ?? 0,
          temporary: invite.temporary ?? false,
          expiresAt: invite.expiresAt ?? null,
        },
        update: {
          uses: invite.uses ?? 0,
          expiresAt: invite.expiresAt ?? null,
          deletedAt: null,
        },
      })
      .catch(() => undefined);
  }
  return counts;
}

/**
 * Controlla i codici sorvegliati.
 *
 * Se un codice non appartiene più al server, il link continua a esistere in
 * rete ma può essere rivendicato da chiunque: chi lo clicca finisce altrove.
 * È il momento in cui bisogna sostituirlo ovunque sia stato pubblicato.
 */
export async function checkWatchedInvites(
  client: Client,
  guild: Guild,
  config: GuildConfig,
): Promise<void> {
  const settings = config.security.inviteGuard;
  if (!settings.enabled || !settings.watchOwnVanity) return;

  const prisma = getPrisma();
  const watched = new Set(settings.watchedCodes);

  if (guild.vanityURLCode) watched.add(guild.vanityURLCode);

  for (const code of watched) {
    const invite = await client.fetchInvite(code).catch(() => null);
    const stillOurs = invite?.guild?.id === guild.id;

    if (stillOurs) {
      await prisma.inviteRecord
        .updateMany({ where: { code }, data: { watched: true, atRisk: false } })
        .catch(() => undefined);
      continue;
    }

    const previous = await prisma.inviteRecord.findUnique({ where: { code } });
    if (previous?.atRisk) continue; // già segnalato

    await prisma.inviteRecord
      .upsert({
        where: { code },
        create: { code, guildId: guild.id, watched: true, atRisk: true },
        update: { atRisk: true, watched: true },
      })
      .catch(() => undefined);

    log.warn({ guildId: guild.id, code }, 'codice invito sorvegliato non più valido');

    await recordEvent(client, {
      guildId: guild.id,
      type: 'VANITY_AT_RISK',
      severity: 85,
      automated: true,
      summary:
        `🚨 Il codice invito \`${code}\` **non appartiene più a questo server**` +
        (invite?.guild?.name ? ` (ora punta a "${invite.guild.name}")` : ' (attualmente libero)') +
        '.\n\nI codici liberati possono essere rivendicati da chiunque come vanity: chi apre il ' +
        'vecchio link finisce su un server altrui. Sostituisci il link ovunque sia stato ' +
        'pubblicato (sito, social, forum) e, se possibile, rivendica di nuovo il codice.',
      payload: { code, nowPointsTo: invite?.guild?.id ?? null },
    });
  }
}
