import {
  AuditLogEvent,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import type { GuildConfig } from '@aegis/shared';
import { recordEvent } from '../logging/auditLogger.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('botGuard');

/* ═══════════════════════════════════════════════════════════════════════
   CONTROLLO DEI BOT

   Nel 2026 gli incidenti legati ai bot di terze parti sono fra le prime cause
   di compromissione dei server. Il punto non è la malafede dello sviluppatore:
   basta una dipendenza npm avvelenata o il furto delle sue credenziali, e il
   bot che tutti hanno invitato diventa lo strumento dell'attacco — su ogni
   server dove è presente, contemporaneamente.

   Un bot con Administrator equivale al server compromesso. Meno ovvi, ma
   altrettanto pesanti, sono `ManageWebhooks` (permette messaggi falsi
   dall'aspetto ufficiale) e `ReadMessageHistory` (permette di rastrellare
   l'intero archivio delle conversazioni).
   ═══════════════════════════════════════════════════════════════════════ */

/** Peso di rischio dei singoli permessi. */
const PERMISSION_RISK: { flag: bigint; name: string; score: number; why: string }[] = [
  {
    flag: PermissionFlagsBits.Administrator,
    name: 'Administrator',
    score: 100,
    why: 'controllo totale del server: se il bot viene compromesso, il server lo è con lui',
  },
  {
    flag: PermissionFlagsBits.ManageGuild,
    name: 'ManageGuild',
    score: 40,
    why: 'può modificare le impostazioni del server e gli inviti',
  },
  {
    flag: PermissionFlagsBits.ManageRoles,
    name: 'ManageRoles',
    score: 40,
    why: 'può assegnare ruoli, compresi quelli con permessi',
  },
  {
    flag: PermissionFlagsBits.ManageChannels,
    name: 'ManageChannels',
    score: 35,
    why: 'può creare ed eliminare canali',
  },
  {
    flag: PermissionFlagsBits.ManageWebhooks,
    name: 'ManageWebhooks',
    score: 35,
    why: 'può creare webhook e pubblicare messaggi dall\'aspetto ufficiale',
  },
  {
    flag: PermissionFlagsBits.BanMembers,
    name: 'BanMembers',
    score: 30,
    why: 'può bandire in massa',
  },
  {
    flag: PermissionFlagsBits.KickMembers,
    name: 'KickMembers',
    score: 20,
    why: 'può espellere membri',
  },
  {
    flag: PermissionFlagsBits.MentionEveryone,
    name: 'MentionEveryone',
    score: 15,
    why: 'può menzionare tutti: amplifica qualsiasi messaggio malevolo',
  },
  {
    flag: PermissionFlagsBits.ReadMessageHistory,
    name: 'ReadMessageHistory',
    score: 15,
    why: 'può leggere e raccogliere lo storico delle conversazioni',
  },
  {
    flag: PermissionFlagsBits.ManageMessages,
    name: 'ManageMessages',
    score: 15,
    why: 'può eliminare messaggi altrui, comprese le prove',
  },
];

export function scoreBotPermissions(permissions: PermissionsBitField): {
  score: number;
  flags: string[];
  details: string[];
} {
  const flags: string[] = [];
  const details: string[] = [];
  let score = 0;

  for (const entry of PERMISSION_RISK) {
    if (!permissions.has(entry.flag)) continue;
    flags.push(entry.name);
    details.push(`\`${entry.name}\` — ${entry.why}`);
    score = Math.max(score, entry.score) + Math.min(entry.score, 10);
  }

  return { score: Math.min(100, score), flags, details };
}

/** Chiamata quando un bot entra nel server. */
export async function onBotJoin(
  client: Client,
  member: GuildMember,
  config: GuildConfig,
): Promise<void> {
  const settings = config.security.botGuard;
  if (!settings.enabled || !member.user.bot) return;

  const guild = member.guild;
  const risk = scoreBotPermissions(member.permissions);

  // Chi ha aggiunto il bot si legge solo dal registro di controllo.
  let inviterId: string | null = null;
  const audit = await guild
    .fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 })
    .catch(() => null);
  const entry = audit?.entries.find((log) => log.targetId === member.id);
  inviterId = entry?.executorId ?? null;

  const prisma = getPrisma();
  await prisma.botRecord
    .upsert({
      where: { id: member.id },
      create: {
        id: member.id,
        guildId: guild.id,
        name: member.user.username,
        addedBy: inviterId,
        permissions: member.permissions.bitfield.toString(),
        riskScore: risk.score,
        riskFlags: risk.flags,
        approved: settings.allowedBotIds.includes(member.id),
        lastAuditAt: new Date(),
      },
      update: {
        name: member.user.username,
        addedBy: inviterId,
        permissions: member.permissions.bitfield.toString(),
        riskScore: risk.score,
        riskFlags: risk.flags,
        removedAt: null,
        lastAuditAt: new Date(),
      },
    })
    .catch(() => undefined);

  const approvedBot = settings.allowedBotIds.includes(member.id);
  const approvedInviter =
    settings.allowedInviterIds.length === 0 ||
    (inviterId !== null && settings.allowedInviterIds.includes(inviterId));

  if (settings.alertOnBotJoin) {
    await recordEvent(client, {
      guildId: guild.id,
      type: 'BOT_JOINED',
      actorId: inviterId,
      targetId: member.id,
      targetTag: member.user.tag,
      severity: risk.score >= 60 ? 75 : 30,
      summary:
        `🤖 Bot aggiunto: **${member.user.tag}**` +
        (inviterId ? ` da <@${inviterId}>` : '') +
        `\nRischio permessi: **${risk.score}/100**` +
        (risk.details.length ? `\n${risk.details.join('\n')}` : ''),
      payload: { riskScore: risk.score, flags: risk.flags, inviterId },
    });
  }

  if (config.general.dryRun) return;

  if (!approvedInviter) {
    await member
      .kick('Bot aggiunto da un utente non autorizzato (Bot Guard)')
      .catch((error) => log.warn({ err: error }, 'espulsione bot fallita'));
    return;
  }

  if (settings.blockAdministrator && !approvedBot && member.permissions.has(PermissionFlagsBits.Administrator)) {
    const adminRoles = member.roles.cache.filter(
      (role) => role.permissions.has(PermissionFlagsBits.Administrator) && !role.managed,
    );

    if (adminRoles.size > 0) {
      await member.roles
        .remove([...adminRoles.keys()], 'Bot Guard: Administrator non consentito ai bot')
        .catch(() => undefined);
    }

    await recordEvent(client, {
      guildId: guild.id,
      type: 'BOT_PERMISSION_RISK',
      targetId: member.id,
      targetTag: member.user.tag,
      severity: 90,
      automated: true,
      summary:
        `⚠️ Al bot **${member.user.tag}** è stato rimosso il permesso Administrator.\n` +
        'Un bot con Administrator rende il server compromettibile attraverso la catena di ' +
        'fornitura del bot stesso: una dipendenza avvelenata o il furto delle credenziali dello ' +
        'sviluppatore basterebbero. Assegna solo i permessi che gli servono davvero.' +
        (adminRoles.size === 0
          ? '\n\n⚠️ Il permesso proviene da un ruolo gestito da un\'integrazione: va rimosso a mano.'
          : ''),
      payload: { removedRoles: [...adminRoles.keys()] },
    });
  }
}

/** Revisione periodica: i permessi possono cambiare dopo l'ingresso. */
export async function auditBots(
  client: Client,
  guild: Guild,
  config: GuildConfig,
): Promise<{ checked: number; risky: number }> {
  const settings = config.security.botGuard;
  if (!settings.enabled) return { checked: 0, risky: 0 };

  const members = await guild.members.fetch().catch(() => null);
  if (!members) return { checked: 0, risky: 0 };

  const bots = members.filter((member) => member.user.bot);
  const prisma = getPrisma();
  let risky = 0;

  for (const bot of bots.values()) {
    const risk = scoreBotPermissions(bot.permissions);
    if (risk.score >= 60) risky++;

    const previous = await prisma.botRecord.findUnique({ where: { id: bot.id } });

    await prisma.botRecord
      .upsert({
        where: { id: bot.id },
        create: {
          id: bot.id,
          guildId: guild.id,
          name: bot.user.username,
          permissions: bot.permissions.bitfield.toString(),
          riskScore: risk.score,
          riskFlags: risk.flags,
          approved: settings.allowedBotIds.includes(bot.id),
          lastAuditAt: new Date(),
        },
        update: {
          name: bot.user.username,
          permissions: bot.permissions.bitfield.toString(),
          riskScore: risk.score,
          riskFlags: risk.flags,
          lastAuditAt: new Date(),
          removedAt: null,
        },
      })
      .catch(() => undefined);

    // Un aumento di permessi dopo l'ingresso merita un avviso: è ciò che
    // succede quando qualcuno "risolve un problema" dando Administrator.
    if (previous && risk.score > previous.riskScore + 20) {
      await recordEvent(client, {
        guildId: guild.id,
        type: 'BOT_PERMISSION_RISK',
        targetId: bot.id,
        targetTag: bot.user.tag,
        severity: 70,
        automated: true,
        summary:
          `⚠️ I permessi del bot **${bot.user.tag}** sono aumentati: ` +
          `rischio da ${previous.riskScore} a ${risk.score}.\n${risk.details.join('\n')}`,
        payload: { before: previous.riskScore, after: risk.score, flags: risk.flags },
      });
    }
  }

  return { checked: bots.size, risky };
}
